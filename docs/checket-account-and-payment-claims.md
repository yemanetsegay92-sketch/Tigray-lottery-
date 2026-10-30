# CBE receiving-account verification and one-payment/one-ticket-approval ledger (staged)

This PR contains the production worker, but release gates keep automatic ticket approval **disabled** until the reviewed production configuration is intentionally activated.

## CBE receiving account — two distinct claims

Check.et's public CBE guide says that it checks the FT reference together with the **full receiving CBE account** supplied with the API request: https://check.et/guides/how-to-verify-cbe-transactions

The bank receipt may nevertheless show only a masked value such as **4278. Matching the visible last four digits does **not** independently establish a complete account match.

The adapter therefore keeps two fields separate:
- `receiverAccountStatus`: `exact_match`, `mismatch`, `masked_unverifiable`, `masked_suffix_mismatch`, or `not_returned`.
- `providerCbeAccountCheck`: whether an **official, successful non-duplicate CBE verification** was performed with the supplied full account, according to the provider contract.

A provider-side check is still subject to a critical integration gate: use **a fresh, previously unverified, real CBE reference** with a deliberately wrong receiving account first. Check.et must return not-found/unverified for the wrong account, and succeed when tested with the actual receiving account. Do not spend an existing approved receipt with a wrong account: the provider's branch-scoped duplicate cache may give an ambiguous answer. Verify with the provider how it handles duplicate queries with a changed receiving account. Never enable automatic approval based solely on a masked match or an untested assumption.

## Our payment-claim ledger

`lib/payment-claims.js` derives a **bank-independent** SHA-256 ID from the normalized reference because legacy tickets do not store an immutable bank code. A rare cross-bank reference collision will be conservatively held for manual review.

On an authorized **manual approval**, the trusted server:
1. Loads the pending request and matching lottery.
2. Requires a canonical reference, prompting the admin to transcribe it from a receipt-only screenshot/PDF.
3. Loads the permanent `paymentClaims/<hash>` claim.
4. Rejects a claim already in use with HTTP 409.
5. In **the same Firestore transaction**, creates the claim, allocates ticket documents, increments the lottery counter, updates the request, and queues the buyer notification.

Transactions that fail midway do not consume a claim or issue partial tickets. Cancelling the approval **does not free the payment claim**, and the claim is not removed by ordinary lottery cleanup. It contains request ID, lottery ID, timestamp, admin ID and status, but not the raw bank reference or customer name.

**Important:** No existing payment-claim records are created merely by Preview verification. Claims begin only when approvals are made through the updated approve endpoint. A current 100 ETB payment predates this cutover and remains pending; it must not be automatically approved. Start with a new strictly timestamped production cutover instead of migrating old transactions. Both the ticket request creation time and the bank payment time must be on or after the configured launch date; the Firestore claim ledger remains mandatory for every new approval. Do not delete prior claims or allow old receipts to auto-approve.

## Other gates before production

- The production Firestore rules now forbid **client-side ticketRequests update** and explicitly deny client reads/writes to paymentClaims. Ruleset `9393a31d-6bd8-44bf-b388-39beb7d2fb5e` was released to the confirmed `tigiray-lottery` project on October 30, 2026 and verified byte-for-byte against this file.
- A small number of orders have no bank reference until a staff member reads a receipt; they cannot safely be approved on this new flow without a reference.
- The Check.et key may be stored in Vercel Preview and Production, but it cannot activate the worker by itself.
- No automatic approval is enabled; CBE matches remain advisory only.
- The checkout and any older admin/deployment path that could issue tickets should be reviewed to ensure **all approvals route through the claim-aware transaction**.
- A false/missing provider response, stale transfer, duplicate, unmatched amount/account or missing date always requires review.
- Avoid repeatedly verifying the same receipt: Check.et free verifications may be limited.

## PDF and screenshot verification (new Preview test)

- Customer uploads still go **browser → private Firebase Storage**, unchanged. There is no second upload by the buyer.
- On the General Admin Preview dashboard, select a lottery and configured CBE receiver, then **Test uploaded receipt** on an existing pending purchase. Lottery Admin also has **Verify PDF / screenshot (test)** beside a pending request.
- The server checks its Firebase Auth/lottery permissions, reads the finalized `proofPath` from the stored purchase (never from a browser-selected URL), checks stored content type, max bytes (PDF 2 MiB; image 420 KiB), and file signature, and sends a multipart `receipt_file` field **directly from the server to Check.et**.
- The full configured CBE account is sent as `account_number`. We do not perform OCR locally. Check.et documents direct PDF parsing; **image files may require `receipt_text`**, so we intentionally try the direct image input and show a safe error if unsupported.
- Provider response is compared against the existing pending request's expected amount, date, bank, and configured account. The **bank-extracted transaction reference** is shown for manual reconciliation and checked against our payment claim ledger. No reference returned → still manual review.
- No ticket status, claim, receipt or other Firestore data is changed by these test actions. No automatic approval is enabled.
- Important: The original PDF/screenshot is transmitted to Check.et for verification and handled under its data processing policy. Before a public rollout, disclose this to buyers and confirm the provider's retention/privacy terms.
- The untrusted file never travels from Storage through Vercel's CDN to a browser in this flow, though downloading it into a server function and forwarding it to Check.et can still incur Google Cloud egress and provider bandwidth.
- We only unit-tested with synthetic PDF/image bytes and mocked provider responses. **The live PDF and screenshot API flows have NOT yet been verified with a customer's actual existing receipt.**

## Automatic CBE approvals (code added; DISABLED in every deployment)

**Positive tests:** bank references, official PDF receipts and both PDF screenshots and USSD confirmation screenshots have returned Check.et official CBE payment data in Preview. This validates image reading without our own OCR for those test formats; not all banking apps/images are covered.

### Per-lottery creation choice

- The General Admin now chooses **Manual approval** or **Automatic CBE approval** while creating a lottery. Manual is the default.
- The choice is immutable after creation. Changing the method requires a new lottery, preventing an existing payment history from being silently moved into unattended processing.
- Every legacy lottery that lacks `approvalMode` is treated as manual forever. No migration or backfill is performed, so the old pending 100 ETB request remains manual.
- Automatic mode is necessary but not sufficient: queue creation, worker inspection, and the final atomic issuance transaction each require it, while the production allowlist, exact account binding, future cutover, global enable flag, Check.et key, worker secret, and scheduler remain independent fail-closed controls.
- After creating the first automatic lottery, record its exact Firestore ID and review its CBE account before enabling the production worker for that ID. Do not reuse the prior test lottery's allowlist entry.

Automatic approval is **not live**. The production worker is implemented but stays inaccessible unless ALL of the following independently controlled Vercel environment variables are set **after a security release review**:

- `CHECK_ET_API_KEY` with permission to verify real payments. It is now stored for Preview and Production, but the key alone cannot queue or approve anything.
- `LOTTERY_CBE_AUTO_APPROVAL_ENABLED=true`.
- `LOTTERY_CBE_AUTO_APPROVAL_START_AT`: a new **explicit** launch timestamp with time zone (e.g. `2026-11-02T10:00:00+03:00`). The timestamp MUST be set to the actual future activation date, not an earlier time. Only purchases **and** bank transfers occurring on/after this cutoff can qualify; previous test transactions are ineligible.
- `LOTTERY_CBE_AUTO_APPROVAL_LOTTERY_IDS` containing the exact CBE-enabled lottery ID(s), comma-separated; start with exactly one reviewed lottery.
- `LOTTERY_CBE_AUTO_APPROVAL_ACCOUNT_BINDINGS`: a sensitive JSON object binding each allowlisted lottery ID to its full reviewed CBE account number. The current Firestore account must match this production-only value, so a browser admin cannot redirect unattended verification by editing the lottery document.
- `LOTTERY_CBE_AUTO_APPROVAL_CRON_SECRET`, an unpredictable random secret **32+ bytes** used to authenticate the worker.

The opt-in GitHub Actions scheduler in this PR posts `{"action":"cbe-auto-worker"}` to the **production** `/api/admin/approvals` endpoint using `Authorization: Bearer <secret>`. It remains inert unless the matching repository secret exists and `LOTTERY_CBE_CRON_ENABLED=true`. Vercel Preview always rejects worker approval, even though it connects to the same Firebase database.

Keep `LOTTERY_CBE_AUTO_APPROVAL_ENABLED=false`, omit the activation timestamp, and keep the scheduler variable false until the production rules release and post-deploy verification are complete. Check.et quotas and commercial/API conditions must also be confirmed before rollout.

### Workflow when correctly activated

1. Checkout creates a `pending` ticket request as before, plus an `autoPaymentQueue/<requestId>` work item **only** when the lottery was created in Automatic CBE mode, is allowlisted in production, and has exactly one configured valid CBE account and bank holder name.
2. Scheduler calls the secret-authenticated batch worker on the existing approvals Vercel function. A Firestore lease prevents simultaneous workers from handling the same queue item. Pre-cutover purchases are held for manual review **without another Check.et call**.
3. The worker requires the lottery's CBE account to equal the **production-only account binding**, then sends either the bank reference OR the existing private PDF/image to Check.et with that account.
4. Strict checks: both purchase and payment occurred on/after launch cutoff; `official` CBE verification; completed; provider checked the supplied receiving account; masked suffix matches; receipt receiver name matches configured holder; bank amount/currency exact; reference is returned and compatible with buyer-entered value; payment within 30 minutes of request; no prior Check.et branch verification ambiguity; no other request shares reference; ledger claim unused.
5. The existing ticket-allocation transaction **rechecks current request and lottery**, verifies the time-limited server-side payment guard, creates the permanent hashed reference claim, allocates sequential ticket documents, updates purchase/public status and enqueues the **existing** buyer notification, all atomically.
6. Any mismatch or missing evidence goes to `manual_review`. Temporary Check.et outages retry up to three times with backoff; uncertain approval results are never blindly retried.
7. Buyer-notification delivery remains handled by the previously established background notification worker (not by Check.et).

### Production rollout checklist (staged)

- The current 100 ETB payment predates cutover and must remain pending for manual handling. Do **not** approve it or any other old request automatically. Set a strict launch cutoff to the actual future activation time and require both bank payment time and purchase creation time to occur afterward.
- Start with an empty or otherwise reconciled ledger for new production payments; **never** clear the ledger once live. A reference claimed by an approved purchase must remain blocked across lottery deletions/cancellations.
- **COMPLETED:** deployed and verified the revised Firestore rules on `tigiray-lottery`; all browser approval/status/ticket writes are denied and server paths were reviewed.
- **COMPLETED in isolated Firestore emulator:** 5 real Firestore Admin SDK integration tests plus 8 browser Security Rules tests. They cover concurrent reuse of one bank reference, distinct sequential approvals, receipt-only references, evidence tampering, atomic lottery-mode creation/audit, immutable legacy-manual behavior, schema pollution, role escalation, forged public approvals, and browser access to private queues. They run only against `demo-tigray-lottery-auto`, with no bank API or production writes. **Still needed:** verify the production rules release and test the disabled production endpoint. Do not reuse actual buyers' payments as test issuance without consent.
- Validate Check.et API quotas, receipt handling/data processing, and support for commercial automatic ticket fulfillment.
- The production Check.et key is present. Prepare the secret, verified allowlist/account binding and scheduler in the disabled state; activate them only after explicit cutover confirmation.
- Start with one lottery and audit all automated approvals and rejections before scaling.

### Preview simulation

The General Admin `Match pending ticket` and `Test uploaded receipt` panels now show **CBE automatic-approval eligibility — PREVIEW SIMULATION** with policy blockers. A positive result is still read-only; it never issues tickets in Preview.

### Provider-verified payment recovery (staged)

Every production automatic verification will now:
1. Atomically mark the queued request **verification attempted** BEFORE calling Check.et (so a crash cannot automatically repeat the provider call).
2. Call Check.et with the correct CBE receiving account and validate the official response.
3. Persist a **private, server-owned, order-bound verification snapshot** in the `autoPaymentQueue/<requestId>` document BEFORE assigning any tickets. It stores the verified reference, amount, currency, date, receiving account check, and a hash binding the original purchase and receiving account. It does **not** store the PDF/image bytes, API key, or the full receiving account separately.
4. In the ticket-issuing Firestore transaction, recheck the stored snapshot, current order status and amount, configured account, fingerprint, cutoff, ledger claim, and expiry before allocating tickets.
5. If a ticket assignment fails but the purchase remains pending, retry ONLY using the cached verification and atomic claim. If tickets were assigned but the response was lost, the recovery worker sees the approved order and marks its queue done.
6. If the provider call itself was attempted but the function crashed before saving its result, send to manual reconciliation rather than calling Check.et again. There is no safe way to reconstruct a lost third-party response without an authorized provider lookup/idempotency facility.

The snapshot is allowed for 30 minutes for recovery and becomes ineligible after expiry. Preview stays read-only, and no production environment flags have been enabled.

### Actual Firestore emulator concurrency coverage

`.github/workflows/cbe-firestore-emulator-tests.yml` runs `tools/test-cbe-firestore-emulator.cjs` with pinned Firebase CLI/SDK and `demo-tigray-lottery-auto` using `firebase.emulator.json`. The original `approveRequest` function is made accessible to this script *only* when `FIRESTORE_EMULATOR_HOST` is present. The suite passed all 5 integration tests plus 8 browser Security Rules tests on October 30, 2026. It proves that Firestore serializes our payment-claim and ticket-number transactions under concurrent requests, and that the General Admin can atomically create a validated automatic lottery and its audit record. Production rules were separately deployed and compared to the tested file; the suite still does **not** spend money or prove a real Check.et automatic issuance flow.

### Prepared opt-in scheduler (not running)

`.github/workflows/cbe-auto-approval-worker.yml` will call the **production** `https://tigraylottery.com/api/admin/approvals` endpoint every 5 minutes only after the PR is merged into the default branch and GitHub Actions repository variable `LOTTERY_CBE_CRON_ENABLED=true` is intentionally configured. GitHub Actions secret `LOTTERY_CBE_AUTO_APPROVAL_CRON_SECRET` must match the **production Vercel environment** value. The verified production lottery document is `7gQMGpSqRAa2wkmpuYp9` (lowercase `g`, not the earlier `q`). The production Vercel API additionally requires `LOTTERY_CBE_AUTO_APPROVAL_ENABLED=true`, a future cutover, that exact one-lottery allowlist, the matching production-only receiving-account binding, and a production Check.et key. Keep the enable flag and scheduler variable false and omit the cutover timestamp until explicit activation confirmation.

