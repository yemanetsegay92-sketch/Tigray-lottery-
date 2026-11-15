# CBE receipt and administrator review upgrade

## Audit baseline

Audited Tigray `main` at `afa40876b66bb6331e9876e69ddf8273b12d30dc` and read-only YOAS `main` at `7f379fc2a19c563ed3f104f565084eab53287c51` (merged PRs #19, #20, #22, #23). No unmerged experiments were used.

| Area | Existing Tigray | Adaptation from YOAS |
| --- | --- | --- |
| Receipts | Signed direct uploads, private finalized immutable Storage objects, MIME/signature/size checks, authenticated short-lived reads | Server PDF text extraction and bounded scan/image OCR; originals stay in Storage |
| Payment reuse | Global permanent hashed `paymentClaims`, atomic consumption with issuance, retained after cancellation/cleanup | Ledger read at checkout and before verification; receipt-only extracted references checked too |
| Automatic approval | Server activation, cutover, event dispatch, leases, scheduled recovery, durable single-attempt marker and saved evidence, exact amount/receiver/time checks | Reference-only provider input, extraction and evidence conflicts route to review, first submitted reference/result retained |
| Administrator review | Assigned lottery authorization, manual decisions, ticket allocation, lookup, notifications | Bank/correction fields, OCR originals/candidates, ordered attempt audit, explicit paid-call confirmation, revision and call reservation |
| Access | Firebase auth, role profiles, Firestore and server enforcement | Inline hidden dashboard until verified; stale auth callbacks cannot reveal it; direct wrong-role routing |
| Notifications | Buyer decision queue and Telegram buyer/admin integrations | Retained; approval/rejection still use existing atomic queues |

YOAS's automatic rejection callbacks (including wrong-account and receipt-reference mismatch policies) were deliberately **not** imported. Tigray still routes 404, provider 409, insufficient amounts, uncertain receiver, conflicting evidence and provider failures to manual review. An existing consumed database claim is the only immediate checkout rejection added here. There is no purchase to reject or buyer decision notification to enqueue in that case. Existing pending requests remain available to administrators; no new unattended rejection state machine was added.

## Behavior

- The browser cannot supply trusted OCR fields. Server reads only validated, finalized private Storage objects.
- Images use local Tesseract English data. PDFs use embedded text first; scanned pages are rendered sequentially and OCRed locally. Original receipt bytes never go to Check.et in automatic or pending-review verification.
- For CBE **OCR text**, select the first valid FT candidate in OCR text order, then replace uppercase `O` with `0`. Save the original reference and every recognized candidate, including repeated copies. No VAT label is required. OCR order is not guaranteed visual order, and the first candidate can itself be wrong. Bank, receiver, amount, reference consistency, time and atomic duplicate checks remain mandatory.
- Embedded PDF text accepts repeated identical FT values without O-to-zero substitution; conflicting FT values (including O versus 0) return `ambiguous_reference` with all candidates and no OCR/provider fallback. Screenshots and scanned-PDF OCR select the first CBE candidate. Other-bank ambiguity behavior remains conservative. Customer-entered references and provider references receive no O-to-zero substitution. Unresolved receipt/customer/provider conflicts require review.
- Checkout checks the permanent ledger within its acceptance transaction. Concurrent approvals still consume claims atomically with ticket allocation. Pending requests and provider duplicate flags alone do not prove consumption. Existing request-ID/idempotency logic remains intact.
- Known consumed references do not call Check.et. Rejected uploads have staged/final copies cleaned where applicable. Receipt finalization and its existing single-use upload claims remain in place.
- Automatic verification commits its attempt marker before contacting Check.et. A crash/timeout cannot cause an automatic second call. The exact first submitted reference and safe first result are retained. Missing historical results are shown as unavailable.
- HTTP 200 can establish provider verification only with the existing positive bank/status checks. HTTP 404 and 409 preserve allowlisted status/code/booleans while remaining unverified. `source_url`, `exists`, and provider duplicate are never approval evidence alone. Amount comparison uses transferred `receipt.amount`, never fees-inclusive `total_amount`.
- Review opens from each pending request. An administrator can view/download the original, choose CBE/Other, inspect OCR, save a correction, check permanent reuse, explicitly Verify Again, approve or reject. Verification uses a configured account; each call has an immutable audit reservation, chronological revision, and a per-admin budget of six calls/five minutes. The UI disables controls during a call; server transactions protect multiple tabs.
- Approval requires explicit confirmation that the required amount reached the intended receiver, then repeats the atomic claim check. Corrections are recorded separately from `originalCustomerReference`. Existing ticket assignment and buyer/admin notification integrations remain.

## Defaults and compatibility

No environment, secret, receiving account, Firebase rules, production data, worker schedule, or activation record is changed by this branch.

- `LOTTERY_CBE_RECEIPT_OCR_ENABLED=true`: opt-in for checkout extraction and missing-extraction recovery in the automatic worker. Unset means uploaded receipts without saved extraction require manual review rather than direct file forwarding. Authorized review can extract locally without paying Check.et.
- `LOTTERY_CHECKET_READ_ONLY_ENABLED=true`: legacy-named flag retained for compatibility; it opts in to paid, audited administrator verification **on production only**. These operations can save corrections, audit attempts and queue state; they are not read-only. Unset disables paid review calls. Preview diagnostics are retired with HTTP 403 before Firebase initialization. Preview cannot invoke review-details/save/verify or purchase decisions, even when flags/confirmation are supplied. Local tests inject a provider mock.
- Existing automatic-approval emergency switch, per-lottery activation, cutover and account binding are preserved. This branch does not activate them.
- New claims include normalized reference and bank category (version 2), retaining the **exact existing hash namespace and document ID**. Version 1 claims continue to block reuse. No claim rewrite or data migration is needed.
- New request/queue/audit fields are additive. Older purchases can still be reviewed; the UI does not invent a missing original result. Older admin clients must refresh before manual approval because the HTTP approval path now requires bank/reference/confirmation/revision.
- `vercel.json` disables Git deployment of `feat/yoas-payment-workflow-upgrade`. The branch is for review only; do not merge or deploy as part of this task.

## Vercel constraints and packaging

No API function or Firebase function was added. Existing Vercel handlers perform extraction; event dispatch and recovery stay in their original architecture. Upload limits remain images 420 KiB/PDF 2 MiB, through direct Storage uploads, below Vercel's 4.5 MB body cap.

Extraction allows four PDF pages, renders at most 2048 pixels on the longer edge, and processes pages sequentially. Sharp rejects images above 16 megapixels and resizes before recognition. Each process permits one extraction at a time; contention returns manual review. The OCR worker is terminated on a 45-second deadline. Parser/render stalls remain bounded by the function deadline (checkout 60s, existing batched admin/worker endpoint 300s). PDF rendering itself is not preempted by the Tesseract timer; hard timeouts can require an idempotent customer retry. Do not increase page/pixel limits without measuring memory.

Explicit `includeFiles` package the Tesseract worker/WASM/local English data and PDF worker/native Linux canvas assets that automatic tracing can miss. A real isolated **Vercel CLI 65.16.0 `build --prod`** completed successfully after pinning Node **24.x** (the previous open range selected Node 26). No deployment was made and no production secrets were pulled. Sanitized local project settings used the inspected project's framework `null` and Node 24 setting.

The actual Build Output API artifact contains **12 functions**, all `nodejs24.x`: administrator payment endpoint **136.5 MiB**, checkout **135.7 MiB**, others at most **8.4 MiB**, below 250 MiB per function. Counts include explicit `filePathMap` assets as well as physical function files. `node tools/verify-vercel-build.cjs <isolated-build-source>` reconstructs isolated bundles from those artifacts/mappings and tests handler imports, real JPG/PNG/WebP OCR, real scanned-PDF OCR and repeated text-PDF parsing. Both payment artifacts passed; representative smoke batches took 2.3–3.1s and peaked at 420–425 MiB RSS locally. These synthetic measurements are not worst-case memory/latency guarantees. No extra function may be added without revisiting the Hobby count limit.

Browser acceptance remains **not executed**; see [the prepared emulator-only acceptance plan](admin-browser-acceptance.md) and [pre-merge review evidence](pr34-premerge-review.md).

## Validation

Local results: **124 unit/integration tests and 20 Firestore emulator tests passed**, plus the existing private-upload, lookup and cleanup operational checks. No Check.et calls or production/staging writes were made.

Run with no production credentials:

```sh
npm ci --ignore-scripts
npm test
npm run test:emulator
```

Unit/integration checks include real local Tesseract JPG/PNG/WebP recognition, real PDF rasterization with injected OCR, CBE first candidate/O normalization and original preservation, other-bank/customer invariance, mocked Check.et outcomes, amount/receiver policy, single-attempt recovery, notification dispatch, private upload validation, lookups and cleanup. Access tests simulate wrong roles, missing profiles, logout and stale cross-tab auth callbacks; an actual browser two-tab acceptance pass remains a later predeployment check.

The isolated `demo-tigray-upgrade` Firestore emulator runs production checkout and approval transactions, cross-lottery consumed claims, concurrent submissions/issuance, receipt-reference ledger lookup, rule isolation, corrected-reference preservation, credit confirmation/concurrency, original verification retention, and notification queues. All provider calls are mocked; no live Check.et request or production/staging Firebase write is permitted.

## Later deployment and rollback (review only)

1. Review this draft, CI, native dependency changes and the additive schema. Keep paid verification and automatic-approval activation off during review.
2. Reproduce the isolated Vercel artifact checks on the release commit; execute the prepared browser matrix, including private upload, role routing in two tabs, review correction, duplicate rejection and notifications. Use provider mocks; real verification credits require separate authorization.
3. Plan an explicit production change window. Refresh administrator clients. Deploy the reviewed commit only after approval; preserve existing secrets/accounts/claims. Set OCR and paid-review flags deliberately, separately from the existing auto-approval global/per-lottery controls. Confirm the worker/event callback execution budget.
4. Monitor extraction failures, manual-review queues, provider attempt records and notification delivery. Never replay uncertain provider calls automatically.
5. Roll back to the preceding reviewed Vercel deployment if needed, and disable the new OCR/paid-review flags. Pause automatic approval with the existing emergency mechanism if evidence is uncertain. Preserve all payment claims, audit attempts, private originals and additive fields; do not delete/rewrite claims or repeat provider calls. Earlier admin clients ignore extra claim metadata.
