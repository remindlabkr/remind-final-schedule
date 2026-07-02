/**
 * 리마인드 논술 수강신청 — 통합 서버
 * ------------------------------------------------------------------
 * 이 서버 하나가 3가지를 합니다.
 *   1) 수강신청 사이트(public/index.html)를 웹에 띄움
 *   2) 공용 저장소 /api/kv  → 학생 신청이 선생님 관리자 화면에 모이게 함 (Upstash Redis)
 *   3) 결제선생 연동 /api/payssam (결제선생 API 키가 있을 때만 동작)
 *
 * 실행: npm install → node server.js
 * 배포: Render 같은 무료 호스팅. 자세한 순서는 "웹배포-클릭가이드.md" 참고.
 *
 * 환경변수
 *   UPSTASH_REDIS_REST_URL   ★ 공용 저장용 (무료 Upstash에서 발급) — 없으면 임시 메모리(재시작 시 사라짐)
 *   UPSTASH_REDIS_REST_TOKEN ★ 위와 세트
 *   PAYSSAM_API_KEY          결제선생 키 (계약 후. 없으면 결제 자동발송만 비활성, 저장/사이트는 정상)
 *   PAYSSAM_MERCHANT, PAYSSAM_BILL_ISSUER, PAYSSAM_BASE, PAYSSAM_CALLBACK_URL, HASH_ALGO
 *   ADMIN_KV_TOKEN           (선택) /api/kv 쓰기 보호용. 지금은 미사용.
 */

const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const path = require('path');

const {
  UPSTASH_REDIS_REST_URL = '',
  UPSTASH_REDIS_REST_TOKEN = '',
  PAYSSAM_API_KEY = '',
  PAYSSAM_MERCHANT = 'remind-nonsul',
  PAYSSAM_BILL_ISSUER = '리마인드 논술',
  PAYSSAM_BASE = 'https://sandbox.paymint.co.kr/partner',
  PAYSSAM_CALLBACK_URL = '',
  HASH_ALGO = 'sha256',
  PORT = 3000,
} = process.env;

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));

// ================== 공용 저장소 (Upstash Redis REST) ==================
const memStore = new Map(); // Upstash 미설정 시 임시 대체 (재시작 시 사라짐)
const useRedis = !!(UPSTASH_REDIS_REST_URL && UPSTASH_REDIS_REST_TOKEN);

async function redis(cmd) {
  const r = await fetch(UPSTASH_REDIS_REST_URL, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + UPSTASH_REDIS_REST_TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmd),
  });
  return r.json(); // { result: ... }
}

// 저장 읽기
app.get('/api/kv/:key', async (req, res) => {
  const key = req.params.key;
  try {
    if (useRedis) {
      const j = await redis(['GET', key]);
      return res.json({ value: j.result ?? null });
    }
    return res.json({ value: memStore.has(key) ? memStore.get(key) : null });
  } catch (e) {
    console.error('kv get error', e);
    return res.status(500).json({ value: null });
  }
});

// 저장 쓰기
app.post('/api/kv/:key', async (req, res) => {
  const key = req.params.key;
  const value = req.body && req.body.value != null ? String(req.body.value) : '';
  try {
    if (useRedis) {
      await redis(['SET', key, value]);
    } else {
      memStore.set(key, value);
    }
    return res.json({ ok: true });
  } catch (e) {
    console.error('kv set error', e);
    return res.status(500).json({ ok: false });
  }
});

// ================== 결제선생 프록시 ==================
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
  if (!PAYSSAM_API_KEY) return res.status(500).json({ code: 'NO_KEY', message: '결제선생 키 미설정 (계약/검수 후 발급된 키를 넣어주세요)' });
  try {
    if (action === 'send') {
      const { billId, memberName, phone, price, productName, memberCode, expireDt } = req.body;
      if (!billId || !phone || !price || !memberName || !productName)
        return res.status(400).json({ code: 'BAD_REQ', message: '필수값 누락' });
      const hash = makeHash({ billId, phone, price });
      const callbackUrl = PAYSSAM_CALLBACK_URL || `${req.protocol}://${req.get('host')}/api/payssam/callback`;
      const r = await callPayssam('/bill', {
        apiKey: PAYSSAM_API_KEY, member: memberCode || PAYSSAM_MERCHANT, merchant: PAYSSAM_MERCHANT,
        bill: { billId, sendType: 'TALK', billIssuer: PAYSSAM_BILL_ISSUER, productName, price: String(price), memberName, phone, hash, callbackUrl, ...(expireDt ? { expireDt } : {}) },
      });
      const d = r.data || {};
      return res.status(r.httpOk ? 200 : r.status).json({ code: d.code, message: d.msg || d.message, shortUrl: d.data?.shortUrl || d.shortUrl, billId });
    }
    if (action === 'resend') {
      const { billId } = req.body;
      const r = await callPayssam('/bill/resend', { apiKey: PAYSSAM_API_KEY, member: PAYSSAM_MERCHANT, merchant: PAYSSAM_MERCHANT, bill: { billId } });
      return res.status(r.httpOk ? 200 : r.status).json({ code: r.data?.code, message: r.data?.msg || r.data?.message, billId });
    }
    if (action === 'destroy') {
      const { billId, price } = req.body;
      const hash = makeHash({ billId, price });
      const r = await callPayssam('/bill/destroy', { apiKey: PAYSSAM_API_KEY, member: PAYSSAM_MERCHANT, merchant: PAYSSAM_MERCHANT, bill: { billId, price: String(price), hash } });
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
    return res.status(500).json({ code: 'PROXY_ERR', message: String(e.message || e) });
  }
});

app.post('/api/payssam/callback', (req, res) => {
  const p = req.body || {};
  if (p.billId) approvals.set(p.billId, p);
  console.log('callback:', p.billId, p.apprState, p.apprPrice);
  res.json({ code: '0000' });
});

// ================== 사이트 서빙 ==================
app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, () => {
  console.log(`server on :${PORT}  storage=${useRedis ? 'Upstash' : '임시메모리(주의: 재시작 시 사라짐)'}  payssam=${PAYSSAM_API_KEY ? 'ON' : 'OFF'}`);
});
