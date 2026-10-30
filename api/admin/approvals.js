const crypto = require('crypto');
const { adminDb, FieldValue } = require('../telegram/_lib');
const { getAuth } = require('firebase-admin/auth');
const { getStorage } = require('firebase-admin/storage');
const { paymentClaimRef, normalizePaymentReference, claimSnapshotStatus, assertClaimFree, createPaymentClaim } = require('../../lib/payment-claims');

function readBearer(req) {
  const h = String(req.headers?.authorization || '');
  return h.startsWith('Bearer ') ? h.slice(7) : '';
}

function readBody(req) {
  if (!req.body) return {};
  if (typeof req.body === 'object' && !Buffer.isBuffer(req.body)) return req.body;
  try {
    return JSON.parse(Buffer.isBuffer(req.body) ? req.body.toString('utf8') : String(req.body));
  } catch {
    throw new Error('Invalid request body.');
  }
}

function normalizePhone(phone) {
  return String(phone || '').replace(/[^0-9+]/g, '').replace(/^\+251/, '0').trim();
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

async function authenticateAdmin(req, db) {
  const token = readBearer(req);
  if (!token) throw Object.assign(new Error('Missing Firebase ID token.'), { statusCode: 401 });

  const caller = await getAuth().verifyIdToken(token);
  const callerSnap = await db.collection('users').doc(caller.uid).get();

  if (!callerSnap.exists) {
    throw Object.assign(new Error('Admin profile not found.'), { statusCode: 403 });
  }

  const profile = callerSnap.data() || {};
  if (profile.role !== 'generalAdmin' && profile.role !== 'lotteryAdmin') {
    throw Object.assign(new Error('Not authorized.'), { statusCode: 403 });
  }

  return { caller, profile };
}

function assertLotteryAccess(profile, lotteryId) {
  if (profile.role !== 'lotteryAdmin') return;
  const ids = Array.isArray(profile.lotteryIds) ? profile.lotteryIds : [];
  if (!ids.includes(lotteryId)) {
    throw new Error('You are not assigned to this lottery.');
  }
}

async function approveRequest(db, caller, profile, requestId, requestedLotteryId, manualReference = '', autoGuard = null) {
  let result = null;

  await db.runTransaction(async tx => {
    const requestRef = db.collection('ticketRequests').doc(requestId);
    const requestSnap = await tx.get(requestRef);

    if (!requestSnap.exists) throw new Error('Request not found.');

    const request = requestSnap.data() || {};
    const lotteryId = String(request.lotteryId || requestedLotteryId || '').trim();

    if (!lotteryId) throw new Error('This request has no lottery ID.');
    if (requestedLotteryId && requestedLotteryId !== lotteryId) {
      throw new Error('Request does not belong to the selected lottery.');
    }
    if (request.status !== 'pending') {
      throw new Error('This request has already been reviewed.');
    }

    // For screenshot/PDF-only requests the admin must transcribe the verified
    // bank transaction reference before approving. Without a reference it is
    // impossible to guarantee that the same payment cannot be spent again.
    const reference = String(request.reference || manualReference || '').trim();
    const normalized = normalizePaymentReference(reference);
    if (!/^[A-Z0-9_-]{5,80}$/.test(normalized)) {
      throw Object.assign(new Error('Approval requires a bank transaction reference. For receipt-only purchases, enter the reference printed on the receipt.'),{statusCode:400});
    }
    if (request.reference && manualReference &&
      normalizePaymentReference(request.reference) !== normalizePaymentReference(manualReference)) {
      throw Object.assign(new Error('Cannot replace the original payment reference.'),{statusCode:400});
    }
    const lotteryRef = db.collection('lotteries').doc(lotteryId);
    const claimRef = paymentClaimRef(db, reference);
    const queueRef=autoGuard ? db.collection('autoPaymentQueue').doc(requestId) : null;
    // Read order, lottery, claim, and durably verified bank evidence before
    // any writes. The receipt snapshot must belong to this precise purchase.
    const [lotterySnap, claimSnap, queueSnap] = await Promise.all([
      tx.get(lotteryRef), claimRef ? tx.get(claimRef) : Promise.resolve(null),
      queueRef ? tx.get(queueRef) : Promise.resolve(null)
    ]);
    if (!lotterySnap.exists) throw new Error('Lottery not found.');

    const lottery = lotterySnap.data() || {};
    if (lottery.cleanupInProgress === true) throw new Error('Lottery cleanup is in progress. Approvals are disabled.');
    assertLotteryAccess(profile, lotteryId);
    if (claimRef) assertClaimFree(claimSnapshotStatus(claimSnap, requestId));
    if(autoGuard){
      const {isAfterCutover,cutoverMs}=require('../../lib/cbe-auto-cutover');
      const {enabledFor,productionAccountFor}=require('../../lib/cbe-auto-worker');
      const {usesAutomaticApproval}=require('../../lib/lottery-approval-mode');
      const {nameKey,cbeAccounts,timestampMs}=require('../../lib/cbe-auto-eligibility');
      const [configured]=cbeAccounts(lottery);
      const {checkSavedEvidence,MAX_AGE_MS}=require('../../lib/cbe-verification-evidence');
      const bankEvidence=queueSnap?.exists && configured
        ? checkSavedEvidence(queueSnap.data()?.verifiedEvidence,
            requestId,request,String(configured.number).replace(/\s/g,''))
        : {status:'missing_queue'};
      const stored=bankEvidence.payment||{};
      const guardTime=Number(autoGuard.verifiedAt||0);
      const createdAt=timestampMs(request.createdAt);
      const paidAt=timestampMs(autoGuard.transactionDate);
      const valid = usesAutomaticApproval(lottery) && enabledFor(lotteryId) && lottery.status==='active' &&
        String(autoGuard.requestId)===requestId &&
        String(autoGuard.lotteryId)===lotteryId &&
        autoGuard.policy==='CBE_UNATTENDED_V1' &&
        autoGuard.bankMethod==='official' &&
        Number(autoGuard.cutoffMs)===cutoverMs() &&
        isAfterCutover(request.createdAt,autoGuard.transactionDate) &&
        normalizePaymentReference(autoGuard.reference)===normalized &&
        (!request.reference || normalizePaymentReference(request.reference)===normalized) &&
        Number(autoGuard.expectedAmount)===Number(request.total) &&
        bankEvidence.status==='usable' && queueSnap?.data()?.state==='processing' &&
        bankEvidence.fingerprint===autoGuard.fingerprint &&
        bankEvidence.verifiedAt===guardTime &&
        stored.verified===true && stored.providerDuplicate===false &&
        stored.providerCbeAccountCheck===true &&
        stored.bank==='cbe' && stored.reportedBank==='cbe' &&
        stored.verificationMethod==='official' && stored.status==='completed' &&
        normalizePaymentReference(stored.reportedTransactionNumber)===normalized &&
        stored.transactionDate===autoGuard.transactionDate &&
        stored.receiverName===autoGuard.receiveName &&
        stored.currency==='ETB' && Number(stored.amount)===Number(request.total) &&
        ['exact_match','masked_unverifiable'].includes(stored.receiverAccountStatus) &&
        (stored.receiverAccountStatus!=='masked_unverifiable' ||
          (/^\d{4,8}$/.test(String(stored.maskedReceiverSuffix||'')) &&
            String(autoGuard.account).endsWith(String(stored.maskedReceiverSuffix)))) &&
        configured && cbeAccounts(lottery).length===1 &&
        String(configured.number).replace(/\s/g,'')===String(autoGuard.account) &&
        productionAccountFor(lotteryId)===String(autoGuard.account) &&
        nameKey(configured.holderName)===nameKey(autoGuard.receiveName) &&
        Number.isFinite(createdAt) && Number.isFinite(paidAt) &&
        paidAt>=createdAt-30*60000 && paidAt<=createdAt+30*60000 &&
        Date.now()-guardTime>=0 && Date.now()-guardTime<MAX_AGE_MS;
      if(!valid)throw Object.assign(new Error('CBE auto approval guard did not pass; send to manual review.'),{statusCode:409});
    }

    const min = Number(lottery.min);
    const max = Number(lottery.max);
    const quantity = Number(request.quantity);

    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 100) {
      throw new Error('Invalid ticket quantity.');
    }

    if (!Number.isFinite(min) || !Number.isFinite(max) || min > max) {
      throw new Error('Lottery ticket range is not configured correctly.');
    }

    const currentRaw = Number(lottery.nextTicketNumber);
    const next = Number.isFinite(currentRaw) ? Math.max(min, currentRaw) : min;
    const last = next + quantity - 1;

    if (next > max || last > max) {
      throw new Error('There are not enough remaining ticket numbers in this lottery.');
    }

    const ticketNumbers = Array.from({ length: quantity }, (_, index) => next + index);
    const phone = normalizePhone(request.phone);
    const phoneHash = String(request.phoneHash || '') || sha256(phone);
    const now = FieldValue.serverTimestamp();

    // Atomic with ticket assignment: two concurrent purchases cannot spend the
    // same normalized reference, including references extracted from proof uploads.
    const hasPaymentClaim = createPaymentClaim(tx, claimRef, {
      requestId, lotteryId, createdBy:caller.uid, at:now
    });

    // The lottery counter is the sole allocator for new approvals.
    // tx.create prevents an unexpected stale-counter collision from overwriting a ticket.
    for (const number of ticketNumbers) {
      const ticketRef = db.collection('tickets').doc(`${lotteryId}_${number}`);
      tx.create(ticketRef, {
        lotteryId,
        number,
        requestId,
        assignedAt: now,
        assignedBy: caller.uid
      });
    }

    tx.update(requestRef, {
      status: 'approved',
      ticketNumbers,
      reviewedBy: caller.uid,
      reviewedAt: now,
      lotteryName: String(lottery.name || lotteryId),
      phoneHash,
      reference,
      paymentClaimProtection: 'consumed_reference'
    });

    tx.update(lotteryRef, {
      nextTicketNumber: last + 1
    });
    // The decision and the retryable notification are committed atomically.
    tx.create(db.collection('buyerNotificationQueue').doc(requestId + '_approved'), {
      requestId, lotteryId, decision: 'approved', state: 'pending',
      attempts: 0, nextAttemptAt: now, createdAt: now
    });

    const publicRef = db
      .collection('publicStatus')
      .doc(phoneHash)
      .collection('requests')
      .doc(requestId);

    tx.set(publicRef, {
      lotteryId,
      lotteryName: String(lottery.name || lotteryId),
      phoneLast4: phone.slice(-4),
      quantity,
      total: Number(request.total || Number(request.price || lottery.price || 0) * quantity),
      status: 'approved',
      ticketNumbers,
      reviewedAt: now
    }, { merge: true });

    tx.set(db.collection('auditLogs').doc(), {
      action: autoGuard ? 'approveRequestAutoCBE' : 'approveRequest',
      verificationPolicy: autoGuard ? autoGuard.policy : null,
      lotteryId,
      requestId,
      adminId: caller.uid,
      ticketNumbers,
      quantity,
      paymentClaimProtection: 'consumed_reference',
      createdAt: now
    });

    result = {
      lotteryId,
      lotteryName: String(lottery.name || lotteryId),
      name: String(request.name || ''),
      phone: String(request.phone || ''),
      reference,
      quantity,
      total: Number(request.total || 0),
      phoneHash,
      paymentClaimProtection: hasPaymentClaim ? 'consumed_reference' : 'reference_missing_manual_only',
      ticketNumbers
    };
  });

  return result;
}

async function cancelApproval(db, caller, profile, requestId, reason) {
  let notification = null;

  await db.runTransaction(async tx => {
    const requestRef = db.collection('ticketRequests').doc(requestId);
    const requestSnap = await tx.get(requestRef);

    if (!requestSnap.exists) throw new Error('Request not found.');

    const request = requestSnap.data() || {};
    if (request.status !== 'approved') {
      throw new Error('Only approved requests can be cancelled.');
    }

    const lotteryId = String(request.lotteryId || '');
    if (!lotteryId) throw new Error('This request has no lottery ID.');

    const lotteryRef = db.collection('lotteries').doc(lotteryId);
    const lotterySnap = await tx.get(lotteryRef);

    if (!lotterySnap.exists) throw new Error('Lottery not found.');

    const lottery = lotterySnap.data() || {};
    if (lottery.cleanupInProgress === true) throw new Error('Lottery cleanup is in progress. Approvals are disabled.');
    assertLotteryAccess(profile, lotteryId);

    if (lottery.status === 'drawn') {
      throw new Error('This lottery has already been drawn. Approved tickets cannot be cancelled now.');
    }

    const numbers = Array.isArray(request.ticketNumbers) ? request.ticketNumbers : [];
    const phoneHash = String(request.phoneHash || '');
    const now = FieldValue.serverTimestamp();

    // Deletes are safe without reads: ticket document IDs are deterministic,
    // and cancellation never moves the lottery counter backwards or reuses numbers.
    for (const number of numbers) {
      tx.delete(
        db.collection('tickets').doc(`${lotteryId}_${number}`)
      );
    }

    tx.create(db.collection('buyerNotificationQueue').doc(requestId + '_cancelled'), {
      requestId, lotteryId, decision: 'cancelled', state: 'pending',
      attempts: 0, nextAttemptAt: now, createdAt: now
    });
    tx.update(requestRef, {
      status: 'cancelled',
      cancelledAt: now,
      cancelledBy: caller.uid,
      cancellationReason: reason,
      cancelledTicketNumbers: numbers
    });

    if (phoneHash) {
      const publicRef = db
        .collection('publicStatus')
        .doc(phoneHash)
        .collection('requests')
        .doc(requestId);

      tx.set(publicRef, {
        status: 'cancelled',
        cancellationReason: reason,
        cancelledAt: now,
        cancelledTicketNumbers: numbers
      }, { merge: true });
    }

    tx.set(db.collection('auditLogs').doc(), {
      action: 'cancelApproval',
      lotteryId,
      requestId,
      adminId: caller.uid,
      cancellationReason: reason,
      cancelledTicketNumbers: numbers,
      createdAt: now
    });

    notification = {
      chatId: String(request.telegramChatId || ''),
      lottery: String(request.lotteryName || lottery.name || lotteryId),
      numbers
    };
  });


}


async function rejectRequest(db, caller, profile, requestId, requestedLotteryId, reason) {
  await db.runTransaction(async tx => {
    const ref = db.collection('ticketRequests').doc(requestId);
    const snap = await tx.get(ref);
    if (!snap.exists) throw new Error('Request not found.');
    const request = snap.data() || {};
    const lotteryId = Sç­÷¶‰žËkºwµçE¡”µ½¹ÑÉ½°œ°¹¼µÍÑ½É”œ¤ì4(€¥˜€¡ÁÉ½•ÍÌ¹•¹Ø¹YI1}9X€„ôô€ÁÉ•Ù¥•Üœ¤ì4(€€€É•ÑÕÉ¸É•Ì¹ÍÑ…ÑÕÌ ÐÀÌ¤¹©Í½¸¡í½¬é™…±Í”±•ÉÉ½ÈèA…åµ•¹Ðµ…Ñ¡¥¹œÑ•ÍÑÌ…É”…Ù…¥±…‰±”½¹±ä½¸„Y•É•°AÉ•Ù¥•Ü‘•Á±½åµ•¹Ð¸ô¤ì4(€ô4(€½¹ÍÐ‘ˆ€ô…‘µ¥¹ˆ ¤ì4(€½¹ÍÐìÁÉ½™¥±”ô€ô…Ý…¥Ð…ÕÑ¡•¹Ñ¥…Ñ•‘µ¥¸¡É•Ä°‘ˆ¤ì4(€½¹ÍÐ±½ÑÑ•Éå%€ôMÑÉ¥¹œ¡‰½‘ä¹±½ÑÑ•Éå%ñð€œœ¤¹ÑÉ¥´ ¤ì4(€¥˜€ „½ym„µéµhÀ´å|µuìÄ°ÄÈáô¼¹Ñ•ÍÐ¡±½ÑÑ•Éå%¤¤ì4(€€€É•ÑÕÉ¸É•Ì¹ÍÑ…ÑÕÌ ÐÀÀ¤¹©Í½¸¡í½¬é™…±Í”±•ÉÉ½ÈèM•±•Ð„Ù…±¥±½ÑÑ•Éä¸ô¤ì4(€ô4(€¥˜€¡ÁÉ½™¥±”¹É½±”€ôôô€±½ÑÑ•Éå‘µ¥¸œ€˜˜4(€€€€…ÉÉ…ä¹¥ÍÉÉ…ä¡ÁÉ½™¥±”¹±½ÑÑ•Éå%‘Ìñðmt¤€¤ì4(€€€É•ÑÕÉ¸É•Ì¹ÍÑ…ÑÕÌ ÐÀÌ¤¹©Í½¸¡í½¬é™…±Í”±•ÉÉ½Èè9¼…ÍÍ¥¹•±½ÑÑ•É¥•Ì¸ô¤ì4(€ô4(€¥˜€¡ÁÉ½™¥±”¹É½±”€ôôô€±½ÑÑ•Éå‘µ¥¸œ€˜˜€„¡ÁÉ½™¥±”¹±½ÑÑ•Éå%‘Ìñðmt¤¹¥¹±Õ‘•Ì¡±½ÑÑ•Éå%¤¤ì4(€€€É•ÑÕÉ¸É•Ì¹ÍÑ…ÑÕÌ ÐÀÌ¤¹©Í½¸¡í½¬é™…±Í”±•ÉÉ½Èèe½Ô…É”¹½Ð…ÍÍ¥¹•Ñ¼Ñ¡¥Ì±½ÑÑ•Éä¸ô¤ì4(€ô4(€½¹ÍÐ±½ÑÑ•ÉåM¹…À€ô…Ý…¥Ð‘ˆ¹½±±•Ñ¥½¸ ±½ÑÑ•É¥•Ìœ¤¹‘½Œ¡±½ÑÑ•Éå%¤¹•Ð ¤ì4(€¥˜€ …±½ÑÑ•ÉåM¹…À¹•á¥ÍÑÌ¤É•ÑÕÉ¸É•Ì¹ÍÑ…ÑÕÌ ÐÀÐ¤¹©Í½¸¡í½¬é™…±Í”±•ÉÉ½Èè1½ÑÑ•Éä¹½Ð™½Õ¹¸ô¤ì4(€½¹ÍÐ±½ÑÑ•Éä€ô±½ÑÑ•ÉåM¹…À¹‘…Ñ„ ¤ñðíôì4(€¥˜€¡±½ÑÑ•Éä¹±•…¹ÕÁ%¹AÉ½É•ÍÌ¤É•ÑÕÉ¸É•Ì¹ÍÑ…ÑÕÌ ÐÀä¤¹©Í½¸¡í½¬é™…±Í”±•ÉÉ½ÈèQ¡¥Ì±½ÑÑ•Éä¥Ì‰•¥¹œ‘•±•Ñ•¸ô¤ì4(€½¹ÍÐ…½Õ¹ÑÌ€ôÉÉ…ä¹¥ÍÉÉ…ä¡±½ÑÑ•Éä¹Á…åµ•¹Ñ½Õ¹ÑÌ¤€ü±½ÑÑ•Éä¹Á…åµ•¹Ñ½Õ¹ÑÌ€èmtì4(€½¹ÍÐ‰•%¹‘•á•Ì€ô…½Õ¹ÑÌ¹µ…À ¡„±¤¤ôø¡í„±¥ô¤¤¹™¥±Ñ•È ¡í…ô¤ôø½x¡‰•ñ½µµ•É¥…°‰…¹¬½˜•Ñ¡¥½Á¥„¤½¤¹Ñ•ÍÐ¡MÑÉ¥¹œ¡„¹‰…¹¬ñð€œœ¤¹ÑÉ¥´ ¤¤¤ì4(€¥˜€ …‰•%¹‘•á•Ì¹±•¹Ñ ¤É•ÑÕÉ¸É•Ì¹ÍÑ…ÑÕÌ ÐÀÀ¤¹©Í½¸¡í½¬é™…±Í”±•ÉÉ½Èè½¹™¥ÕÉ”„É•…°	É••¥Ù¥¹œ…½Õ¹Ð™½ÈÑ¡¥Ì±½ÑÑ•Éä‰•™½É”Ñ•ÍÑ¥¹œ¸ô¤ì4(€½¹ÍÐ¥¹‘•à€ô‰½‘ä¹…½Õ¹Ñ%¹‘•à€ôôôÕ¹‘•™¥¹•ñð‰½‘ä¹…½Õ¹Ñ%¹‘•à€ôôô¹Õ±°ñð‰½‘ä¹…½Õ¹Ñ%¹‘•à€ôôô€œœ4(€€€€ü€¡‰•%¹‘•á•Ì¹±•¹Ñ €ôôô€Ä€ü‰•%¹‘•á•ÍlÁt¹¤€è€´Ä¤4(€€€€è9Õµ‰•È¡‰½‘ä¹…½Õ¹Ñ%¹‘•à¤ì4(€¥˜€ …9Õµ‰•È¹¥Í%¹Ñ••È¡¥¹‘•à¤ñð¥¹‘•à€ð€Àñð¥¹‘•à€øô…½Õ¹ÑÌ¹±•¹Ñ ñð4(€€€€…‰•%¹‘•á•Ì¹Í½µ”¡àôùà¹¤ôôõ¥¹‘•à¤¤ì4(€€€É•ÑÕÉ¸É•Ì¹ÍÑ…ÑÕÌ ÐÀÀ¤¹©Í½¸¡í½¬é™…±Í”±•ÉÉ½ÈèM•±•Ð½¹”½˜Ñ¡¥Ì±½ÑÑ•ÉåpÌ½¹™¥ÕÉ•	É••¥Ù¥¹œ…½Õ¹ÑÌ¸ô¤ì4(€ô4(€½¹ÍÐ…½Õ¹Ð€ôMÑÉ¥¹œ¡…½Õ¹ÑÍm¥¹‘•át¹¹Õµ‰•Èñð€œœ¤¹É•Á±…” ½qÌ¬½œ°œœ¤ì4(€¥˜€ „½yq‘ìà°ÌÁô¼¹Ñ•ÍÐ¡…½Õ¹Ð¤ñð…½Õ¹Ð€ôôô€œÄÀÀÀÀÀÀÀÀÀÀÀÀœ¤ì4(€€€É•ÑÕÉ¸É•Ì¹ÍÑ…ÑÕÌ ÐÀÀ¤¹©Í½¸¡í½¬é™…±Í”±•ÉÉ½ÈèI•Á±…”Ñ¡”Í…µÁ±”½µ¥ÍÍ¥¹œ	…½Õ¹ÐÝ¥Ñ „É•…°…½Õ¹Ð¥¸A…åµ•¹Ð½Õ¹ÑÌ¸ô¤ì4(€ô4(4(€±•ÐÉ•ÅÕ•ÍÑM¹…Àì4(€½¹ÍÐÉ•ÅÕ•ÍÑ%€ôMÑÉ¥¹œ¡‰½‘ä¹É•ÅÕ•ÍÑ%ñð€œœ¤¹ÑÉ¥´ ¤ì4(€¥˜€¡É•ÅÕ•ÍÑ%¤ì4(€€€¥˜€ „½ym„µéµhÀ´å|µuìÄ°ÄÈáô¼¹Ñ•ÍÐ¡É•ÅÕ•ÍÑ%¤¤É•ÑÕÉ¸É•Ì¹ÍÑ…ÑÕÌ ÐÀÀ¤¹©Í½¸¡í½¬é™…±Í”±•ÉÉ½Èè%¹Ù…±¥É•ÅÕ•ÍÐ%¸ô¤ì4(€€€É•ÅÕ•ÍÑM¹…À€ô…Ý…¥Ð‘ˆ¹½±±•Ñ¥½¸ Ñ¥­•ÑI•ÅÕ•ÍÑÌœ¤¹‘½Œ¡É•ÅÕ•ÍÑ%¤¹•Ð ¤ì4(€ô•±Í”ì4(€€€½¹ÍÐÉ•™•É•¹”€ôMÑÉ¥¹œ¡‰½‘ä¹É•™•É•¹”ñð€œœ¤¹ÑÉ¥´ ¤ì4(€€€¥˜€ „½ym„µéµhÀ´å|µuìÔ°àÁô¼¹Ñ•ÍÐ¡É•™•É•¹”¤¤ì4(€€€€€É•ÑÕÉ¸É•Ì¹ÍÑ…ÑÕÌ ÐÀÀ¤¹©Í½¸¡í½¬é™…±Í”±•ÉÉ½Èè¹Ñ•ÈÑ¡”•á…ÐÉ•™•É•¹”™É½´„Á•¹‘¥¹œÑ¥­•Ð¸ô¤ì4(€€€ô4(€€€½¹ÍÐ…¹½¹¥…±%€ôÍ¡„ÈÔØ Ièœ€¬É•™•É•¹”¹Ñ½UÁÁ•É…Í” ¤¤¹Í±¥” À°ÐÀ¤ì4(€€€½¹ÍÐ‘¥É•Ð€ô…Ý…¥Ð‘ˆ¹½±±•Ñ¥½¸ Ñ¥­•ÑI•ÅÕ•ÍÑÌœ¤¹‘½Œ¡…¹½¹¥…±%¤¹•Ð ¤ì4(€€€¥˜€¡‘¥É•Ð¹•á¥ÍÑÌ€˜˜‘¥É•Ð¹‘…Ñ„ ¤¹±½ÑÑ•Éå%€ôôô±½ÑÑ•Éå%€˜˜4(€€€€€€€MÑÉ¥¹œ¡‘¥É•Ð¹‘…Ñ„ ¤¹É•™•É•¹”ñð€œœ¤¹ÑÉ¥´ ¤¹Ñ½UÁÁ•É…Í” ¤€ôôôÉ•™•É•¹”¹Ñ½UÁÁ•É…Í” ¤¤ì4(€€€€€É•ÅÕ•ÍÑM¹…À€ô‘¥É•Ðì4(€€€ô•±Í”ì4(€€€€€½¹ÍÐÅÕ•Éå5…Ñ¡•Ì€ô…Ý…¥Ð‘ˆ¹½±±•Ñ¥½¸ Ñ¥­•ÑI•ÅÕ•ÍÑÌœ¤¹Ý¡•É” É•™•É•¹”œ°œôôœ±É•™•É•¹”¤¹±¥µ¥Ð ÈÄ¤¹•Ð ¤ì4(€€€€€½¹ÍÐµ…Ñ¡•Ì€ôÅÕ•Éå5…Ñ¡•Ì¹‘½Ì¹™¥±Ñ•È¡ôù¹‘…Ñ„ ¤¹±½ÑÑ•Éå%ôôõ±½ÑÑ•Éå%¤ì4(€€€€€¥˜€¡ÅÕ•Éå5…Ñ¡•Ì¹Í¥é”€øô€ÈÄ¤É•ÑÕÉ¸É•Ì¹ÍÑ…ÑÕÌ ÐÀä¤¹©Í½¸¡í½¬é™…±Í”±•ÉÉ½ÈèQ½¼µ…¹äÉ•ÅÕ•ÍÑÌÍ¡…É”Ñ¡¥ÌÉ•™•É•¹”¸UÍ”Ñ¡”É•ÅÕ•ÍÐ%¸ô¤ì4(€€€€€¥˜€¡µ…Ñ¡•Ì¹±•¹Ñ €„ôô€Ä¤É•ÑÕÉ¸É•Ì¹ÍÑ…ÑÕÌ¡µ…Ñ¡•Ì¹±•¹Ñ üÐÀäèÐÀÐ¤¹©Í½¸¡ì4(€€€€€€€½¬é™…±Í”±•ÉÉ½Èéµ…Ñ¡•Ì¹±•¹Ñ üI•™•É•¹”¥Ì…µ‰¥Õ½ÕÌ¸UÍ”Ñ¡”É•ÅÕ•ÍÐ%¸œè9¼µ…Ñ¡¥¹œÑ¥­•ÐÉ•ÅÕ•ÍÐ™½Õ¹¥¸Ñ¡¥Ì±½ÑÑ•Éä¸œ4(€€€€€ô¤ì4(€€€€€É•ÅÕ•ÍÑM¹…À€ôµ…Ñ¡•ÍlÁtì4(€€€ô4(€ô4(€¥˜€ …É•ÅÕ•ÍÑM¹…Àü¹•á¥ÍÑÌñðÉ•ÅÕ•ÍÑM¹…À¹‘…Ñ„ ¤¹±½ÑÑ•Éå%€„ôô±½ÑÑ•Éå%¤ì4(€€€É•ÑÕÉ¸É•Ì¹ÍÑ…ÑÕÌ ÐÀÐ¤¹©Í½¸¡í½¬é™…±Í”±•ÉÉ½ÈèA•¹‘¥¹œÑ¥­•ÐÉ•ÅÕ•ÍÐ¹½Ð™½Õ¹¥¸Ñ¡”Í•±•Ñ•±½ÑÑ•Éä¸ô¤ì4(€ô4(€½¹ÍÐÁÕÉ¡…Í”€ôÉ•ÅÕ•ÍÑM¹…À¹‘…Ñ„ ¤ñðíôì4(€¥˜€¡ÁÕÉ¡…Í”¹ÍÑ…ÑÕÌ€„ôô€Á•¹‘¥¹œœ¤É•ÑÕÉ¸É•Ì¹ÍÑ…ÑÕÌ ÐÀä¤¹©Í½¸¡í½¬é™…±Í”±•ÉÉ½Èè=¹±äÁ•¹‘¥¹œÉ•ÅÕ•ÍÑÌ…¸‰”¡•­•¸ô¤ì4(€½¹ÍÐÍÑ½É•‘I•™•É•¹”€ôMÑÉ¥¹œ¡ÁÕÉ¡…Í”¹É•™•É•¹”ñð€œœ¤¹ÑÉ¥´ ¤ì4(€½¹ÍÐµ•Ñ¡½€ôMÑÉ¥¹œ¡‰½‘ä¹Ù•É¥™¥…Ñ¥½¹5•Ñ¡½ñð€É•™•É•¹”œ¤¹Ñ½1½Ý•É…Í” ¤ì4(€¥˜€ …lÉ•™•É•¹”œ°É••¥ÁÐt¹¥¹±Õ‘•Ì¡µ•Ñ¡½¤¤ì4(€€€É•ÑÕÉ¸É•Ì¹ÍÑ…ÑÕÌ ÐÀÀ¤¹©Í½¸¡í½¬é™…±Í”±•ÉÉ½ÈèU¹ÍÕÁÁ½ÉÑ•Ù•É¥™¥…Ñ¥½¸µ•Ñ¡½¸ô¤ì4(€ô4(€¥˜€¡µ•Ñ¡½€ôôô€É•™•É•¹”œ€˜˜€„½ym„µéµhÀ´å|µuìÔ°àÁô¼¹Ñ•ÍÐ¡ÍÑ½É•‘I•™•É•¹”¤¤ì4(€€€É•ÑÕÉ¸É•Ì¹ÍÑ…ÑÕÌ ÐÀÀ¤¹©Í½¸¡í½¬é™…±Í”±•ÉÉ½ÈèQ¡¥ÌÉ•ÅÕ•ÍÐ¡…Ì¹¼ÍÕÁÁ½ÉÑ•	É•™•É•¹”¸M•±•ÐÑ¡”É••¥ÁÐµ•Ñ¡½¥˜¥Ð¡…Ì„A½¥µ…”¸ô¤ì4(€ô4(€¥˜€¡µ•Ñ¡½€ôôô€É••¥ÁÐœ€˜˜€…ÁÕÉ¡…Í”¹ÁÉ½½™A…Ñ ¤ì4(€€€É•ÑÕÉ¸É•Ì¹ÍÑ…ÑÕÌ ÐÀÀ¤¹©Í½¸¡í½¬é™…±Í”±•ÉÉ½Èè9¼ÁÉ¥Ù…Ñ”A½ÈÍÉ••¹Í¡½Ð¥Ì…ÑÑ…¡•Ñ¼Ñ¡¥ÌÉ•ÅÕ•ÍÐ¸ô¤ì4(€ô4(€½¹ÍÐìÙ•É¥™å¡•­ÑA…åµ•¹Ðô€ôÉ•ÅÕ¥É” œ¸¸¼¸¸½±¥ˆ½¡•­•ÐµÙ•É¥™äœ¤ì4(€½¹ÍÐì½µÁ…É•A…åµ•¹ÑQ½I•ÅÕ•ÍÐô€ôÉ•ÅÕ¥É” œ¸¸¼¸¸½±¥ˆ½¡•­•ÐµÉ•ÅÕ•ÍÐµµ…Ñ œ¤ì4(€±•ÐÉ••¥ÁÑ¥±”€ô¹Õ±°ì4(€¥˜€¡µ•Ñ¡½€ôôô€É••¥ÁÐœ¤ì4(€€€½¹ÍÐíÉ•…‘¥¹…±I••¥ÁÑôõÉ•ÅÕ¥É” œ¸¸¼¸¸½±¥ˆ½¡•­•ÐµÁÉ¥Ù…Ñ”µÉ••¥ÁÐœ¤ì4(€€€€¼¼=¹±äÍ•ÉÙ•Èµ½Ý¹•™¥¹…±¥é•L½‰©•ÑÌì¹•Ù•ÈÍ•¹ÕÍÑ½µ•ÈUI1ÌÑ¼¡•¬¹•Ð¸4(€€€É••¥ÁÑ¥±”õ…Ý…¥ÐÉ•…‘¥¹…±I••¥ÁÐ¡ÁÕÉ¡…Í”¤ì4(€ô4(€€¼¼¡•¬¹•ÐÉ••¥Ù•ÌÑ¡”™Õ±°½¹™¥ÕÉ•É••¥Ù¥¹œ…½Õ¹Ð°…¹„É•™•É•¹”4(€€¼¼=HÑ¡”…ÕÑ¡•¹Ñ¥…Ñ•ÁÉ¥Ù…Ñ”™¥±”¸A½•Ì‘¥É•Ñ±äÑ¼¡•¬¹•Ðè¹¼=H¸4(€€¼¼%µ…•Ì…É”…¸•áÁ•É¥µ•¹Ðì¡•¬¹•Ðµ…äÉ•ÍÁ½¹€ÐÈÈÝ¥Ñ¡½ÕÐÉ••¥ÁÑ}Ñ•áÐ¸4(€½¹ÍÐÙ•É¥™¥…Ñ¥½¸€ô…Ý…¥ÐÙ•É¥™å¡•­ÑA…åµ•¹Ð¡ì4(€€€‰…¹¬è‰”œ°…½Õ¹Ñ9Õµ‰•Èé…½Õ¹Ð°4(€€€€¸¸¸¡µ•Ñ¡½€ôôô€É••¥ÁÐœ€üíÉ••¥ÁÑ¥±•ô€èíÑÉ…¹Í…Ñ¥½¹9Õµ‰•ÈéÍÑ½É•‘I•™•É•¹•ô¤4(€ô¤ì4(€½¹ÍÐÁÉ½Ù¥‘•ÉI•™•É•¹”€ôMÑÉ¥¹œ¡Ù•É¥™¥…Ñ¥½¸¹É•Á½ÉÑ•‘QÉ…¹Í…Ñ¥½¹9Õµ‰•Èñð€œœ¤¹ÑÉ¥´ ¤¹Ñ½UÁÁ•É…Í” ¤ì4(€½¹ÍÐ•™™•Ñ¥Ù•I•™•É•¹”€ôµ•Ñ¡½€ôôô€É••¥ÁÐœ4(€€€€ü€¡ÁÉ½Ù¥‘•ÉI•™•É•¹”ñðÍÑ½É•‘I•™•É•¹”¹Ñ½UÁÁ•É…Í” ¤¤€èÍÑ½É•‘I•™•É•¹”ì4(€€¼¼Q¡¥Ì±½½­ÕÀ¥Ì…‘Ù¥Í½Éä€¡•á…Ð±•…ä¥É•ÍÑ½É”É•™•É•¹”½¹±ä¤¸A•ÉÍ¥ÍÑ•¹Ð4(€€¼¼±½‰…°Á…åµ•¹Ñ±…¥µÌ¥ÌÑ¡”ÍÑÉ½¹•È™ÕÑÕÉ”ÁÉ½Ñ•Ñ¥½¸¸9•¥Ñ¡•ÈÝÉ¥Ñ•Ì‘…Ñ„¸4(€½¹ÍÐ±…¥µI•˜€ô€½ymµhÀ´å|µuìÔ°àÁô¼¹Ñ•ÍÐ¡•™™•Ñ¥Ù•I•™•É•¹”¤4(€€€€üÁ…åµ•¹Ñ±…¥µI•˜¡‘ˆ±•™™•Ñ¥Ù•I•™•É•¹”¤€è¹Õ±°ì4(€½¹ÍÐmÍ…µ•I•˜°•á¥ÍÑ¥¹±…¥µt€ô…Ý…¥ÐAÉ½µ¥Í”¹…±°¡l4(€€€±…¥µI•˜4(€€€€€€ü‘ˆ¹½±±•Ñ¥½¸ Ñ¥­•ÑI•ÅÕ•ÍÑÌœ¤¹Ý¡•É” É•™•É•¹”œ°œôôœ±•™™•Ñ¥Ù•I•™•É•¹”¤¹±¥µ¥Ð ÈÄ¤¹•Ð ¤4(€€€€€€èAÉ½µ¥Í”¹É•Í½±Ù”¡í‘½Ìémt±Í¥é”èÁô¤°4(€€€±…¥µI•˜€ü±…¥µI•˜¹•Ð ¤€èAÉ½µ¥Í”¹É•Í½±Ù”¡¹Õ±°¤4(€t¤ì4(€½¹ÍÐ½Ñ¡•É½Ì€ôÍ…µ•I•˜¹‘½Ì¹™¥±Ñ•È¡àôùà¹¥„ôõÉ•ÅÕ•ÍÑM¹…À¹¥¤ì4(€½¹ÍÐ‘ÕÁ±¥…Ñ”€ôì4(€€€½Ñ¡•É½Õ¹Ðé½Ñ¡•É½Ì¹±•¹Ñ °4(€€€½Ñ¡•ÉÁÁÉ½Ù•‘½Õ¹Ðé½Ñ¡•É½Ì¹™¥±Ñ•È¡àôùà¹‘…Ñ„ ¤¹ÍÑ…ÑÕÌôôô…ÁÁÉ½Ù•œ¤¹±•¹Ñ °4(€€€ÑÉÕ¹…Ñ•éÍ…µ•I•˜¹Í¥é”ôôôÈÄ°4(€€€±…¥µMÑ…ÑÕÌé±…¥µI•˜€ü±…¥µM¹…ÁÍ¡½ÑMÑ…ÑÕÌ¡•á¥ÍÑ¥¹±…¥´±É•ÅÕ•ÍÑM¹…À¹¥¤€è€É•™•É•¹•}¹½Ñ}É•ÑÕÉ¹•œ4(€ôì4(€€¼¼½ÈÉ••¥ÁÐµ½¹±äÁÕÉ¡…Í•Ì°µ…É¬Ñ¡”‰…¹¬µÍÕÁÁ±¥•É•™•É•¹”…Ì•áÑÉ…Ñ•°4(€€¼¼9=P…Ì„ÕÍÑ½µ•ÈÉ•™•É•¹”µ…Ñ ¸-••À¡Õµ…¸É•Ù¥•ÜÉ•…É‘±•ÍÌ¸4(€½¹ÍÐ…ÍÍ•ÍÍµ•¹Ð€ô½µÁ…É•A…åµ•¹ÑQ½I•ÅÕ•ÍÐ 4(€€€ì¸¸¹ÁÕÉ¡…Í”±±½ÑÑ•Éå%‘ô°Ù•É¥™¥…Ñ¥½¸°í¥é±½ÑÑ•Éå%‘ô±‘ÕÁ±¥…Ñ”4(€€¤ì4(€¥˜€¡µ•Ñ¡½€ôôô€É••¥ÁÐœ¤ì4(€€€…ÍÍ•ÍÍµ•¹Ð¹¡•­Ì¹É••¥ÁÑ%¹ÁÕÐ€ôÉ••¥ÁÑ¥±”¹µ¥µ”€ôôô€…ÁÁ±¥…Ñ¥½¸½Á‘˜œ€ü€Á‘˜œ€è€¥µ…”œì4(€€€…ÍÍ•ÍÍµ•¹Ð¹¡•­Ì¹‰…¹­áÑÉ…Ñ•‘I•™•É•¹”€ôÁÉ½Ù¥‘•ÉI•™•É•¹”¹±•¹Ñ €ø€Àì4(€€€¥˜€ …ÍÑ½É•‘I•™•É•¹”¤ì4(€€€€€…ÍÍ•ÍÍµ•¹Ð¹É•½µµ•¹‘…Ñ¥½¸ô59U1}IY%\œì4(€€€€€…ÍÍ•ÍÍµ•¹Ð¹½¹•É¹Ì¹ÁÕÍ ¡ÁÉ½Ù¥‘•ÉI•™•É•¹”4(€€€€€€€€ü€I•™•É•¹”Ý…Ì•áÑÉ…Ñ•™É½´„É••¥ÁÐ°¹½Ð•¹Ñ•É•‰äÑ¡”‰Õå•È¸I•½¹¥±”¥Ð‰•™½É”…ÁÁÉ½Ù…°¸œ4(€€€€€€€€è€¡•¬¹•Ð‘¥¹½ÐÉ•ÑÕÉ¸„ÕÍ…‰±”É•™•É•¹”¸ÁÁÉ½Ù…°É•ÅÕ¥É•Ì„Ù•É¥™¥•É•™•É•¹”¸œ¤ì4(€€€ô4(€€€¥˜€¡ÍÑ½É•‘I•™•É•¹”€˜˜ÁÉ½Ù¥‘•ÉI•™•É•¹”€˜˜ÍÑ½É•‘I•™•É•¹”¹Ñ½UÁÁ•É…Í” ¤€„ôôÁÉ½Ù¥‘•ÉI•™•É•¹”¤ì4(€€€€€…ÍÍ•ÍÍµ•¹Ð¹É•½µµ•¹‘…Ñ¥½¸ô59U1}IY%\œì4(€€€€€…ÍÍ•ÍÍµ•¹Ð¹½¹•É¹Ì¹ÁÕÍ  Q¡”A½¥µ…”É•™•É•¹”‘¥™™•ÉÌ™É½´Ñ¡”ÕÍÑ½µ•Èµ•¹Ñ•É•É•™•É•¹”¸œ¤ì4(€€€ô4(€ô4(€½¹ÍÐí•Ù…±Õ…Ñ•ÕÑ½A…åµ•¹ÑôõÉ•ÅÕ¥É” œ¸¸¼¸¸½±¥ˆ½‰”µ…ÕÑ¼µ•±¥¥‰¥±¥Ñäœ¤ì4(€€¼¼%¹™½Éµ…Ñ¥Ù”½¹±äèAÉ•Ù¥•ÜÕÍ•ÌÑ¡”Í…µ”ÁÉ½‘ÕÑ¥½¸¥É•ÍÑ½É”‰ÕÐÝ¥±°9YH4(€€¼¼¡…¹”Ñ¥­•ÑÌ‰…Í•½¸Ñ¡¥Ì•±¥¥‰¥±¥ÑäÉ•Á½ÉÐ¸4(€½¹ÍÐ…ÕÑ½±¥¥‰¥±¥Ñäõ•Ù…±Õ…Ñ•ÕÑ½A…åµ•¹Ð¡ì4(€€€ÁÕÉ¡…Í”±±½ÑÑ•Éä±Ù•É¥™¥…Ñ¥½¸±‘ÕÁ±¥…Ñ”4(€ô¤ì4(€É•ÑÕÉ¸É•Ì¹ÍÑ…ÑÕÌ ÈÀÀ¤¹©Í½¸¡ì4(€€€½¬éÑÉÕ”±É•…‘=¹±äéÑÉÕ”±Ù•É¥™¥…Ñ¥½¹%¹ÁÕÐéµ•Ñ¡½°4(€€€…ÕÑ½±¥¥‰¥±¥Ñä°4(€€€É•ÅÕ•ÍÐéí¥éÉ•ÅÕ•ÍÑM¹…À¹¥±±½ÑÑ•Éå%±Ñ½Ñ…°é9Õµ‰•È¡ÁÕÉ¡…Í”¹Ñ½Ñ…±ñðÀ¤°4(€€€€€É•™•É•¹”éÍÑ½É•‘I•™•É•¹”±•áÑÉ…Ñ•‘I•™•É•¹”éµ•Ñ¡½ôôôÉ••¥ÁÐœýÁÉ½Ù¥‘•ÉI•™•É•¹”èœô°4(€€€Á…åµ•¹Ðéì4(€€€€€‰…¹¬éÙ•É¥™¥…Ñ¥½¸¹‰…¹¬±ÍÑ…ÑÕÌéÙ•É¥™¥…Ñ¥½¸¹ÍÑ…ÑÕÌ±…µ½Õ¹ÐéÙ•É¥™¥…Ñ¥½¸¹…µ½Õ¹Ð±ÕÉÉ•¹äéÙ•É¥™¥…Ñ¥½¸¹ÕÉÉ•¹ä°4(€€€€€ÑÉ…¹Í…Ñ¥½¹…Ñ”éÙ•É¥™¥…Ñ¥½¸¹ÑÉ…¹Í…Ñ¥½¹…Ñ”±Á…å•É9…µ”éÙ•É¥™¥…Ñ¥½¸¹Á…å•É9…µ”±É••¥Ù•É9…µ”éÙ•É¥™¥…Ñ¥½¸¹É••¥Ù•É9…µ”°4(€€€€€É••¥Ù•É½Õ¹ÑMÑ…ÑÕÌéÙ•É¥™¥…Ñ¥½¸¹É••¥Ù•É½Õ¹ÑMÑ…ÑÕÌ°4(€€€€€ÁÉ½Ù¥‘•É‰•½Õ¹Ñ¡•¬éÙ•É¥™¥…Ñ¥½¸¹ÁÉ½Ù¥‘•É‰•½Õ¹Ñ¡•¬4(€€€ô°4(€€€…ÍÍ•ÍÍµ•¹Ð4(€ô¤ì4)ô4(4(¼¼AÉ•Ù¥•Üµ½¹±äµ…¹Õ…°Ù•É¥™¥…Ñ¥½¸è¹¼¥É•ÍÑ½É”µÕÑ…Ñ¥½¹Ì½ÈÑ¥­•Ð…ÁÁÉ½Ù…°¸4)…Íå¹Œ™Õ¹Ñ¥½¸¡…¹‘±•¡•­ÑY•É¥™¥…Ñ¥½¸¡É•Ä°É•Ì°‰½‘ä¤ì4(€É•Ì¹Í•Ñ!•…‘•È …¡”µ½¹ÑÉ½°œ°€¹¼µÍÑ½É”œ¤ì4(€¥˜€¡ÁÉ½•ÍÌ¹•¹Ø¹YI1}9X€„ôô€ÁÉ•Ù¥•Üœ¤ì4(€€€É•ÑÕÉ¸É•Ì¹ÍÑ…ÑÕÌ ÐÀÌ¤¹©Í½¸¡ì½¬é™…±Í”°•ÉÉ½Èè5…¹Õ…°¡•¬¹•ÐÙ•É¥™¥…Ñ¥½¸Ñ•ÍÑÌ…É”…Ù…¥±…‰±”½¹±ä½¸„Y•É•°AÉ•Ù¥•Ü‘•Á±½åµ•¹Ð¸œô¤ì4(€ô4(€½¹ÍÐ‘ˆ€ô…‘µ¥¹ˆ ¤ì4(€½¹ÍÐìÁÉ½™¥±”ô€ô…Ý…¥Ð…ÕÑ¡•¹Ñ¥…Ñ•‘µ¥¸¡É•Ä°‘ˆ¤ì4(€¥˜€¡ÁÉ½™¥±”¹É½±”€„ôô€•¹•É…±‘µ¥¸œ¤ì4(€€€É•ÑÕÉ¸É•Ì¹ÍÑ…ÑÕÌ ÐÀÌ¤¹©Í½¸¡ì½¬é™…±Í”°•ÉÉ½Èè=¹±ä•¹•É…°‘µ¥¸…¸Ñ•ÍÐÁ…åµ•¹ÐÙ•É¥™¥…Ñ¥½¸¸œô¤ì4(€ô4(€½¹ÍÐìÙ•É¥™å¡•­ÑA…åµ•¹Ðô€ôÉ•ÅÕ¥É” œ¸¸¼¸¸½±¥ˆ½¡•­•ÐµÙ•É¥™äœ¤ì4(€½¹ÍÐÉ•ÍÕ±Ð€ô…Ý…¥ÐÙ•É¥™å¡•­ÑA…åµ•¹Ð¡‰½‘ä¤ì4(€É•ÑÕÉ¸É•Ì¹ÍÑ…ÑÕÌ ÈÀÀ¤¹©Í½¸¡ì½¬éÑÉÕ”°€¸¸¹É•ÍÕ±Ðô¤ì4)ô4(4(¼¼É½¸µ½¹±ä…ÕÑ½µ…Ñ¥Œ	Á…åµ•¹ÐÁÉ½•ÍÍ½È¸9¼ÁÕ‰±¥Œ…±±•È…¹¹•Ù•È™É½´4(¼¼Y•É•°AÉ•Ù¥•Ü€¡Ý¡¥ Í¡…É•ÌÑ¡”ÁÉ½‘ÕÑ¥½¸¥É•ÍÑ½É”‘…Ñ…‰…Í”¤¸4)…Íå¹Œ™Õ¹Ñ¥½¸¡…¹‘±•ÕÑ½‰•]½É­•È¡É•Ä±É•Ì¥ì4(€É•Ì¹Í•Ñ!•…‘•È …¡”µ½¹ÑÉ½°œ°¹¼µÍÑ½É”œ¤ì4(€½¹ÍÐí¡•­]½É­•ÉM•É•Ð±ÉÕ¹	…Ñ¡ôõÉ•ÅÕ¥É” œ¸¸¼¸¸½±¥ˆ½‰”µ…ÕÑ¼µÝ½É­•Èœ¤ì4(€¥˜ …¡•­]½É­•ÉM•É•Ð¡É•Ä¤¥É•ÑÕÉ¸É•Ì¹ÍÑ…ÑÕÌ ÐÀÄ¤¹©Í½¸¡í½¬é™…±Í”±•ÉÉ½ÈèU¹…ÕÑ¡½É¥é•¸ô¤ì4(€½¹ÍÐíÕÑ½Ù•É5ÍôõÉ•ÅÕ¥É” œ¸¸¼¸¸½±¥ˆ½‰”µ…ÕÑ¼µÕÑ½Ù•Èœ¤ì4(€¥˜¡ÁÉ½•ÍÌ¹•¹Ø¹YI1}9X„ôôÁÉ½‘ÕÑ¥½¸œñð4(€€€€ÁÉ½•ÍÌ¹•¹Ø¹1=QQIe}	}UQ=}AAI=Y1}9	1„ôôÑÉÕ”œñð4(€€€€€…9Õµ‰•È¹¥Í¥¹¥Ñ”¡ÕÑ½Ù•É5Ì ¤¤ñð…Ñ”¹¹½Ü ¤ñÕÑ½Ù•É5Ì ¤¤ì4(€€€É•ÑÕÉ¸É•Ì¹ÍÑ…ÑÕÌ ÐÀÌ¤¹©Í½¸¡í½¬é™…±Í”±•ÉÉ½Èè	…ÕÑ½µ…Ñ¥Œ…ÁÁÉ½Ù…°¥Ì¹½Ð•¹…‰±•¸ô¤ì4(€ô4(€½¹ÍÐ‘ˆõ…‘µ¥¹ˆ ¤ì4(€½¹ÍÐÉ•ÍÕ±Ðõ…Ý…¥ÐÉÕ¹	…Ñ ¡‘ˆ±ì4(€€€…ÁÁÉ½Ù”é…Íå¹Œ¡É•ÅÕ•ÍÑ%±±½ÑÑ•Éå%±É•™•É•¹”±Õ…É¤ôùì4(€€€€€…Ý…¥Ð…ÁÁÉ½Ù•I•ÅÕ•ÍÐ¡‘ˆ±íÕ¥èÍåÍÑ•´é¡•­•Ðµ‰”ô±íÉ½±”è•¹•É…±‘µ¥¸ô°4(€€€€€€€É•ÅÕ•ÍÑ%±±½ÑÑ•Éå%±É•™•É•¹”±Õ…É¤ì4(€€€ô4(€ô¤ì4(€É•ÑÕÉ¸É•Ì¹ÍÑ…ÑÕÌ ÈÀÀ¤¹©Í½¸¡í½¬éÑÉÕ”°¸¸¹É•ÍÕ±Ñô¤ì4)ô4(4)µ½‘Õ±”¹•áÁ½ÉÑÌ€ô…Íå¹Œ€¡É•Ä°É•Ì¤€ôøì4(€¥˜€¡É•Ä¹µ•Ñ¡½€ôôô€Pœ€˜˜MÑÉ¥¹œ¡É•Ä¹ÅÕ•Éäü¹É••¥ÁÐñð€œœ¤€ôôô€œÄœ¤ì4(€€€É•ÑÕÉ¸Í•ÉÙ•A…åµ•¹ÑI••¥ÁÐ¡É•Ä°É•Ì¤ì4(€ô4(€¥˜€¡É•Ä¹µ•Ñ¡½€„ôô€A=MPœ¤ì4(€€€É•ÑÕÉ¸É•Ì¹ÍÑ…ÑÕÌ ÐÀÔ¤¹©Í½¸¡ì½¬è™…±Í”°•ÉÉ½Èè€5•Ñ¡½¹½Ð…±±½Ý•¸œô¤ì4(€ô4(4(€ÑÉäì4(€€€½¹ÍÐ‰½‘ä€ôÉ•…‘	½‘ä¡É•Ä¤ì4(€€€½¹ÍÐ…Ñ¥½¸€ôMÑÉ¥¹œ¡‰½‘ä¹…Ñ¥½¸ñð€œœ¤¹ÑÉ¥´ ¤¹Ñ½1½Ý•É…Í” ¤ì4(€€€¥˜€¡…Ñ¥½¸€ôôô€‰”µ…ÕÑ¼µÝ½É­•Èœ¤É•ÑÕÉ¸…Ý…¥Ð¡…¹‘±•ÕÑ½‰•]½É­•È¡É•Ä°É•Ì¤ì4(€€€¥˜€¡…Ñ¥½¸€ôôô€¡•­•Ðµµ…Ñ µÁ•¹‘¥¹œœ¤É•ÑÕÉ¸…Ý…¥Ð¡…¹‘±•¡•­ÑA•¹‘¥¹5…Ñ ¡É•Ä°É•Ì°‰½‘ä¤ì4(€€€¥˜€¡…Ñ¥½¸€ôôô€¡•­•ÐµÙ•É¥™äœ¤É•ÑÕÉ¸…Ý…¥Ð¡…¹‘±•¡•­ÑY•É¥™¥…Ñ¥½¸¡É•Ä°É•Ì°‰½‘ä¤ì4(€€€¥˜€¡…Ñ¥½¸€ôôô€±½½­ÕÀµÉ•™•É•¹”œ¤É•ÑÕÉ¸…Ý…¥Ð±½½­ÕÁI•™•É•¹”¡É•Ä°É•Ì°‰½‘ä¤ì4(€€€¥˜€¡…Ñ¥½¸¹ÍÑ…ÉÑÍ]¥Ñ  ±½ÑÑ•Éäµ±•…¹ÕÀ´œ¤¤É•ÑÕÉ¸…Ý…¥Ð¡…¹‘±•1½ÑÑ•Éå±•…¹ÕÀ¡É•Ä°É•Ì°‰½‘ä¤ì4(€€€½¹ÍÐÉ•ÅÕ•ÍÑ%€ôMÑÉ¥¹œ¡‰½‘ä¹É•ÅÕ•ÍÑ%ñð€œœ¤¹ÑÉ¥´ ¤ì4(€€€½¹ÍÐÉ•ÅÕ•ÍÑ•‘1½ÑÑ•Éå%€ôMÑÉ¥¹œ¡‰½‘ä¹±½ÑÑ•Éå%ñð€œœ¤¹ÑÉ¥´ ¤ì4(4(€€€¥˜€ …É•ÅÕ•ÍÑ%¤ì4(€€€€€É•ÑÕÉ¸É•Ì¹ÍÑ…ÑÕÌ ÐÀÀ¤¹©Í½¸¡ì½¬è™…±Í”°•ÉÉ½Èè€É•ÅÕ•ÍÑ%¥ÌÉ•ÅÕ¥É•¸œô¤ì4(€€€ô4(4(€€€¥˜€ …l…ÁÁÉ½Ù”œ°€É•©•Ðœ°€…¹•°t¹¥¹±Õ‘•Ì¡…Ñ¥½¸¤¤ì4(€€€€€É•ÑÕÉ¸É•Ì¹ÍÑ…ÑÕÌ ÐÀÀ¤¹©Í½¸¡ì½¬è™…±Í”°•ÉÉ½Èè€…Ñ¥½¸µÕÍÐ‰”…ÁÁÉ½Ù”°É•©•Ð°½È…¹•°¸œô¤ì4(€€€ô4(4(€€€½¹ÍÐ‘ˆ€ô…‘µ¥¹ˆ ¤ì4(€€€½¹ÍÐì…±±•È°ÁÉ½™¥±”ô€ô…Ý…¥Ð…ÕÑ¡•¹Ñ¥…Ñ•‘µ¥¸¡É•Ä°‘ˆ¤ì4(4(€€€¥˜€¡…Ñ¥½¸€ôôô€…ÁÁÉ½Ù”œ¤ì4(€€€€€½¹ÍÐÉ•ÍÕ±Ð€ô…Ý…¥Ð…ÁÁÉ½Ù•I•ÅÕ•ÍÐ 4(€€€€€€€‘ˆ°4(€€€€€€€…±±•È°4(€€€€€€€ÁÉ½™¥±”°4(€€€€€€€É•ÅÕ•ÍÑ%°4(€€€€€€€É•ÅÕ•ÍÑ•‘1½ÑÑ•Éå%°4(€€€€€€€MÑÉ¥¹œ¡‰½‘ä¹µ…¹Õ…±I•™•É•¹”ñð€œœ¤¹ÑÉ¥´ ¤4(€€€€€€¤ì4(4(€€€€€É•ÑÕÉ¸É•Ì¹ÍÑ…ÑÕÌ ÈÀÀ¤¹©Í½¸¡ì4(€€€€€€€½¬èÑÉÕ”°4(€€€€€€€…ÁÁÉ½Ù•èÑÉÕ”°4(€€€€€€€É•ÅÕ•ÍÐèÉ•ÍÕ±Ð4(€€€€€ô¤ì4(€€€ô4(4(€€€¥˜€¡…Ñ¥½¸€ôôô€É•©•Ðœ¤ì4(€€€€€½¹ÍÐÉ•…Í½¸€ôMÑÉ¥¹œ¡‰½‘ä¹É•…Í½¸ñð€œœ¤¹ÑÉ¥´ ¤¹Í±¥” À°€ÌÀÀ¤ì4(€€€€€¥˜€ …É•…Í½¸¤É•ÑÕÉ¸É•Ì¹ÍÑ…ÑÕÌ ÐÀÀ¤¹©Í½¸¡ì½¬è™…±Í”°•ÉÉ½Èè€I•©•Ñ¥½¸É•…Í½¸É•ÅÕ¥É•¸œô¤ì4(€€€€€…Ý…¥ÐÉ•©•ÑI•ÅÕ•ÍÐ¡‘ˆ°…±±•È°ÁÉ½™¥±”°É•ÅÕ•ÍÑ%°É•ÅÕ•ÍÑ•‘1½ÑÑ•Éå%°É•…Í½¸¤ì4(€€€€€É•ÑÕÉ¸É•Ì¹ÍÑ…ÑÕÌ ÈÀÀ¤¹©Í½¸¡ì½¬èÑÉÕ”°É•©•Ñ•èÑÉÕ”ô¤ì4(€€€ô4(€€€½¹ÍÐÉ•…Í½¸€ôMÑÉ¥¹œ 4(€€€€€‰½‘ä¹É•…Í½¸ñð€ÁÁÉ½Ù•¥¸•ÉÉ½È¸œ4(€€€€¤¹ÑÉ¥´ ¤¹Í±¥” À°€ÌÀÀ¤ñð€ÁÁÉ½Ù•¥¸•ÉÉ½È¸œì4(4(€€€…Ý…¥Ð…¹•±ÁÁÉ½Ù…° 4(€€€€€‘ˆ°4(€€€€€…±±•È°4(€€€€€ÁÉ½™¥±”°4(€€€€€É•ÅÕ•ÍÑ%°4(€€€€€É•…Í½¸4(€€€€¤ì4(4(€€€É•ÑÕÉ¸É•Ì¹ÍÑ…ÑÕÌ ÈÀÀ¤¹©Í½¸¡ì4(€€€€€½¬èÑÉÕ”°4(€€€€€…¹•±±•èÑÉÕ”4(€€€ô¤ì4(€ô…Ñ €¡•ÉÉ½È¤ì4(€€€½¹Í½±”¹•ÉÉ½È …‘µ¥¸…ÁÁÉ½Ù…±Ì•ÉÉ½Èèœ°•ÉÉ½È¤ì4(4(€€€½¹ÍÐµ•ÍÍ…”€ôMÑÉ¥¹œ 4(€€€€€•ÉÉ½Èü¹µ•ÍÍ…”ñð€½Õ±¹½Ð½µÁ±•Ñ”Ñ¡”…ÁÁÉ½Ù…°…Ñ¥½¸¸œ4(€€€€¤ì4(4(€€€½¹ÍÐÍÑ…ÑÕÌ€ô9Õµ‰•È¡•ÉÉ½Èü¹ÍÑ…ÑÕÍ½‘”ñð€À¤ì4(€€€¥˜€¡ÍÑ…ÑÕÌ€øô€ÐÀÀ€˜˜ÍÑ…ÑÕÌ€ð€ÔÀÀ¤ì4(€€€€€É•ÑÕÉ¸É•Ì¹ÍÑ…ÑÕÌ¡ÍÑ…ÑÕÌ¤¹©Í½¸¡ì½¬è™…±Í”°•ÉÉ½Èèµ•ÍÍ…”ô¤ì4(€€€ô4(4(€€€¥˜€ 4(€€€€€•ÉÉ½Èü¹½‘”€ôôô€àñð4(€€€€€µ•ÍÍ…”¹¥¹±Õ‘•Ì IM=UI}a!UMQœ¤ñð4(€€€€€µ•ÍÍ…”¹¥¹±Õ‘•Ì EÕ½Ñ„•á••‘•œ¤4(€€€€¤ì4(€€€€€É•ÑÕÉ¸É•Ì¹ÍÑ…ÑÕÌ ÐÈä¤¹©Í½¸¡ì4(€€€€€€€½¬è™…±Í”°4(€€€€€€€•ÉÉ½Èè€¥É•ÍÑ½É”¥ÌÑ•µÁ½É…É¥±ä½ÕÐ½˜ÅÕ½Ñ„½È…Á…¥Ñä¸A±•…Í”ÑÉäÑ¡”…ÁÁÉ½Ù…°……¥¸…™Ñ•ÈÑ¡”¥É•ÍÑ½É”ÅÕ½Ñ„Ý¥¹‘½ÜÉ•Í•ÑÌ¸œ4(€€€€€ô¤ì4(€€€ô4(4(€€€¥˜€ 4(€€€€€µ•ÍÍ…”¹¥¹±Õ‘•Ì ±É•…‘ä•á¥ÍÑÌœ¤ñð4(€€€€€•ÉÉ½Èü¹½‘”€ôôô€Øñð4(€€€€€•ÉÉ½Èü¹½‘”€ôôô€…±É•…‘äµ•á¥ÍÑÌœ4(€€€€¤ì4(€€€€€É•ÑÕÉ¸É•Ì¹ÍÑ…ÑÕÌ ÐÀä¤¹©Í½¸¡ì4(€€€€€€€½¬è™…±Í”°4(€€€€€€€•ÉÉ½Èè€Ñ¥­•Ðµ¹Õµ‰•È½±±¥Í¥½¸Ý…Ì‘•Ñ•Ñ•¸9¼•á¥ÍÑ¥¹œÑ¥­•ÐÝ…Ì½Ù•ÉÝÉ¥ÑÑ•¸¸A±•…Í”É•Á…¥ÈÑ¡”±½ÑÑ•Éä½Õ¹Ñ•È‰•™½É”…ÁÁÉ½Ù¥¹œÑ¡¥ÌÉ•ÅÕ•ÍÐ¸œ4(€€€€€ô¤ì4(€€€ô4(4(€€€¥˜€ 4(€€€€€µ•ÍÍ…”€ôôô€I•ÅÕ•ÍÐ¹½Ð™½Õ¹¸œñð4(€€€€€µ•ÍÍ…”€ôôô€1½ÑÑ•Éä¹½Ð™½Õ¹¸œñð4(€€€€€µ•ÍÍ…”€ôôô€Q¡¥ÌÉ•ÅÕ•ÍÐ¡…Ì…±É•…‘ä‰••¸É•Ù¥•Ý•¸œñð4(€€€€€µ•ÍÍ…”€ôôô€=¹±ä…ÁÁÉ½Ù•É•ÅÕ•ÍÑÌ…¸‰”…¹•±±•¸œ4(€€€€¤ì4(€€€€€É•ÑÕÉ¸É•Ì¹ÍÑ…ÑÕÌ ÐÀä¤¹©Í½¸¡ì½¬è™…±Í”°•ÉÉ½Èèµ•ÍÍ…”ô¤ì4(€€€ô4(4(€€€É•ÑÕÉ¸É•Ì¹ÍÑ…ÑÕÌ ÔÀÀ¤¹©Í½¸¡ì4(€€€€€½¬è™…±Í”°4(€€€€€•ÉÉ½Èèµ•ÍÍ…”4(€€€ô¤ì4(€ô4)ôì4(4(¼¼áÁ½Í”Ñ¡”Í…µ”ÁÉ½‘ÕÑ¥½¸ÑÉ…¹Í…Ñ¥½¸™Õ¹Ñ¥½¸½¹±äÑ¼¥É•‰…Í”•µÕ±…Ñ½ÈÑ•ÍÑÌ¸4(¼¼9•Ù•È…‘…¸Õ¹…ÕÑ¡•¹Ñ¥…Ñ•!QQ@…Ñ¥½¸™½ÈÑ¡¥Ì¡•±Á•È¸4)¥˜€¡ÁÉ½•ÍÌ¹•¹Ø¹%IMQ=I}5U1Q=I}!=MP¤µ½‘Õ±”¹•áÁ½ÉÑÌ¹}…ÁÁÉ½Ù•I•ÅÕ•ÍÑ½ÉµÕ±…Ñ½È€ô…ÁÁÉ½Ù•I•ÅÕ•ÍÐì4(