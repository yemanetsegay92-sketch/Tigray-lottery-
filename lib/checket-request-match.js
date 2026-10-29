'use strict';

// Diagnostic matching only. No external calls or database mutations.
// A masked bank account cannot authenticate the complete receiving account.
function timeMs(value) {
  if (!value) return NaN;
  if (typeof value.toMillis === 'function') return value.toMillis();
  if (typeof value.seconds === 'number') return value.seconds * 1000;
  const number = Date.parse(String(value));
  return Number.isFinite(number) ? number : NaN;
}
function normReference(v) { return String(v || '').trim().toUpperCase(); }
function isCbeAccount(v) { return /^(cbe|commercial bank of ethiopia)$/i.test(String(v || '').trim()); }
function comparePaymentToRequest(request, provider, lottery, duplicate) {
  const requestedAmount = Number(request.total);
  const returnedAmount = Number(provider.amount);
  const amountMatch = Number.isFinite(requestedAmount) && requestedAmount > 0
    && provider.amount !== null && Number.isFinite(returnedAmount)
    && Math.round(requestedAmount * 100) === Math.round(returnedAmount * 100)
    && String(provider.currency || '').toUpperCase() === 'ETB';
  const expectedReference = normReference(request.reference);
  const reportedReference = normReference(provider.reportedTransactionNumber);
  const referenceMatch = reportedReference ? reportedReference === expectedReference : null;
  const createdAt = timeMs(request.createdAt);
  const paymentAt = timeMs(provider.transactionDate);
  let dateStatus = 'missing';
  if (Number.isFinite(createdAt) && Number.isFinite(paymentAt)) {
    const differenceHours = (paymentAt - createdAt) / 3600000;
    // Warning thresholds only, not a legal or bank settlement guarantee.
    dateStatus = paymentAt > Date.now() + 5 * 60 * 1000 ? 'future'
      : differenceHours < -24 ? 'older_than_request'
      : differenceHours > 72 ? 'later_than_request'
      : 'near_request';
  }
  const sameReferenceElsewhere = Number(duplicate.otherCount || 0);
  const duplicateUncertain = duplicate.truncated === true;
  const checks = {
    paymentConfirmed: provider.verified === true,
    amountMatch,
    accountStatus: provider.receiverAccountStatus || 'not_returned',
    dateStatus,
    referenceMatch,
    otherRequestsWithExactReference: sameReferenceElsewhere,
    duplicateSearchTruncated: duplicateUncertain,
    providerReportedDuplicate: provider.providerDuplicate === true,
    bankMethod: provider.verificationMethod || 'unknown'
  };
  const concerns = [];
  if (!checks.paymentConfirmed) concerns.push('Provider did not confirm payment.');
  if (!checks.amountMatch) concerns.push('Amount/currency differs or is missing.');
  if (checks.accountStatus !== 'exact_match') concerns.push('Full receiving account has not been proven to match.');
  if (checks.referenceMatch === false) concerns.push('Bank-reported reference differs from the request.');
  if (checks.referenceMatch === null) concerns.push('Provider did not return its own transaction reference.');
  if (checks.dateStatus !== 'near_request') concerns.push('Payment timing needs review: ' + checks.dateStatus + '.');
  if (checks.otherRequestsWithExactReference) concerns.push('Other ticket requests share this exact reference.');
  if (checks.duplicateSearchTruncated) concerns.push('Reference duplicate search was truncated.');
  if (checks.providerReportedDuplicate) concerns.push('Check.et reports a prior verification (not ticket usage).');
  if (!isCbeAccount('CBE') || provider.bank !== 'cbe') concerns.push('Only CBE is tested in this matching flow.');
  if (checks.bankMethod !== 'official') concerns.push('Provider verification method is not confirmed as official.');
  if (!lottery || !lottery.id || String(request.lotteryId) !== String(lottery.id)) {
    concerns.push('Lottery identity mismatch.');
  }
  return {
    // Even if no concerns: NEVER issue an approval or say this is proof of settlement.
    recommendation: concerns.length ? 'MANUAL_REVIEW' : 'MATCHED_FOR_REVIEW',
    checks, concerns,
    note: 'Read-only diagnostic. No ticket approval; database replay protection and authoritative account matching are required for automation.'
  };
}
module.exports = { comparePaymentToRequest, timeMs };
