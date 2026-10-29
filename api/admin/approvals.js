const crypto = require('crypto');
const { adminDb, FieldValue } = require('../telegram/_lib');
const { getAuth } = require('firebase-admin/auth');
const { getStorage } = require('firebase-admin/storage');

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

async function approveRequest(db, caller, profile, requestId, requestedLotteryId) {
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

    const lotteryRef = db.collection('lotteries').doc(lotteryId);
    const lotterySnap = await tx.get(lotteryRef);

    if (!lotterySnap.exists) throw new Error('Lottery not found.');

    const lottery = lotterySnap.data() || {};
    if (lottery.cleanupInProgress === true) throw new Error('Lottery cleanup is in progress. Approvals are disabled.');
    assertLotteryAccess(profile, lotteryId);

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
      phoneHash
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
      action: 'approveRequest',
      lotteryId,
      requestId,
      adminId: caller.uid,
      ticketNumbers,
      quantity,
      createdAt: now
    });

    result = {
      lotteryId,
      lotteryName: String(lottery.name || lotteryId),
      name: String(request.name || ''),
      phone: String(request.phone || ''),
      reference: String(request.reference || ''),
      quantity,
      total: Number(request.total || 0),
      phoneHash,
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
    const lotteryId = String(request.lotteryId || '');
    if (requestedLotteryId && requestedLotteryId !== lotteryId) {
      throw new Error('Request does not belong to the selected lottery.');
    }
    assertLotteryAccess(profile, lotteryId);
    const selectedLottery = await tx.get(db.collection('lotteries').doc(lotteryId));
    if (!selectedLottery.exists || selectedLottery.data().cleanupInProgress === true) {
      throw new Error('Lottery cleanup is in progress. Payment decisions are disabled.');
    }
    if (request.status !== 'pending') throw new Error('This request has already been reviewed.');
    const now = FieldValue.serverTimestamp();
    tx.update(ref, {
      status: 'rejected', rejectionReason: reason,
      reviewedBy: caller.uid, reviewedAt: now
    });
    const phone = normalizePhone(request.phone);
    const phoneHash = String(request.phoneHash || sha256(phone));
    tx.set(db.collection('publicStatus').doc(phoneHash).collection('requests').doc(requestId), {
      lotteryId, status: 'rejected', rejectionReason: reason, reviewedAt: now
    }, { merge: true });
    tx.create(db.collection('buyerNotificationQueue').doc(requestId + '_rejected'), {
      requestId, lotteryId, decision: 'rejected', state: 'pending',
      attempts: 0, nextAttemptAt: now, createdAt: now
    });
    tx.create(db.collection('auditLogs').doc(), {
      action: 'rejectRequest', lotteryId, requestId, adminId: caller.uid,
      rejectionReason: reason, createdAt: now
    });
  });
}

// Admin-authenticated, short-lived read link. Private bucket rules stay deny-all;
// only a verified admin assigned to this lottery may obtain the signed URL.
// Actual receipt bytes travel Storage -> browser, not Storage -> Vercel -> browser.
async function servePaymentReceipt(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const requestId = String(req.query?.requestId || '').trim();
    if (!/^[a-f0-9]{40}$/.test(requestId)) {
      return res.status(400).json({ ok: false, error: 'Invalid request ID.' });
    }
    const db = adminDb();
    const { profile } = await authenticateAdmin(req, db);
    const snap = await db.collection('ticketRequests').doc(requestId).get();
    if (!snap.exists) return res.status(404).json({ ok: false, error: 'Request not found.' });
    const data = snap.data() || {};
    const lotteryId = String(data.lotteryId || '');
    assertLotteryAccess(profile, lotteryId);
    const path = String(data.proofPath || '');
    if (!path || !path.startsWith('payment-proofs/' + encodeURIComponent(lotteryId) + '/') ||
        path.includes('..') || path.includes('\\')) {
      return res.status(404).json({ ok: false, error: 'Receipt not found.' });
    }
    const bucket = getStorage().bucket('tigiray-lottery.firebasestorage.app');
    const file = bucket.file(path);
    const [metadata] = await file.getMetadata();
    const bytes = Number(metadata.size);
    const mime = String(data.proofMime || '');
    if (!['image/jpeg', 'image/png', 'image/webp', 'application/pdf'].includes(mime) ||
        mime !== metadata.contentType || !Number.isSafeInteger(bytes) || bytes < 1 ||
        bytes > (mime === 'application/pdf' ? 2 * 1024 * 1024 : 420 * 1024)) {
      return res.status(409).json({ ok: false, error: 'Receipt metadata is invalid.' });
    }
    const [url] = await file.getSignedUrl({
      action: 'read',
      expires: Date.now() + 60 * 1000,
      responseDisposition: 'attachment'
    });
    return res.status(200).json({ ok: true, url, mime, expiresInSeconds: 60 });
  } catch (error) {
    const status = Number(error?.statusCode || 0);
    if (status >= 400 && status < 500) {
      return res.status(status).json({ ok: false, error: error.message });
    }
    if (error?.code === 404) return res.status(404).json({ ok: false, error: 'Receipt not found.' });
    if (error?.message === 'You are not assigned to this lottery.') {
      return res.status(403).json({ ok: false, error: 'Not authorized for this lottery.' });
    }
    console.error('payment receipt read authorization failed', error);
    return res.status(500).json({ ok: false, error: 'Could not access the receipt.' });
  }
}

// Verify that a reference belongs to a lottery this caller is allowed to
// manage. Server-side lookup distinguishes a missing document (404) from an
// actual permissions failure (403), unlike client Firestore security rules.
async function lookupReference(req, res, body) {
  res.setHeader('Cache-Control', 'no-store');
  const lotteryId = String(body.lotteryId || '').trim();
  const reference = String(body.reference || '').trim();
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(lotteryId) || !reference || reference.length > 180) {
    return res.status(400).json({ ok: false, error: 'Provide the selected lottery and an exact payment reference.' });
  }

  const db = adminDb();
  const { profile } = await authenticateAdmin(req, db);
  if (profile.role === 'lotteryAdmin' &&
      !(Array.isArray(profile.lotteryIds) && profile.lotteryIds.includes(lotteryId))) {
    return res.status(403).json({ ok: false, error: 'You are not assigned to this lottery.' });
  }

  const requestId = sha256('REF:' + reference.toUpperCase()).slice(0, 40);
  const snap = await db.collection('ticketRequests').doc(requestId).get();
  if (!snap.exists || snap.data()?.lotteryId !== lotteryId) {
    return res.status(404).json({
      ok: false, code: 'PAYMENT_NOT_FOUND',
      error: 'No payment found for this reference in the selected lottery. Check the number and try again.'
    });
  }
  const data = snap.data() || {};
  return res.status(200).json({
    ok: true, request: {
      id: requestId,
      name: String(data.name || ''),
      phone: String(data.phone || ''),
      reference: String(data.reference || reference),
      status: String(data.status || 'pending'),
      quantity: Number(data.quantity || 1),
      total: Number(data.total || 0),
      proofMime: String(data.proofMime || ''),
      hasProof: Boolean(data.proofPath),
      createdAt: data.createdAt?.toDate?.().toISOString() || null
    }
  });
}


// General-Admin-only, resumable test-lottery cleanup. It never transfers
// receipt image bytes via Vercel. This deliberately uses an existing API
// function so Hobby deployments do not acquire an additional function.
const CLEANUP_PHASES = [
  'requests', 'tickets', 'receiptClaims', 'notifications', 'auditLogs',
  'finalProofs', 'incomingProofs', 'adminAssignments', 'finish'
];
const CLEANUP_BATCH = 30;
function cleanupFailure(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}
async function cleanupCount(collectionRef, field, value) {
  return Number((await collectionRef.where(field, '==', value).count().get()).data().count || 0);
}
async function cleanupPreview(db, lotteryId, lotterySnap) {
  const [requests, approved, tickets, claims, notifications, auditLogs] = await Promise.all([
    cleanupCount(db.collection('ticketRequests'), 'lotteryId', lotteryId),
    Number((await db.collection('ticketRequests').where('lotteryId','==',lotteryId)
      .where('status','==','approved').count().get()).data().count || 0),
    cleanupCount(db.collection('tickets'), 'lotteryId', lotteryId),
    cleanupCount(db.collection('receiptUploadClaims'), 'lotteryId', lotteryId),
    cleanupCount(db.collection('buyerNotificationQueue'), 'lotteryId', lotteryId),
    cleanupCount(db.collection('auditLogs'), 'lotteryId', lotteryId)
  ]);
  return {
    lotteryId, name: String(lotterySnap.data().name || lotteryId),
    lotteryStatus: String(lotterySnap.data().status || ''),
    cleanupInProgress: lotterySnap.data().cleanupInProgress === true,
    cleanupPhase: String(lotterySnap.data().cleanupPhase || ''),
    requests, approved, tickets, claims, notifications, auditLogs,
    warning: 'Deletes all related records in this lottery, including real transactions. User accounts are preserved. Historical lottery audit entries are removed; a deletion certificate remains.'
  };
}
async function cleanupDeleteDocuments(db, refs) {
  const unique = [...new Map(refs.map(ref => [ref.path, ref])).values()];
  if (!unique.length) return 0;
  // Small atomic batches, not one Vercel request per document.
  // Firebase itself enforces any remaining free-plan quotas.
  const batch = db.batch();
  for (const ref of unique) batch.delete(ref);
  await batch.commit();
  return unique.length;
}
async function cleanupStep(db, lotteryId, lotteryRef, data) {
  const phase = String(data.cleanupPhase || 'requests');
  const nextPhase = async () => {
    const index = CLEANUP_PHASES.indexOf(phase);
    if (index < 0 || index === CLEANUP_PHASES.length - 1)
      throw cleanupFailure('Invalid cleanup phase. Contact technical support.');
    const next = CLEANUP_PHASES[index+1];
    await lotteryRef.update({ cleanupPhase: next });
    return { ok:true, phase:next, advanced:true, processed:0, deletedDocuments:0 };
  };
  const collections = {
    requests:'ticketRequests', tickets:'tickets',
    receiptClaims:'receiptUploadClaims', notifications:'buyerNotificationQueue', auditLogs:'auditLogs'
  };
  if (collections[phase]) {
    const snap = await db.collection(collections[phase]).where('lotteryId','==',lotteryId)
      .limit(CLEANUP_BATCH).get();
    if (snap.empty) return nextPhase();
    const proofPaths = [];
    if (phase === 'requests') {
      for (const requestDoc of snap.docs) {
        const proofPath = String(requestDoc.data().proofPath || '');
        if (proofPath) {
          const prefix = 'payment-proofs/' + encodeURIComponent(lotteryId) + '/';
          if (!proofPath.startsWith(prefix) || proofPath.includes('..') || proofPath.includes('\\')) {
            throw cleanupFailure('Unsafe receipt path in request ' + requestDoc.id + '. Cleanup stopped.');
          }
          proofPaths.push(proofPath);
        }
      }
    }
    const refs = [];
    for (const item of snap.docs) {
      refs.push(item.ref);
      if (phase === 'requests') {
        const record = item.data();
        const phoneHash = String(record.phoneHash || '') || sha256(normalizePhone(record.phone));
        if (!/^[a-f0-9]{64}$/.test(phoneHash)) {
          throw cleanupFailure('Invalid phone hash in request ' + item.id + '. Cleanup stopped.');
        }
        refs.push(db.collection('publicStatus').doc(phoneHash).collection('requests').doc(item.id));
      }
    }
    const deletedDocuments = await cleanupDeleteDocuments(db, refs);
    // Delete proof objects only after the database batch commits. If GCS removal
    // fails, finalProofs later sweeps this lottery prefix, so cleanup is resumable.
    if (proofPaths.length) {
      const bucket = getStorage().bucket('tigiray-lottery.firebasestorage.app');
      await Promise.all(proofPaths.map(path => bucket.file(path).delete({ignoreNotFound:true})));
    }
    return { ok:true, phase, processed:snap.size, deletedDocuments, removedFiles:proofPaths.length };
  }
  if (phase === 'finalProofs' || phase === 'incomingProofs') {
    const prefix = (phase === 'finalProofs' ? 'payment-proofs/' : 'payment-proof-incoming/') +
      encodeURIComponent(lotteryId) + '/';
    const [files] = await getStorage().bucket('tigiray-lottery.firebasestorage.app').getFiles({
      prefix, autoPaginate:false, maxResults:CLEANUP_BATCH
    });
    if (!files.length) return nextPhase();
    await Promise.all(files.map(file => file.delete({ ignoreNotFound:true })));
    return { ok:true, phase, processed:files.length, deletedDocuments:0, removedFiles:files.length };
  }
  if (phase === 'adminAssignments') {
    const snap = await db.collection('users').where('lotteryIds','array-contains',lotteryId)
      .limit(CLEANUP_BATCH).get();
    if (snap.empty) return nextPhase();
    const batch = db.batch();
    snap.forEach(item => batch.update(item.ref, { lotteryIds: FieldValue.arrayRemove(lotteryId) }));
    await batch.commit();
    return { ok:true, phase, processed:snap.size, deletedDocuments:0 };
  }
  if (phase === 'finish') {
    // A previously issued signed Storage POST remains usable for up to 10
    // minutes. Do a final incoming-file sweep only after those policies expire.
    const started = data.cleanupStartedAt?.toMillis?.() || 0;
    const safeAt = started + 11 * 60 * 1000;
    if (started && Date.now() < safeAt) {
      await lotteryRef.update({ cleanupPhase:'incomingProofs' });
      return { ok:true, phase:'incomingProofs', paused:true,
        waitingUntil:new Date(safeAt).toISOString(), processed:0, deletedDocuments:0 };
    }
    const proofBucket = getStorage().bucket('tigiray-lottery.firebasestorage.app');
    const [requests, tickets, claims, notifications, admins, audit, finals, incoming] = await Promise.all([
      db.collection('ticketRequests').where('lotteryId','==',lotteryId).limit(1).get(),
      db.collection('tickets').where('lotteryId','==',lotteryId).limit(1).get(),
      db.collection('receiptUploadClaims').where('lotteryId','==',lotteryId).limit(1).get(),
      db.collection('buyerNotificationQueue').where('lotteryId','==',lotteryId).limit(1).get(),
      db.collection('users').where('lotteryIds','array-contains',lotteryId).limit(1).get(),
      db.collection('auditLogs').where('lotteryId','==',lotteryId).limit(1).get(),
      proofBucket.getFiles({prefix:'payment-proofs/'+encodeURIComponent(lotteryId)+'/',autoPaginate:false,maxResults:1}),
      proofBucket.getFiles({prefix:'payment-proof-incoming/'+encodeURIComponent(lotteryId)+'/',autoPaginate:false,maxResults:1})
    ]);
    if ([requests,tickets,claims,notifications,admins,audit].some(x => !x.empty) ||
        finals[0].length || incoming[0].length) {
      await lotteryRef.update({ cleanupPhase:'requests' });
      return { ok:true, phase:'requests', advanced:true, processed:0, deletedDocuments:0 };
    }
    const batch = db.batch();
    batch.delete(lotteryRef);
    batch.create(db.collection('auditLogs').doc(), {
      action:'fullLotteryCleanup', lotteryId, lotteryName:String(data.name || ''),
      startedBy:String(data.cleanupStartedBy || ''), finishedAt:FieldValue.serverTimestamp(),
      note:'Deleted linked lottery data, including historical lottery audit entries. Minimal deletion certificate retained.'
    });
    await batch.commit();
    return { ok:true, done:true, phase:'done', processed:0, deletedDocuments:1 };
  }
  throw cleanupFailure('Unknown cleanup phase. Cleanup stopped.');
}
async function handleLotteryCleanup(req, res, body) {
  res.setHeader('Cache-Control','no-store');
  const action = String(body.action || '');
  const lotteryId = String(body.lotteryId || '').trim();
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(lotteryId)) throw cleanupFailure('Invalid lottery ID.');
  const db = adminDb();
  const { caller, profile } = await authenticateAdmin(req, db);
  if (profile.role !== 'generalAdmin') throw cleanupFailure('Only General Admin can delete lotteries.', 403);
  const lotteryRef = db.collection('lotteries').doc(lotteryId);
  const snap = await lotteryRef.get();
  if (!snap.exists) return res.status(404).json({ ok:false, error:'Lottery not found or already deleted.' });
  if (action === 'lottery-cleanup-preview') {
    return res.status(200).json({ ok:true, ...(await cleanupPreview(db,lotteryId,snap)) });
  }
  if (action === 'lottery-cleanup-start') {
    if (body.confirm !== 'DELETE ' + lotteryId || body.acceptIrreversible !== true) {
      throw cleanupFailure('Type DELETE and the full lottery ID to confirm irreversible deletion.');
    }
    await db.runTransaction(async tx => {
      const current = await tx.get(lotteryRef);
      if (!current.exists) throw cleanupFailure('Lottery no longer exists.',404);
      if (current.data().cleanupInProgress) return;
      tx.update(lotteryRef, {
        cleanupInProgress:true, cleanupPhase:'requests', status:'closed',
        cleanupStartedBy:caller.uid, cleanupStartedAt:FieldValue.serverTimestamp()
      });
    });
    return res.status(200).json({ ok:true, started:true });
  }
  if (action === 'lottery-cleanup-step') {
    if (snap.data().cleanupInProgress !== true) {
      throw cleanupFailure('Cleanup was not started or the lottery has already been removed.',409);
    }
    return res.status(200).json(await cleanupStep(db,lotteryId,lotteryRef,snap.data()));
  }
  throw cleanupFailure('Unsupported cleanup action.');
}

// Preview-only manual verification: no Firestore mutations or ticket approval.
async function handleCheckEtVerification(req, res, body) {
  res.setHeader('Cache-Control', 'no-store');
  const db = adminDb();
  const { profile } = await authenticateAdmin(req, db);
  if (profile.role !== 'generalAdmin') {
    return res.status(403).json({ ok:false, error:'Only General Admin can test payment verification.' });
  }
  const { verifyCheckEtPayment } = require('../../lib/checket-verify');
  const result = await verifyCheckEtPayment(body);
  return res.status(200).json({ ok:true, ...result });
}

module.exports = async (req, res) => {
  if (req.method === 'GET' && String(req.query?.receipt || '') === '1') {
    return servePaymentReceipt(req, res);
  }
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Method not allowed.' });
  }

  try {
    const body = readBody(req);
    const action = String(body.action || '').trim().toLowerCase();
    if (action === 'checket-verify') return await handleCheckEtVerification(req, res, body);
    if (action === 'lookup-reference') return await lookupReference(req, res, body);
    if (action.startsWith('lottery-cleanup-')) return await handleLotteryCleanup(req, res, body);
    const requestId = String(body.requestId || '').trim();
    const requestedLotteryId = String(body.lotteryId || '').trim();

    if (!requestId) {
      return res.status(400).json({ ok: false, error: 'requestId is required.' });
    }

    if (!['approve', 'reject', 'cancel'].includes(action)) {
      return res.status(400).json({ ok: false, error: 'action must be approve, reject, or cancel.' });
    }

    const db = adminDb();
    const { caller, profile } = await authenticateAdmin(req, db);

    if (action === 'approve') {
      const result = await approveRequest(
        db,
        caller,
        profile,
        requestId,
        requestedLotteryId
      );

      return res.status(200).json({
        ok: true,
        approved: true,
        request: result
      });
    }

    if (action === 'reject') {
      const reason = String(body.reason || '').trim().slice(0, 300);
      if (!reason) return res.status(400).json({ ok: false, error: 'Rejection reason required.' });
      await rejectRequest(db, caller, profile, requestId, requestedLotteryId, reason);
      return res.status(200).json({ ok: true, rejected: true });
    }
    const reason = String(
      body.reason || 'Approved in error.'
    ).trim().slice(0, 300) || 'Approved in error.';

    await cancelApproval(
      db,
      caller,
      profile,
      requestId,
      reason
    );

    return res.status(200).json({
      ok: true,
      cancelled: true
    });
  } catch (error) {
    console.error('admin approvals error:', error);

    const message = String(
      error?.message || 'Could not complete the approval action.'
    );

    const status = Number(error?.statusCode || 0);
    if (status >= 400 && status < 500) {
      return res.status(status).json({ ok: false, error: message });
    }

    if (
      error?.code === 8 ||
      message.includes('RESOURCE_EXHAUSTED') ||
      message.includes('Quota exceeded')
    ) {
      return res.status(429).json({
        ok: false,
        error: 'Firestore is temporarily out of quota or capacity. Please try the approval again after the Firestore quota window resets.'
      });
    }

    if (
      message.includes('Already exists') ||
      error?.code === 6 ||
      error?.code === 'already-exists'
    ) {
      return res.status(409).json({
        ok: false,
        error: 'A ticket-number collision was detected. No existing ticket was overwritten. Please repair the lottery counter before approving this request.'
      });
    }

    if (
      message === 'Request not found.' ||
      message === 'Lottery not found.' ||
      message === 'This request has already been reviewed.' ||
      message === 'Only approved requests can be cancelled.'
    ) {
      return res.status(409).json({ ok: false, error: message });
    }

    return res.status(500).json({
      ok: false,
      error: message
    });
  }
};
