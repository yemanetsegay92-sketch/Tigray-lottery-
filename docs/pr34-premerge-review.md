# PR #34 final pre-merge review

## Disposition

Ready for deployment **review**, not deployment approval. Keep PR #34 draft. The build and automated regression checks pass; actual browser acceptance remains a release blocker. No merge, deployment, activation, live provider call, production/staging data mutation or secret/account change was performed.

## Preview isolation defect and fix

The previous `handleCheckEtPendingMatch()` called `reviewAction('review-verify')`, which saves a purchase correction/revision, audit attempt, rate budget and possibly changes a pending automatic queue to manual review. Returning `readOnly:true` was incorrect. Even opening `review-details` can persist server OCR, so it cannot be used as a supposedly read-only Preview preparation step.

Both legacy diagnostic routes (`checket-match-pending`, `checket-verify`) now return 403 before Firebase initialization in every environment. Their obsolete General Admin forms/handlers and misleading read-only/direct-PDF text were removed. Review HTTP operations and approve/reject/cancel are production-only; `reviewAction` independently rejects Preview before any database access, and paid-review gating is production-only. Existing token/role/lottery-assignment checks still protect intentional production Lottery Admin review. The legacy `LOTTERY_CHECKET_READ_ONLY_ENABLED` flag name is kept for environment compatibility but does not imply a read-only operation.

Regression tests prove confirmed Preview calls cannot reach the database, review handler or provider. A separate production-path test proves assigned Lottery Admin review remains authorized and unassigned access is blocked. The emulator tests exercise the real mutating review helper against synthetic data.

## Reference and payment policy

- Screenshots and scanned PDFs: CBE first valid candidate in OCR text order, then OCR-only O-to-zero normalization; original candidates retained. Tested with two conflicting candidates and real scan rendering; real local OCR also exercised.
- Text PDFs: repeated identical references are accepted; letter O remains O. Conflicting embedded references, including O versus zero, remain ambiguous and require manual review; no OCR fallback/provider call. Tests generate real PDFs for these cases.
- Permanent global claims are read before the automatic provider call and before manual verification reservation/call; checkout checks them in its acceptance transaction. Final issuance atomically consumes the claim. A database-consumed-reference test proves zero provider calls and no attempt marker.
- Explicit worker regression tests prove insufficient payments, 404 and provider 409 each remain manual review, make at most one automatic call, and do not retry on a subsequent inspection. Existing amount comparison uses transferred amount, not fees-inclusive total.

## Actual production build (local only)

Read-only Vercel project inspection confirmed Hobby, framework null and Node 24. Built a disposable source copy using Vercel CLI **65.16.0**, `vercel build --prod --yes`, sanitized project metadata/settings and an empty production environment file. No production secrets were pulled. The initial build exposed that `>=22.16.0` selected Node 26; package and lockfile now pin `24.x`, and the final build succeeded on that runtime.

[Artifact validation output](verification/pr34-vercel-build.json): **12 functions**, all Node 24; largest **136.5 MiB** (admin), checkout **135.7 MiB**, below 250 MiB each. The two underscore-prefixed API helpers do not become functions. Checkout maxDuration 60s, admin/batched worker 300s; no function exceeds Hobby's duration cap.

Validation materialized function files plus the CLI's `filePathMap` entries into isolated directories without the project's node_modules fallback. Both payment handlers imported successfully, then real Sharp/Tesseract JPG/PNG/WebP and scanned-PDF OCR, native Linux PDF canvas and repeated text-PDF parsing passed. The representative smoke batches used 420–425 MiB peak RSS and 2.3–3.1 seconds; this does not certify worst-case workloads or hosted cold starts.

Reproduce after an isolated production build:

```sh
node tools/verify-vercel-build.cjs /absolute/path/to/isolated-build-source
```

The validator never deploys or invokes a payment HTTP handler. Do not substitute a deployment command for `build`.

## Tests and outstanding checks

- **124 unit/integration tests and 20 isolated Firestore emulator tests passed**, plus existing private-upload, payment-lookup and cleanup operational checks. All provider responses were mocked.
- Real browser tests: **NOT EXECUTED**. [Prepared acceptance matrix](admin-browser-acceptance.md) covers both roles, initial loading, wrong-role login, missing profiles, same-context two tabs, isolated contexts, stale callbacks, logout, expiry/revocation and assignment changes. VM simulations are not presented as browser passes.
- Release blocker: execute that matrix with actual Firebase Auth/Firestore emulators and capture results for the release commit. In particular, real browser persistence and token-refresh expiry behavior remain unverified.
- Review the intentional retirement of General Admin Preview diagnostic forms and production-only review contract. Existing Lottery Admin production payment review remains available; paid calls still require separate opt-in and explicit confirmation.
- No new Firebase migration, permanent-claim rewrite or receiving-account change is required. Refresh administrator clients for the new contract. Follow the existing rollback plan; preserve claims, originals and audit evidence.
