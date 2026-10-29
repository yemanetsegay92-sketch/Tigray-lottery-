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

**Important:** No existing payment-claim records are created merely by Preview verification. Claims begin only when approvals are made through the updated approve endpoint. Existing approved tickets must be inventoried, duplicates resolved, and clean historical references **backfilled before enabling automatic approvals**. Do not run a large migration against production without a dry-run report and explicit approval.

## Other gates before production

- The repository Firestore rules now forbid **client-side ticketRequests update** and explicitly deny client reads/writes to paymentClaims. These rules are **not deployed** by merging this PR; deploy and test the rules separately before considering the ledger production enforced.
- A small number of orders have no bank reference until a staff member reads a receipt; they cannot safely be approved on this new flow without a reference.
- Keep `CHECK_ET_API_KEY` in Vercel Preview only until the read-only integration is accepted.
- No automatic approval is enabled; CBE matches remain advisory only.
- The checkout and any older admin/deployment path that could issue tickets should be reviewed to ensure **all approvals route through the claim-aware transaction**.
- A false/missing provider response, stale transfer, duplicate, unmatched amount/account or missing date always requires review.
- Avoid repeatedly verifying the same receipt: Check.et free verifications may be limited.
