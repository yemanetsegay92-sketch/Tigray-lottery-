# CBE event-driven approval rollout

## Why the worker still exists

The trusted Vercel worker checks an official CBE response, verifies the configured
recipient and total, guards against reused references, stores immutable evidence,
and atomically issues ticket numbers. Eventarc/Firebase is ONLY a trigger: it does
not receive bank credentials, decide approvals, or write tickets.

## Paths

- Primary: `autoPaymentQueue/{requestId}` document created on eligible checkout
  -> Cloud Functions (2nd gen) `dispatchCbeAutoApproval`
  -> secret-authenticated `cbe-auto-worker-one` action
  -> lease that exact queue record -> existing `processOne` and atomic approval.
- Backup: existing GitHub Actions `cbe-auto-worker` batch scans pending and
  expired leases. Keep it enabled, but independently verify scheduled executions.
- Firebase events can be delivered more than once. The queue transaction lease,
  payment reference claim, immutable saved evidence, and ticket transaction
  continue to protect against double charges/approvals.

## Before deployment

1. Confirm production Vercel has deployed the merged new API route and passes
   the existing CBE tests. Do NOT deploy the Firebase trigger first.
2. Confirm Firebase project ID is **tigiray-lottery** (exact spelling from
   `.firebaserc`) and is the Firestore project used by production. Never deploy
   to an unrelated Firebase connection. Check `firebase projects:list`.
3. Cloud Functions (2nd gen) requires Firebase Blaze billing, with Eventarc,
   Cloud Build, Artifact Registry and Cloud Run APIs available. Check quotas
   and set Google Cloud billing alerts. Run only the named function deployment.
4. The Firebase Secret Manager entry
   `LOTTERY_CBE_AUTO_APPROVAL_CRON_SECRET` must have the **same 32+ byte value**
   as the Vercel Production environment variable with that name. Never commit,
   email, or paste the secret into a conversation. GitHub's secret of this name
   should also match. If the original secret is no longer known, rotate all
   three destinations together while keeping the workflow paused.
5. The protected existing Vercel configuration still controls which lotteries
   and bank accounts may auto-approve. Never add unverified accounts to allowlists.

## Deploy from a trusted PC with Firebase CLI

From the repository root after the PR is merged:

```bash
npm install --prefix functions
npm test --prefix functions
firebase login
firebase projects:list
firebase functions:secrets:set LOTTERY_CBE_AUTO_APPROVAL_CRON_SECRET --project tigiray-lottery
firebase deploy --only functions:dispatchCbeAutoApproval --project tigiray-lottery
```

The `functions:secrets:set` command securely prompts for the already-configured
secret value. Do not enter an arbitrary new value without coordinating a
rotation with Vercel and GitHub. The Firebase CLI may ask to enable APIs or
configure billing. Reject deployment if the project ID is wrong.

## Acceptance

1. Confirm the new Firebase function exists in **tigiray-lottery** and logs
   show a queue event. Do not reuse an already-approved reference.
2. In one eligible, configured, active automatic-approval lottery, submit one
   *new, real* CBE transaction only when a controlled paid test is authorized.
3. Expect a queue event, successful worker invocation and ticket approval
   without manual admin action. Confirm Telegram notification.
4. Confirm one ticket allocation, one payment claim and one notification
   despite duplicate event delivery or a simultaneous scheduled worker.
5. Test a wrong recipient/reference/amount with **mocked** data/emulator only.
   Such requests must stay pending or go to manual review, never be auto-approved.
6. Check GitHub Actions event `schedule` appears for the backup, or replace it
   with a reliable scheduled recovery path (Cloud Scheduler) before relying
   on the full system for unattended operations.

## Operational limitations

- New queue documents trigger the event; existing pending entries created
  before the Firebase function is deployed will NOT retrigger. The batch worker
  remains the recovery route.
- A transient worker/API failure does not reverify a payment blindly. Event
  retries are disabled; the recovery worker handles pending/expired leases,
  and provider-uncertain outcomes require manual review.
- This is near-real-time, not guaranteed instantaneous. Cold starts and bank
  provider latency can add delays.
- No function is deployed by merging this code. Deployment is a separate
  explicit Firebase CLI step on the correct project.
