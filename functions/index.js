'use strict';

const { onDocumentCreated } = require('firebase-functions/v2/firestore');
const { defineSecret } = require('firebase-functions/params');
const logger = require('firebase-functions/logger');
const { dispatchQueuedCbePayment } = require('./dispatch');

// Must contain the SAME value as the production Vercel secret. Never expose
// this value to browsers, GitHub Actions logs, or source code.
const cbeWorkerSecret = defineSecret('LOTTERY_CBE_AUTO_APPROVAL_CRON_SECRET');

// An eligible checkout already creates this queue record in the same Firestore
// transaction as the ticket request. Only new records initiate a dispatch.
// Existing leases, manual review and bank verification remain in Vercel.
exports.dispatchCbeAutoApproval = onDocumentCreated({
  document: 'autoPaymentQueue/{requestId}',
  region: 'us-central1',
  secrets: [cbeWorkerSecret],
  timeoutSeconds: 120,
  memory: '256MiB',
  maxInstances: 20,
  concurrency: 10,
  retry: false
}, async (event) => {
  const requestId = event.params?.requestId;
  const queue = event.data?.data();
  if (!queue || queue.state !== 'pending' || queue.requestId !== requestId) return;

  // The event may be delivered more than once. The protected Vercel endpoint
  // atomically leases this request and blocks duplicate approval.
  const report = await dispatchQueuedCbePayment(requestId, cbeWorkerSecret.value());
  logger.info('CBE queue dispatch completed', {
    processed: report.processed,
    approved: report.approved,
    manual_review: report.manual_review,
    retry: report.retry
  });
});
