'use strict';

// Allows a clean production launch without migrating old *test-only* receipts.
// Date must have a timezone or 'Z'. This makes the cutover unambiguous.
function cutoverMs(env=process.env) {
  const raw=String(env.LOTTERY_CBE_AUTO_APPROVAL_START_AT||'').trim();
  if(!/^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d{1,3})?)?(?:Z|[+-]\d\d:\d\d)$/.test(raw))return NaN;
  const value=Date.parse(raw);
  return Number.isFinite(value)?value:NaN;
}
function timeMs(value){
  if(!value)return NaN;
  if(typeof value.toMillis==='function')return value.toMillis();
  if(typeof value.seconds==='number')return value.seconds*1000;
  const v=Date.parse(String(value));
  return Number.isFinite(v)?v:NaN;
}
function isAfterCutover(purchaseCreatedAt,bankPaidAt,env=process.env){
  const cutoff=cutoverMs(env);
  return Number.isFinite(cutoff) &&
    Number.isFinite(timeMs(purchaseCreatedAt)) &&
    Number.isFinite(timeMs(bankPaidAt)) &&
    timeMs(purchaseCreatedAt)>=cutoff && timeMs(bankPaidAt)>=cutoff;
}
module.exports={cutoverMs,timeMs,isAfterCutover};
