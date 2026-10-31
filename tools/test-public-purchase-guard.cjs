'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  LIMITS, WINDOW_MS, readVercelClientIp, assertReasonableBody,
  enforcePublicPurchaseLimit
} = require('../lib/public-purchase-guard');

const pepper = 'this-is-a-fixture-pepper-not-for-production-123456789';
const prod = { VERCEL_ENV: 'production', LOTTERY_PUBLIC_RATE_LIMIT_MODE: 'enforce',
  LOTTERY_PUBLIC_RATE_LIMIT_PEPPER: pepper };
const req = ip => ({ headers: { 'x-forwarded-for': ip } });

function fakeDb() {
  const items = new Map();
  const db = {
    items, calls: 0,
    collection(name) {
      assert.equal(name, 'publicPurchaseRateLimits');
      return { doc(id) { return { id }; } };
    },
    async runTransaction(fn) {
      db.calls++;
      const writes = [];
      const tx = {
        async get(ref) {
          return { exists: items.has(ref.id),
            data: () => items.get(ref.id) };
        },
        set(ref, data) { writes.push({ id: ref.id, data }); }
      };
      const result = await fn(tx);
      for (const w of writes) items.set(w.id, w.data);
      return result;
    }
  };
  return db;
}

test('disabled by default: no new database call or blocking on live checkouts', async () => {
  const res = await enforcePublicPurchaseLimit(req('not-an-ip'), 'submit',
    () => { throw new Error('must never be called'); }, {env: {VERCEL_ENV:'production'}});
  assert.deepEqual(res, { enforced: false });
  const preview = await enforcePublicPurchaseLimit(req('1.2.3.4'), 'submit',
    () => { throw new Error('preview must never be throttled'); },
    {env: {...prod, VERCEL_ENV:'preview'}});
  assert.deepEqual(preview, {enforced:false});
});

test('enforced checkout gets 15 successful requests per IP per minute, then 429', async () => {
  const db = fakeDb(), now = 123 * WINDOW_MS + 5000;
  for (let i=0;i<LIMITS.submit;i++) {
    assert.deepEqual(await enforcePublicPurchaseLimit(req('203.0.113.20'),'submit',()=>db,
      {env:prod,now}), {enforced:true});
  }
  await assert.rejects(() => enforcePublicPurchaseLimit(req('203.0.113.20'),
    'submit',()=>db,{env:prod,now}), e => {
      assert.equal(e.statusCode,429); assert.equal(e.retryAfterSeconds,55); return true;
    });
  assert.equal(db.items.size,1);
  const [id,value] = [...db.items.entries()][0];
  assert.match(id,/^[0-9a-f]{64}$/);
  assert.equal(value.count,LIMITS.submit);
  assert.ok(!JSON.stringify(value).includes('203.0.113.20'));
  assert.equal(value.expiresAt.getTime(),(125)*WINDOW_MS);
});

test('separate upload budget; each new fixed window resets', async () => {
  const db=fakeDb(), now=987*WINDOW_MS+40000;
  for (let i=0;i<LIMITS.upload;i++) {
    await enforcePublicPurchaseLimit(req('198.51.100.3'),'upload',()=>db,{env:prod,now});
  }
  await assert.rejects(() => enforcePublicPurchaseLimit(req('198.51.100.3'),
    'upload',()=>db,{env:prod,now}),{statusCode:429});
  await enforcePublicPurchaseLimit(req('198.51.100.3'),'submit',()=>db,{env:prod,now});
  await enforcePublicPurchaseLimit(req('198.51.100.3'),'upload',()=>db,
    {env:prod,now:now+WINDOW_MS});
  assert.equal(db.items.size,3);
});

test('malformed or multiple forwarded IPs and missing pepper fail closed', async () => {
  assert.equal(readVercelClientIp(req('127.0.0.1, 5.6.7.8')), null);
  assert.equal(readVercelClientIp(req('fake')), null);
  assert.equal(readVercelClientIp(req('2001:db8::1')),'2001:db8::1');
  const db=fakeDb();
  await assert.rejects(() => enforcePublicPurchaseLimit(req('8.8.8.8, 9.9.9.9'),
    'submit',()=>db,{env:prod}),{statusCode:503});
  await assert.rejects(() => enforcePublicPurchaseLimit(req('8.8.8.8'),
    'submit',()=>db,{env:{...prod,LOTTERY_PUBLIC_RATE_LIMIT_PEPPER:''}}),
    {statusCode:503});
  assert.equal(db.calls,0);
});

test('cheap input precheck stops oversized / invalid JSON before Firestore or upload', () => {
  assert.doesNotThrow(() => assertReasonableBody({headers:{}},{lotteryId:'L',name:'Y',
    phone:'0912345678', reference:'FT123456789', telegramInitData:'x'.repeat(1024)}));
  assert.throws(() => assertReasonableBody({headers:{}},[]), {statusCode:400});
  assert.throws(() => assertReasonableBody({headers:{}},
    {action:'authorize-receipt-upload', filler:'x'.repeat(17*1024)}),{statusCode:413});
  assert.throws(() => assertReasonableBody({headers:{'content-length':'20000'}},
    {action:'authorize-receipt-upload'}), {statusCode:413});
  assert.throws(() => assertReasonableBody({headers:{}},
    {telegramInitData:'x'.repeat(5000)}),{statusCode:400});
});
