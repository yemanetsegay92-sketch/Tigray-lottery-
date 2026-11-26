'use strict';
const {normalizePaymentReference, paymentClaimRef} = require('./payment-claims');
const {cbeAccounts} = require('./cbe-auto-eligibility');
const {reviewResult} = require('./cbe-verification-evidence');
const {manualCheckEtAllowed} = require('./checket-manual-gate');
const {enforceReadOnlyCheckEtBudget} = require('./checket-manual-budget');
const {verifyCheckEtPayment} = require('./checket-verify');
const {readFinalReceipt} = require('./checket-private-receipt');
const {extractReferenceFromReceipt} = require('./cbe-receipt-reference');

function fail(message, statusCode = 400) {
  throw Object.assign(new Error(message), {statusCode});
}

function reviewInput(body, approval = false) {
  const bank = body.bank;
  if (!['cbe','other'].includes(bank)) fail('Select CBE or Other.');
  const reference = normalizePaymentReference(body.correctedReference);
  if (!/^[A-Z0-9_-]{5,80}$/.test(reference)) fail('Enter the confirmed transaction reference (5–80 characters).');
  if (approval && body.paymentConfirmed !== true) fail('Confirm receipt of the payment before approving.');
  return {bank, reference};
}

function requirePending(purchase, lottery, lotteryId) {
  if (!purchase || purchase.lotteryId !== lotteryId || !lottery) fail('Purchase not found for this lottery.',404);
  if (purchase.status !== 'pending' || lottery.cleanupInProgress) fail('Payment review is closed.',409);
}

function checkRevision(purchase, revision) {
  if (revision !== (purchase.reviewRevision || 0)) fail('Payment review changed. Reopen it before continuing.',409);
}

// The audit entry doubles as the durable reservation. Retried POSTs from
// either tab carry the previous revision and cannot start another paid call.
async function reviewAction(db, caller, body, deps = {}) {
  if((deps.env||process.env).VERCEL_ENV!=='production')fail('Payment review is available only on the production dashboard.',403);
  const {requestId, lotteryId, action} = body;
  const requestRef = db.collection('ticketRequests').doc(requestId);
  const lotteryRef = db.collection('lotteries').doc(lotteryId);
  const queueRef = db.collection('autoPaymentQueue').doc(requestId);
  const [r,l,q] = await Promise.all([requestRef.get(),lotteryRef.get(),queueRef.get()]);
  const purchase = r.data(), lottery = l.data(), queue = q.data() || {};
  requirePending(purchase, lottery, lotteryId);
  if (action === 'review-details') {
    let ocr = purchase.receiptExtraction || null;
    // Earlier OCR may have marked a stamped CBE screenshot ambiguous. Try the
    // CBE first-candidate OCR once when an admin revisits that pending request.
    // This never contacts Check.et or changes a payment decision.
    const needsRecheck=ocr?.reason==='ambiguous_reference' &&
      ocr?.headerReferenceRechecked!==true;
    if ((!ocr || needsRecheck) && (purchase.proofPath || purchase.screenshotData)) {
      let file;
      if (purchase.proofPath) {
        try { file = await (deps.readReceipt || readFinalReceipt)(purchase); }
        catch { ocr = {ok:false,reason:'receipt_unavailable'}; }
      } else {
        // Legacy purchases can contain a small inline image. Never fetch a URL.
        const inline = String(purchase.screenshotData);
        const match = inline.length <= 1024*1024 && /^(?:data:image\/(?:png|jpeg|webp);base64,)?([A-Za-z0-9+/]+=*)$/.exec(inline);
        if (match) {
          const buffer = Buffer.from(match[1],'base64');
          const {validSignature} = require('./checket-private-receipt');
          const mime = ['image/png','image/jpeg','image/webp'].find(type=>validSignature(buffer,type));
          if (mime) file = {buffer,mime};
        }
        if (!file) ocr = {ok:false,reason:'receipt_unavailable'};
      }
      if (file) {
        ocr = await (deps.extract || extractReferenceFromReceipt)({
          ...file,
          // Automatic CBE mode already uses CBE OCR in its worker. Apply the
          // same context here even before the admin saves a bank correction.
          bank:purchase.paymentCorrection?.bank ||
            (cbeAccounts(lottery).length ? 'cbe' : undefined)
        });
        if (needsRecheck && ocr?.reason==='ambiguous_reference')
          ocr={...ocr,headerReferenceRechecked:true};
        await db.runTransaction(async tx => {
          const latest = (await tx.get(requestRef)).data();
          requirePending(latest, lottery, lotteryId);
          const current=latest.receiptExtraction;
          if (current && !(needsRecheck && current.reason==='ambiguous_reference' &&
              current.headerReferenceRechecked!==true)) ocr = current;
          else tx.update(requestRef,{receiptExtraction:ocr});
        });
      }
    }
    const events = await db.collection('auditLogs').where('requestId','==',requestId).get();
    const attempts = events.docs.map(doc => doc.data())
      .filter(e => e.action === 'manualPaymentVerification' && e.lotteryId === lotteryId)
      .sort((a,b) => a.revision-b.revision);
    const automatic = queue.verificationAttemptStartedAt || queue.checketDiagnostics || queue.verifiedEvidence
      ? {reference:queue.firstSubmittedReference || null,
        result:queue.firstCheckEtResult || queue.verifiedEvidence?.payment || queue.checketDiagnostics || null,
        state:queue.firstCheckEtState || queue.reasonCode || 'Outcome unavailable'} : null;
    return {ocr, automatic, attempts, revision:purchase.reviewRevision || 0, correction:purchase.paymentCorrection || null};
  }
  const correction = reviewInput(body);
  const claim = paymentClaimRef(db, correction.reference);
  if (action === 'review-duplicate') return {used:(await claim.get()).exists};
  const verify = action === 'review-verify';
  const verifyReceipt = verify && body.verifyReceipt === true;
  if (verify && (correction.bank !== 'cbe' || body.confirmCharge !== true || !manualCheckEtAllowed(deps.env)))
    fail('Explicit CBE verification is unavailable or was not confirmed.',403);
  if (verify && !/^FT[A-Z0-9]{8,30}$/.test(correction.reference)) fail('Enter a valid CBE FT reference.');
  const event = db.collection('auditLogs').doc();
  const context = await db.runTransaction(async tx => {
    const [current,lot,auto,ledger] = await Promise.all([tx.get(requestRef),tx.get(lotteryRef),tx.get(queueRef),tx.get(claim)]);
    const p = current.data();
    requirePending(p, lot.data(), lotteryId);
    checkRevision(p, body.revision);
    if (auto.data()?.state === 'processing') fail('Automatic verification is running. Refresh shortly.',409);
    if (verify && ledger.exists) fail('This reference has already been consumed.',409);
    let account;
    if (verify) {
      account = lot.data().paymentAccounts?.[body.accountIndex];
      if (!account || !cbeAccounts({paymentAccounts:[account]}).length) fail('Choose a configured CBE receiving account.');
      if (Number(p.reviewCallUntil) > Date.now()) fail('A verification is already running.',409);
      if (verifyReceipt && !p.proofPath) fail('No finalized receipt is attached to this purchase.',409);
    }
    const revision = body.revision + 1;
    const update = {paymentCorrection:correction,reviewRevision:revision};
    if (verify) update.reviewCallUntil = Date.now() + 60000;
    if (auto.data()?.state === 'pending') tx.update(queueRef,{state:'manual_review',reasonCode:'administrator_review'});
    tx.update(requestRef, update);
    tx.create(event,{action:verify?'manualPaymentVerification':'savePaymentCorrection',requestId,lotteryId,
      adminId:caller.uid,createdAt:new Date(),revision,...correction,
      ...(verify?{state:'reserved',inputMethod:verifyReceipt?'receipt':'reference',receivingSuffix:String(account.number).slice(-4)}:{})});
    return {account,revision,receipt:verifyReceipt?p:null};
  });
  if (!verify) return {revision:context.revision};
  let state = 'not_sent', result = null, message = '';
  try {
    message = 'Could not read the original receipt. Check.et was not called.';
    const proof = verifyReceipt
      ? {receiptFile:await (deps.readReceipt || readFinalReceipt)(context.receipt)}
      : {transactionNumber:correction.reference};
    message = 'Verification budget unavailable.';
    await (deps.budget || enforceReadOnlyCheckEtBudget)(db, caller.uid);
    state = 'uncertain';
    const provider = deps.verify || verifyCheckEtPayment;
    const response = await provider({bank:'cbe',...proof,
      accountNumber:context.account.number,expectedAmount:purchase.total,expectedReceiverName:context.account.holderName,purchaseCreatedAt:purchase.createdAt});
    result = reviewResult(response);
    state = 'returned';
    message = '';
    if (verifyReceipt && response.exists &&
        normalizePaymentReference(response.reportedTransactionNumber) !== correction.reference) {
      state = 'reference_mismatch';
      message = 'Check.et did not confirm the expected reference from the receipt. Review the original receipt before taking action.';
    }
  } catch (err) {
    if (state === 'uncertain') {
      message = 'Check.et outcome uncertain' + (err.providerHttpStatus ? ' (HTTP '+err.providerHttpStatus+')' : '') + '.';
    }
  }
  await db.runTransaction(async tx => {
    const current = (await tx.get(requestRef)).data();
    tx.update(event,{state,result,message,finishedAt:new Date()});
    if (current?.reviewRevision === context.revision) tx.update(requestRef,{reviewCallUntil:0});
  });
  return {revision:context.revision,state,result,message};
}
module.exports = {reviewInput,checkRevision,reviewAction};
