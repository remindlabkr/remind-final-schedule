/**
 * 리마인드 논술 수강신청 — 통합 서버
 * ------------------------------------------------------------------
 * 이 서버 하나가 4가지를 합니다.
 *   1) 수강신청 사이트(index.html)를 웹에 띄움
 *   2) 공용 저장소 /api/kv → 학생 신청이 선생님 관리자 화면에 모임 (Upstash Redis)
 *   3) 카카오 알림톡 (솔라피)
 *        - 신청확정 카톡: 학생이 신청하면 즉시 발송
 *        - 수업 1시간 전 알림톡: /api/cron 이 호출될 때마다 검사 후 자동 발송
 *   4) 결제선생 연동 /api/payssam (키가 있을 때만 동작)
 *
 * 실행: npm install → node server.js
 *
 * ── 환경변수 ─────────────────────────────────────────────
 *  [필수: 저장]
 *   UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN
 *
 *  [알림톡: 솔라피]
 *   SOLAPI_API_KEY, SOLAPI_API_SECRET
 *   SOLAPI_PFID          카카오 채널 발신프로필 ID
 *   SOLAPI_TPL_CONFIRM   '신청확정' 템플릿 ID
 *   SOLAPI_TPL_REMIND    '수업 1시간 전' 템플릿 ID
 *   SOLAPI_SENDER        솔라피에 등록한 발신번호 (알림톡 실패 시 문자로 대체 발송)
 *   CRON_SECRET          (선택) /api/cron 보호용 비밀값
 *
 *  [결제선생] PAYSSAM_API_KEY 등 — 없으면 결제 자동발송만 꺼짐
 */

const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const path = require('path');

let SolapiMessageService = null;
try { ({ SolapiMessageService } = require('solapi')); } catch (e) { /* 미설치 시 알림톡만 비활성 */ }

const {
  UPSTASH_REDIS_REST_URL = '',
  UPSTASH_REDIS_REST_TOKEN = '',
  SOLAPI_API_KEY = '', SOLAPI_API_SECRET = '', SOLAPI_PFID = '',
  SOLAPI_TPL_CONFIRM = '', SOLAPI_TPL_REMIND = '', SOLAPI_SENDER = '',
  CRON_SECRET = '',
  PAYSSAM_API_KEY = '',
  PAYSSAM_MERCHANT = 'remind-nonsul',
  PAYSSAM_MEMBER = '',            // 샌드박스 Test Member ID (없으면 학생 코드/merchant 사용)
  PAYSSAM_SEND_TYPE = 'TALK',     // TALK=카톡 결제톡 발송(포인트 차감) / URL=링크만 반환(포인트 X, 테스트용)
  PAYSSAM_BILL_ISSUER = '리마인드 논술',
  PAYSSAM_BASE = 'https://sandbox.paymint.co.kr/partner',
  PAYSSAM_CALLBACK_URL = '',
  HASH_ALGO = 'sha256',
  PORT = 3000,
} = process.env;

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));

// ================== 공용 저장소 ==================
const memStore = new Map();
const useRedis = !!(UPSTASH_REDIS_REST_URL && UPSTASH_REDIS_REST_TOKEN);

async function redis(cmd) {
  const r = await fetch(UPSTASH_REDIS_REST_URL, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + UPSTASH_REDIS_REST_TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmd),
  });
  return r.json();
}
async function kvGet(key) {
  if (useRedis) { const j = await redis(['GET', key]); return j.result ?? null; }
  return memStore.has(key) ? memStore.get(key) : null;
}
async function kvSet(key, value) {
  if (useRedis) { await redis(['SET', key, String(value)]); return; }
  memStore.set(key, String(value));
}
const parse = (raw, fb) => { try { return raw != null ? JSON.parse(raw) : fb; } catch (e) { return fb; } };

app.get('/api/kv/:key', async (req, res) => {
  try { res.json({ value: await kvGet(req.params.key) }); }
  catch (e) { console.error('kv get', e); res.status(500).json({ value: null }); }
});
app.post('/api/kv/:key', async (req, res) => {
  try { await kvSet(req.params.key, req.body?.value ?? ''); res.json({ ok: true }); }
  catch (e) { console.error('kv set', e); res.status(500).json({ ok: false }); }
});

// ================== 카카오 알림톡 (솔라피) ==================
const solapiReady = !!(SolapiMessageService && SOLAPI_API_KEY && SOLAPI_API_SECRET && SOLAPI_PFID);
const onlyNum = (s) => String(s || '').replace(/[^0-9]/g, '');

async function sendAlimtalk({ to, templateId, variables, fallbackText }) {
  if (!solapiReady || !templateId) return { skipped: true };
  const ms = new SolapiMessageService(SOLAPI_API_KEY, SOLAPI_API_SECRET);
  return ms.send({
    to: onlyNum(to),
    from: onlyNum(SOLAPI_SENDER),
    text: fallbackText,                    // 알림톡 실패 시 문자로 대체 발송
    kakaoOptions: { pfId: SOLAPI_PFID, templateId, variables },
  });
}

// --- 신청확정 카톡 (학생이 신청하는 즉시) ---
app.post('/api/notify-student', async (req, res) => {
  const { name, phone, items = [], total = 0, payMethod = '' } = req.body || {};
  if (!solapiReady || !SOLAPI_TPL_CONFIRM) return res.json({ skipped: true, reason: '솔라피 미설정' });
  if (!phone || !name) return res.status(400).json({ ok: false, message: '이름/번호 없음' });
  try {
    const list = items.length ? items.map((s) => `· ${s}`).join('\n') : '수강신청';
    const won = Number(total || 0).toLocaleString('ko-KR');
    await sendAlimtalk({
      to: phone,
      templateId: SOLAPI_TPL_CONFIRM,
      variables: { '#{이름}': name, '#{신청내역}': list, '#{금액}': won, '#{결제방법}': payMethod || '-' },
      fallbackText: `[리마인드 논술] ${name}님, 수강신청이 완료되었습니다.\n${list}\n결제금액: ${won}원`,
    });
    console.log('confirm sent:', name, phone);
    res.json({ ok: true });
  } catch (e) {
    console.error('confirm error', e?.message || e);
    res.status(500).json({ ok: false, message: String(e?.message || e) });
  }
});

// --- 수업 1시간 전 알림톡 (외부 크론이 주기적으로 호출) ---
const pad = (n) => String(n).padStart(2, '0');
// KST 기준 연/월 구하기
function kstYM(ms) {
  const d = new Date(ms + 9 * 3600 * 1000);
  return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1 };
}
function classStartMs(dateStr, timeStr) {
  if (!dateStr || !timeStr) return null;
  const t = Date.parse(`${dateStr}T${timeStr}:00+09:00`); // 한국시간 기준
  return Number.isNaN(t) ? null : t;
}

async function runReminders() {
  const now = Date.now();
  const months = [kstYM(now), kstYM(now + 24 * 3600 * 1000)]; // 월말 넘어가는 경우 대비
  const seen = new Set();
  let sent = 0, checked = 0;

  for (const { y, m } of months) {
    const tag = `${y}-${pad(m)}`;
    if (seen.has(tag)) continue;
    seen.add(tag);

    const regs = parse(await kvGet(`r15-reg-${tag}`), []) || [];
    const clsList = parse(await kvGet(`r15-cls-${tag}`), []) || [];

    for (const reg of regs) {
      for (const rc of (reg.classes || [])) {
        checked++;
        // 최신 수업 정보(시간 수정 반영)를 우선 사용
        const live = clsList.find((c) => c.id === rc.id) || rc;
        const start = classStartMs(live.date, live.time);
        if (!start) continue;                       // 시간 미설정 → 건너뜀
        const diff = start - now;
        if (diff < 40 * 60000 || diff > 80 * 60000) continue;  // 40~80분 전 구간에서만

        const dedupe = `r15-rsent-${reg.id}-${rc.id}`;
        if (await kvGet(dedupe)) continue;          // 이미 보냄

        const nm = `${live.name}${live.session ? ` ${live.session}회차` : ''}`;
        try {
          await sendAlimtalk({
            to: reg.phone,
            templateId: SOLAPI_TPL_REMIND,
            variables: { '#{이름}': reg.studentName || '', '#{수업명}': nm, '#{시간}': live.time || '' },
            fallbackText: `[리마인드 논술] ${reg.studentName}님, 1시간 뒤 «${nm}» 수업이 시작해요! (${live.time})`,
          });
          await kvSet(dedupe, '1');
          sent++;
          console.log('remind sent:', reg.studentName, nm, live.time);
        } catch (e) {
          console.error('remind error', reg.studentName, e?.message || e);
        }
      }
    }
  }
  return { checked, sent };
}

// 크론이 이 주소를 주기적으로(10분마다) 호출하면 됩니다. (서버 깨우는 역할도 겸함)
async function cronHandler(req, res) {
  if (CRON_SECRET && req.query.key !== CRON_SECRET) return res.status(403).json({ ok: false });
  if (!solapiReady || !SOLAPI_TPL_REMIND) return res.json({ ok: true, skipped: '솔라피 미설정' });
  try { res.json({ ok: true, ...(await runReminders()) }); }
  catch (e) { console.error('cron error', e); res.status(500).json({ ok: false, message: String(e?.message || e) }); }
}
app.get('/api/cron', cronHandler);
app.post('/api/cron', cronHandler);

// ================== 결제선생 ==================
const approvals = new Map();
function makeHash({ billId, phone, price }) {
  const base = phone ? `${billId},${phone},${price}` : `${billId},${price}`;
  return crypto.createHash(HASH_ALGO).update(base, 'utf8').digest('hex');
}
async function callPayssam(p, body) {
  const r = await fetch(`${PAYSSAM_BASE}${p}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json; charset=UTF-8' }, body: JSON.stringify(body),
  });
  let data = {}; try { data = await r.json(); } catch (e) {}
  return { httpOk: r.ok, status: r.status, data };
}

app.post('/api/payssam', async (req, res) => {
  const { action } = req.body || {};
  if (!PAYSSAM_API_KEY) return res.status(500).json({ code: 'NO_KEY', message: '결제선생 키 미설정' });
  try {
    if (action === 'send') {
      const { billId, memberName, phone, price, productName, memberCode, expireDt } = req.body;
      if (!billId || !phone || !price || !memberName || !productName)
        return res.status(400).json({ code: 'BAD_REQ', message: '필수값 누락' });
      const hash = makeHash({ billId, phone, price });
      const callbackUrl = PAYSSAM_CALLBACK_URL || `${req.protocol}://${req.get('host')}/api/payssam/callback`;
      const r = await callPayssam('/bill', {
        apiKey: PAYSSAM_API_KEY, member: PAYSSAM_MEMBER || memberCode || PAYSSAM_MERCHANT, merchant: PAYSSAM_MERCHANT,
        bill: { billId, sendType: (PAYSSAM_SEND_TYPE || 'TALK'), billIssuer: PAYSSAM_BILL_ISSUER, productName, price: String(price), memberName, phone, hash, callbackUrl, ...(expireDt ? { expireDt } : {}) },
      });
      const d = r.data || {};
      return res.status(r.httpOk ? 200 : r.status).json({ code: d.code, message: d.msg || d.message, shortUrl: d.data?.shortUrl || d.shortUrl, billId });
    }
    if (action === 'resend') {
      const { billId } = req.body;
      const r = await callPayssam('/bill/resend', { apiKey: PAYSSAM_API_KEY, member: PAYSSAM_MEMBER || PAYSSAM_MERCHANT, merchant: PAYSSAM_MERCHANT, bill: { billId } });
      return res.status(r.httpOk ? 200 : r.status).json({ code: r.data?.code, message: r.data?.msg || r.data?.message, billId });
    }
    if (action === 'destroy') {
      const { billId, price } = req.body;
      const hash = makeHash({ billId, price });
      const r = await callPayssam('/bill/destroy', { apiKey: PAYSSAM_API_KEY, member: PAYSSAM_MEMBER || PAYSSAM_MERCHANT, merchant: PAYSSAM_MERCHANT, bill: { billId, price: String(price), hash } });
      if (r.httpOk && r.data?.code === '0000') approvals.set(billId, { apprState: 'D', billId });
      return res.status(r.httpOk ? 200 : r.status).json({ code: r.data?.code, message: r.data?.msg || r.data?.message, billId });
    }
    if (action === 'status') {
      const { billId } = req.body;
      const a = approvals.get(billId);
      return res.json(a ? { code: '0000', ...a } : { code: '0000', apprState: null, billId });
    }
    return res.status(400).json({ code: 'BAD_ACTION', message: `알 수 없는 action: ${action}` });
  } catch (e) {
    console.error('payssam error', e);
    return res.status(500).json({ code: 'PROXY_ERR', message: String(e?.message || e) });
  }
});

app.post('/api/payssam/callback', (req, res) => {
  const p = req.body || {};
  if (p.billId) approvals.set(p.billId, p);
  console.log('payssam callback:', p.billId, p.apprState);
  res.json({ code: '0000' });
});

// ================== 사이트 서빙 ==================
// 항상 최신 화면을 주도록 캐시 끔 (브라우저가 옛날 페이지 붙잡고 있는 문제 방지)
app.get('*', (_req, res) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`server on :${PORT}  storage=${useRedis ? 'Upstash' : '임시메모리'}  알림톡=${solapiReady ? 'ON' : 'OFF'}  결제선생=${PAYSSAM_API_KEY ? 'ON' : 'OFF'}`);
});
