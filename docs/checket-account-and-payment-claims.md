# CBE receiving-account verification and one-payment/one-ticket-approval ledger (staged)

This PR is **PREVIEW ONLY** and does **not** enable automatic payments or automatic ticket approval.

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

**Important:** No existing payment-claim records are created merely by Preview verification. Claims begin only when approvals are made through the updated approve endpoint. The owner has confirmed **all prior purchases and approvals are test data**. We can therefore start with a new strictly timestamped production cutover instead of migrating old test transactions. Both the ticket request creation time and the bank payment time must be on or after the configured launch date; the Firestore claim ledger remains mandatory for every new approval. Do not delete prior claims or allow old receipts to auto-approve.

## Other gates before production

- The repository Firestore rules now forbid **client-side ticketRequests update** and explicitly deny client reads/writes to paymentClaims. These rules are **not deployed** by merging this PR; deploy and test the rules separately before considering the ledger production enforced.
- A small number of orders have no bank reference until a staff member reads a receipt; they cannot safely be approved on this new flow without a reference.
- Keep `CHECK_ET_API_KEY` in Vercel Preview only until the read-only integration is accepted.
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

Automatic approval is **not live**. The production worker is implemented but stays inaccessible unless ALL of the following independently controlled Vercel environment variables are set **after a security release review**:

- `CHECK_ET_API_KEY` with permission to verify real payments (currently **Preview-only**).
- `LOTTERY_CBE_AUTO_APPROVAL_ENABLED=true`.
- `LOTTERY_CBE_AUTO_APPROVAL_START_AT`: a new **explicit** launch timestamp with time zone (e.g. `2026-11-02T10:00:00+03:00`). The timestamp MUST be set to the actual future activation date, not an earlier time. Only purchases **and** bank transfers occurring on/after this cutoff can qualify; previous test transactions are ineligible.
- `LOTTERY_CBE_AUTO_APPROVAL_LOTTERY_IDS` containing the exact CBE-enabled lottery ID(s), comma-separated; start with exactly one reviewed lottery.
- `LOTTERY_CBE_AUTO_APPROVAL_CRON_SECRET`, an unpredictable random secret **32+ bytes** used to authenticate the worker.

A separately configured, external scheduler (for example existing Cloud Scheduler) must POST `{"action":"cbe-auto-worker"}` to the **production** `/api/admin/approvals` endpoint using `Authorization: Bearer <secret>`. No scheduler integration was configured in this draft PR. Vercel Preview always rejects worker approval, even though it connects to the same Firebase database.

**No one should set the above production flags yet.** We have not yet deployed the updated security rules, executed real concurrent approval integration tests, or reviewed every alternate ticket-write path. Check.et free-plan quotas and commercial/API conditions must also be confirmed before rollout.

### Workflow when correctly activated

1. Checkout creates a `pending` ticket request as before, plus a `autoPaymentQueue/<requestId>` work item **only** for allowlisted production lotteries with exactly one configured valid CBE account and bank holder name.
2. Scheduler calls the secret-authenticated batch worker on the existing approvals Vercel function. A Firestore lease prevents simultaneous workers from handling the same queue item. Pre-cutover purchases are held for manual review **without another Check.et call**.
3. The worker sends either the bank reference OR the existing private PDF/image to Check.et with the **lottery's configured CBE receiving account**.
4. Strict checks: both purchase and payment occurred on/after launch cutoff; `official` CBE verification; completed; provider checked the supplied receiving account; masked suffix matches; receipt receiver name matches configured holder; bank amount/currency exact; reference is returned and compatible with buyer-entered value; payment within 30 minutes of request; no prior Check.et branch verification ambiguity; no other request shares reference; ledger claim unused.
5. The existing ticket-allocation transaction **rechecks current request and lottery**, verifies the time-limited server-side payment guard, creates the permanent hashed reference claim, allocates sequential ticket documents, updates purchase/public status and enqueues the **existing** buyer notification, all atomically.
6. Any mismatch or missing evidence goes to `manual_review`. Temporary Check.et outages retry up to three times with backoff; uncertain approval results are never blindly retried.
7. Buyer-notification delivery remains handled by the previously established background notification worker (not by Check.et).

### Production rollout checklist (NOT COMPLETED)

- The owner confirms all earlier purchases/transfers are test-only. Do **not** approve old test requests automatically or migrate test references as live business sales. Set a strict launch cutoff to the actual deployment time. Verify bank payment time and purchase creation time both occur afterward.
- Start with an empty or otherwise reconciled ledger for new production payments; **never** clear the ledger once live. A reference claimed by an approved purchase must remain blocked across lottery deletions/cancellations.
- Deploy revised Firestore rules. Ensure no outdated clients/admin scripts may update ticket status or mint ticket numbers directly.
- Execute emulator/live-sandbox concurrency, idempotency, timing, wrong-account, wrong-amount, screenshot/PDF, outage and rate-limit tests. Do not reuse actual buyers' payments as test issuance without consent.
- Validate Check.et API quotas, receipt handling/data processing, and support for commercial automatic ticket fulfillment.
- Configure a separate **production** Check.et key, secret, allowlist and cron scheduler only after approval.
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

### Prepared opt-in scheduler (not running)

`.github/workflows/cbe-auto-approval-worker.yml` will call the **production** `https://tigraylottery.com/api/admin/approvals` endpoint every 5 minutes only after the PR is merged into the default branch and GitHub Actions repository variable `LOTTERY_CBE_CRON_ENABLED=true` is intentionally configured. GitHub Actions secret `LOTTERY_CBE_AUTO_APPROVAL_CRON_SECRET` must match the **production Vercel environment** value. Neither value is provisioned in this PR. The production Vercel API additionally requires `LOTTERY_CBE_AUTO_APPROVAL_ENABLED=true`, a future cutover, a reviewed lottery allowlist, and a production Check.et key. Do NOT activate these until production Firestore rules and end-to-end concurrency/idempotency tests have been validated.

