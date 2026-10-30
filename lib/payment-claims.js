'use strict';
const crypto = require('node:crypto');

// Bank independent by design while checkout does not persist an immutable bank code.
// Conservative: two different providers with identical references are sent to manual
// review rather than allowing the same proof to be spent twice.
// Each claim stays in Firestore even if its lottery is subsequently deleted/cancelled.
function normalizePaymentReference(value) {
  return String(value || '').trim().replace(/\s+/g,'').toUpperCase();
}
function makePaymentClaimId(value) {
  const normalized = normalizePaymentReference(value);
  if (!normalized || normalized.length > 180) return null;
  return crypto.createHash('sha256').update('YOAS:LOTTERY:PAYMENT:v1:' + normalized).digest('hex');
}
function paymentClaimRef(db, value) {
  const id = makePaymentClaimId(value);
  return id ? db.collection('paymentClaims').doc(id) : null;
}
function claimSnapshotStatus(snap, requestId) {
  if (!snap || !snap.exists) return 'unused';
  return String(snap.data()?.requestId || '') === String(requestId || '')
    ? 'already_claimed_for_this_request' : 'used_by_another_request';
}
function assertClaimFree(status) {
  if (status !== 'unused') {
    throw Object.assign(new Error('This payment reference has already been used for an approved purchase. Do not approve again.'), {
      statusCode:409, code:'PAYMENT_REFERENCE_CLAIMED'
    });
  }
}
function createPaymentClaim(tx, ref, {requestId,lotteryId,createdBy,at}) {
  if (!ref) return false; // receipt-only purchase: separate manual review needed
  tx.create(ref, {
    requestId, lotteryId, claimedBy:createdBy, claimedAt:at,
    status:'consumed', retention:'keep_after_lottery_cleanup', version:1
  });
  return true;
}
module.exports = {normalizePaymentReference,makePaymentClaimId,paymentClaimRef,claimSnapshotStatus,assertClaimFree,createPaymentClaim};
