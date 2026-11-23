const {normalizePaymentReference,assertReferenceUnusedAtCheckout}=require('../../lib/payment-claims');
const crypto = require('crypto');
const {assertPurchaseEvidence,assertUploadAllowed}=require('../../lib/payment-evidence-mode');
const { getStorage } = require('firebase-admin/storage');
const { getAuth } = require('firebase-admin/auth');
const { BUCKET: PRIVATE_BUCKET, TYPES, POLICY_TTL_MS, FINISH_TTL_MS, signToken, receiptPath, verifyToken, validateStagedFile, sha256: proofHash } = require('./_receipt-upload');
const { adminDb, validateTelegramInitData, FieldValue } = require('../telegram/_lib');
const { usesAutomaticApproval } = require('../../lib/lottery-approval-mode');
const { assertReasonableBody, enforcePublicPurchaseLimit } = require('../../lib/public-purchase-guard');
const {registerCustomer,createDepositRequest,purchaseWithWallet,COMPANY_ID}=require('../../lib/wallet-core');

const BUCKET = 'tigiray-lottery.firebasestorage.app';

function normalizePhone(phone) {
  return String(phone || '').replace(/[^0-9+]/g, '').replace(/^\+251/, '0').trim();
}
function sha256(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function readBody(req) {
  if (!req.body) return {};
  if (typeof req.body === 'object' && !Buffer.isBuffer(req.body)) return req.body;
  try { return JSON.parse(Buffer.isBuffer(req.body) ? req.body.toString('utf8') : String(req.body)); }
  catch { throw Object.assign(new Error('Invalid request body.'), { statusCode: 400 }); }
}
function badRequest(message) {
  return Object.assign(new Error(message), { statusCode: 400 });
}
function readBearer(req){
  const value=String(req.headers?.authorization||'');
  return value.startsWith('Bearer ')?value.slice(7):'';
}
async function authenticateCustomer(req){
  const token=readBearer(req);
  if(!token)throw Object.assign(new Error('Sign in with a verified phone number.'),{statusCode:401});
  const auth=await getAuth().verifyIdToken(token);
  if(!auth.phone_number)throw Object.assign(new Error('A verified phone number is required.'),{statusCode:403});
  return {...auth,phone_number_verified:true};
}
async function handleWalletAction(req,res,body){
  const auth=await authenticateCustomer(req),db=adminDb();
  if(body.action==='wallet-register'){
    const result=await registerCustomer(db,{uid:auth.uid,auth,name:body.name});
    return res.status(200).json({ok:true,customer:result});
  }
  if(body.action==='wallet-summary'){
    const [profile,wallet,deposits,ledger]=await Promise.all([
      db.collection('customerProfiles').doc(auth.uid).get(),
      db.collection('walletAccounts').doc(COMPANY_ID+'_'+auth.uid).get(),
      db.collection('depositRequests').where('uid','==',auth.uid).limit(25).get(),
      db.collection('walletLedger').where('uid','==',auth.uid).limit(50).get()
    ]);
    if(!profile.exists)throw Object.assign(new Error('Register the customer wallet first.'),{statusCode:404});
    return res.status(200).json({ok:true,profile:{name:profile.data().name,phone:profile.data().phone},
      balanceSantim:Number(wallet.data()?.balanceSantim||0),
      deposits:deposits.docs.map(x=>({id:x.id,status:x.data().status,amountSantim:x.data().amountSantim,reference:x.data().reference})),
      ledger:ledger.docs.map(x=>({id:x.id,type:x.data().type,amountSantim:x.data().amountSantim,lotteryId:x.data().lotteryId||''}))});
  }
  if(body.action==='wallet-deposit'){
    const result=await createDepositRequest(db,{uid:auth.uid,auth,amountEtb:body.amountEtb,
      reference:body.reference,legalName:body.legalName});
    let automaticCredit=false,automaticReviewReasons=[];
    if(process.env.WALLET_AUTO_DEPOSITS_ENABLED==='true'){
      try{
        const account=String(process.env.CBE_WALLET_RECEIVING_ACCOUNT||'').replace(/\D/g,''),
          holderName=String(process.env.CBE_WALLET_RECEIVER_NAME||'');
        if(!/^\d{8,30}$/.test(account)||holderName.length<3)throw new Error('Wallet receiving account is not configured.');
        const provider=await require('../../lib/checket-verify').verifyCheckEtPayment({bank:'cbe',transactionNumber:body.reference,accountNumber:account});
        const deposit=(await db.collection('depositRequests').doc(result.depositId).get()).data();
        const assessment=require('../../lib/wallet-deposit-verification').assessAutomaticDeposit({deposit,provider,
          receiver:{account,holderName},providerReceiverAccountAssurance:process.env.CHECK_ET_CBE_RECEIVER_ASSURANCE==='authorized'});
        automaticReviewReasons=assessment.reasons;
        if(assessment.eligible){await require('../../lib/wallet-core').creditDeposit(db,{depositId:result.depositId,
          evidence:assessment.evidence,actorId:'system_auto_deposit',actorRole:'trustedAutoWorker'});automaticCredit=true;}
      }catch(error){automaticReviewReasons=['provider_unavailable_or_unverified'];console.error('wallet auto deposit held for review',{statusCode:error?.statusCode,code:error?.code});}
    }
    return res.status(automaticCredit?200:202).json({ok:true,...result,automaticCredit,automaticReviewReasons,
      message:automaticCredit?'Deposit verified and credited.':'Deposit submitted for verified ownership review.'});
  }
  if(body.action==='wallet-purchase'){
    const result=await purchaseWithWallet(db,{uid:auth.uid,lotteryId:String(body.lotteryId||''),
      requestKey:String(body.requestKey||''),quantity:Number(body.quantity)});
    return res.status(200).json({ok:true,...result});
  }
  throw badRequest('Unknown wallet action.');
}
// Same function handles authorization and checkout to fit Vercel Hobby's
// 12-serverless-functions deployment limit.
async function authorizeReceiptUpload(body, res) {
  const lotteryId = String(body.lotteryId || '').trim();
  const mime = String(body.mime || '').toLowerCase().trim();
  const size = Number(body.bytes);
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(lotteryId)) throw badRequest('Invalid lottery ID.');
  if (!TYPES[mime]) throw badRequest('Choose a JPG, PNG, WebP or PDF receipt.');
  if (!Number.isInteger(size) || size < 1 || size > TYPES[mime].max) {
    throw badRequest('Receipt is too large. Images: 420 KB maximum; PDF: 2 MB maximum.');
  }
  const db = adminDb();
  const snap = await db.collection('lotteries').doc(lotteryId).get();
  if (!snap.exists || snap.data()?.status !== 'active') throw badRequest('Lottery is not open.');
  assertUploadAllowed(snap.data());
  const session = crypto.randomBytes(16).toString('hex');
  const path = receiptPath(lotteryId, session, TYPES[mime].ext);
  const [policy] = await getStorage().bucket(PRIVATE_BUCKET).file(path).generateSignedPostPolicyV4({
    expires: Date.now() + POLICY_TTL_MS,
    fields: {
      'Content-Type': mime,
      'success_action_status': '204',
      'x-goog-meta-proofsession': session
    },
    conditions: [
      // Small allowance for multipart boundary/metadata. Stored object strictly
      // checked against 420 KB / 2 MB maximum on finalize.
      ['content-length-range', 1, TYPES[mime].max + 64 * 1024],
      ['eq', '$Content-Type', mime],
      ['eq', '$x-goog-meta-proofsession', session]
    ]
  });
  const proofUploadToken = signToken({
    v: 1, lotteryId, mime, session, path, exp: Date.now() + FINISH_TTL_MS
  });
  return res.status(200).json({
    ok: true, uploadUrl: policy.url, fields: policy.fields,
    proofUploadToken, expiresInSeconds: POLICY_TTL_MS / 1000
  });
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Method not allowed.' });
  try {
    const body = readBody(req);
    res.setHeader('Cache-Control','no-store');
    assertReasonableBody(req, body);
    if(String(body.action||'').startsWith('wallet-'))return await handleWalletAction(req,res,body);
    if (body.action === 'authorize-receipt-upload') {
      await enforcePublicPurchaseLimit(req, 'upload', adminDb);
      return await authorizeReceiptUpload(body, res);
    }
    const lotteryId = String(body.lotteryId || '').trim();
    const name = String(body.name || '').trim();
    const phone = normalizePhone(body.phone);
    const reference = String(body.reference || '').trim();
    const quantity = Number(body.quantity || 1);
    if (body.paymentProofData) throw badRequest('Receipt upload has changed. Please refresh the checkout page.');
    const proof = body.proofUploadToken ? verifyToken(body.proofUploadToken, lotteryId) : null;
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 5) {
      throw badRequest('You can request a maximum of 5 tickets per purchase.');
    }
    if (!lotteryId || !name || !phone || name.length > 150 || phone.length > 24) {
      throw badRequest('Please complete the required fields.');
    }
    if (reference.length > 180) throw badRequest('Transaction reference is too long.');
    if (!reference && !proof) throw badRequest('Enter a transaction reference OR upload a receipt.');
    const telegramInitData = String(body.telegramInitData || '');
    let telegramUser = null;
    if (telegramInitData) telegramUser = validateTelegramInitData(telegramInitData).user;

    await enforcePublicPurchaseLimit(req, 'submit', adminDb);
    const db = adminDb();
    const lotterySnap = await db.collection('lotteries').doc(lotteryId).get();
    if (!lotterySnap.exists) return res.status(404).json({ ok: false, error: 'Lottery not found.' });
    const lottery = lotterySnap.data();
    if (lottery.status !== 'active') throw badRequest('This lottery is not currently open.');
    assertPurchaseEvidence(lottery,reference,proof);
    const price = Number(lottery.price || 0);
    if (!Number.isFinite(price) || price <= 0) throw badRequest('Lottery price is not configured correctly.');
    const total = price * quantity;
    // Fast reject before any receipt work; the acceptance transaction repeats this read.
    // Validate a private GCS object with metadata and small byte-range reads.
    // Browser uploads bypass Vercel; bounded finalized bytes are read server-side for OCR.
    const bucket = proof ? getStorage().bucket(BUCKET) : null;
    const staged = proof ? await validateStagedFile(bucket, proof) : null;
    try{await db.runTransaction(tx=>assertReferenceUnusedAtCheckout(tx,db,reference));}
    catch(error){
      if(staged)await staged.file.delete({ignoreNotFound:true,ifGenerationMatch:staged.generation}).catch(()=>{});
      throw error;
    }
    // Reference-based duplicate detection is unchanged. Proof-only duplicates
    // use GCS MD5 if present, otherwise the per-upload random session ID.
    const requestId = reference
      ? sha256('REF:' + reference.toUpperCase()).slice(0, 40)
      : sha256('PROOF:' + (staged.md5 || proof.session)).slice(0, 40);
    const proofUploadToken = crypto.randomBytes(32).toString('hex');
    // Short, single-use secret for a Telegram deep link (64-character start-parameter limit).
    const buyerLinkToken = crypto.randomBytes(10).toString('hex');
    const requestRef = db.collection('ticketRequests').doc(requestId);
    const phoneHash = sha256(phone);
    const publicRef = db.collection('publicStatus').doc(phoneHash).collection('requests').doc(requestId);
    const requestData = {
      lotteryId, lotteryName: String(lottery.name || lotteryId), name, phone, reference,
      quantity, price, total, status: 'pending', ticketNumbers: [],
      phoneHash, proofUploadTokenHash: sha256(proofUploadToken),
      buyerLinkTokenHash: sha256(buyerLinkToken),
      createdAt: FieldValue.serverTimestamp()
    };
    if (telegramUser) {
      requestData.telegramChatId = String(telegramUser.id);
      requestData.telegramUserId = String(telegramUser.id);
      requestData.telegramUsername = String(telegramUser.username || '');
      requestData.telegramFirstName = String(telegramUser.first_name || '');
    }
    let file = null;
    let uploadClaimRef = null;
    if (proof) {
      // Signed upload grants access only to /incoming/. Copy the verified
      // object to an unguessable, *unwritable* final path before committing.
      // A second POST using the same temporary signed policy cannot modify
      // an approved admin receipt.
      const finalPath = 'payment-proofs/' + encodeURIComponent(lotteryId) + '/' +
        requestId + '-' + proof.session + '.' + (proof.mime === 'application/pdf' ? 'pdf' :
          proof.mime === 'image/png' ? 'png' : proof.mime === 'image/webp' ? 'webp' : 'jpg');
      file = bucket.file(finalPath);
      try {
        await staged.file.copy(file, { preconditionOpts: { ifGenerationMatch: 0 } });
      } catch (error) {
        if (error.code === 412) throw badRequest('This receipt was already submitted. Please choose it again.');
        throw error;
      }
      // Deleting staged bytes frees storage. The finalized copy is never
      // authorized by the client's temporary signed upload policy.
      try { await staged.file.delete({ ignoreNotFound: true, ifGenerationMatch: staged.generation }); }
      catch (error) { console.error('staged proof cleanup failed:', error); }
      Object.assign(requestData, {
        proofPath: finalPath,
        proofMime: proof.mime,
        proofBytes: staged.bytes,
        proofOriginalBytes: Number(body.paymentProofOriginalBytes) || staged.bytes,
        proofMd5: staged.md5,
        proofUploadedAt: FieldValue.serverTimestamp()
      });
      uploadClaimRef = db.collection('receiptUploadClaims').doc(proofHash(proof.session));
    }
    try {
      let receiptExtraction=null;
      if(proof && process.env.LOTTERY_CBE_RECEIPT_OCR_ENABLED==='true' && require('../../lib/cbe-auto-eligibility').cbeAccounts(lottery).length){
        const receipt=await require('../../lib/checket-private-receipt').readFinalReceipt(requestData);
        receiptExtraction=await require('../../lib/cbe-receipt-reference').extractReferenceFromReceipt({...receipt,bank:'cbe'});
        requestData.receiptExtraction=receiptExtraction;
      }
      requestData.originalCustomerReference=reference;
      await db.runTransaction(async tx => {
        await assertReferenceUnusedAtCheckout(tx,db,normalizePaymentReference(reference));
        if(receiptExtraction?.ok)await assertReferenceUnusedAtCheckout(tx,db,receiptExtraction.reference);
        const [existing, currentLottery, activationSnap] = await Promise.all([
          tx.get(requestRef), tx.get(db.collection('lotteries').doc(lotteryId)),
          tx.get(require('../../lib/cbe-auto-activation').activationRef(db,lotteryId))
        ]);
        if (!currentLottery.exists || currentLottery.data().status !== 'active' ||
            currentLottery.data().cleanupInProgress === true) {
          throw badRequest('This lottery is closed or being removed. No new purchases are accepted.');
        }
        if (existing.exists) throw new Error('DUPLICATE_REFERENCE');
        if (uploadClaimRef) tx.create(uploadClaimRef, {
          requestId, lotteryId, createdAt: FieldValue.serverTimestamp()
        });
        tx.create(requestRef, requestData);
        // Queue only with matching server-owned CBE activation and the
        // global emergency shutdown still enabled. Preview never queues.
        const {enabledFor}=require('../../lib/cbe-auto-activation');
        const {cbeAccounts}=require('../../lib/cbe-auto-eligibility');
        const cbe=cbeAccounts(currentLottery.data());
        if(usesAutomaticApproval(currentLottery.data()) &&
          enabledFor(currentLottery.data(),activationSnap.exists?activationSnap.data():null) && cbe.length===1 &&
          String(cbe[0].holderName||'').trim()) {
          tx.create(db.collection('autoPaymentQueue').doc(requestId),{
            lotteryId,requestId,state:'pending',attempts:0,
            nextAttemptAt:FieldValue.serverTimestamp(),
            createdAt:FieldValue.serverTimestamp()
          });
        }
        tx.create(publicRef, {
          lotteryId, lotteryName: String(lottery.name || lotteryId),
          phoneLast4: phone.slice(-4), quantity, total, status: 'pending',
          ticketNumbers: [], createdAt: FieldValue.serverTimestamp()
        });
      });
    } catch (error) {
      if (file) { try { await file.delete({ ignoreNotFound: true }); } catch (cleanupError) { console.error('proof cleanup failed', cleanupError); } }
      throw error;
    }
    return res.status(200).json({ ok: true, created: true, requestId, total, proofUploadToken, buyerLinkToken });
  } catch (error) {
    if (error?.message === 'DUPLICATE_REFERENCE' || error?.code === 6 || error?.code === 'already-exists') {
      return res.status(409).json({ ok: false, error: 'This payment reference or receipt has already been submitted.' });
    }
    if (Number(error?.statusCode) === 429) {
      res.setHeader('Retry-After', String(error.retryAfterSeconds || 60));
    }
    if (Number(error?.statusCode) >= 400 && Number(error?.statusCode) < 500) return res.status(error.statusCode).json({ ok: false, error: error.message });
    if (Number(error?.statusCode) === 503) return res.status(503).json({ ok: false, error: error.message });
    console.error('create-request error:', error);
    return res.status(500).json({ ok: false, error: 'Could not submit request. Please try again.' });
  }
};
