# Tigray Lottery upgrade (22 November 2026) — draft specification

## Agreed scope
- Customers may register for free, verify phone, and hold one wallet balance shared across all lotteries of **the same company**.
- First and later deposits minimum **100 ETB**. The General Manager can manually approve deposits; only verified CBE transaction-reference deposits that meet bank account, amount, date, finality and customer-ownership checks may auto credit. Uncertain ownership must go to review. Lottery Admins cannot approve deposits.
- Wallet purchases instantly approve and assign tickets when balance and lottery capacity suffice; no bank-to-lottery-admin transfer occurs. Atomically debit customer, issue tickets, record immutable ledger and owner obligation. Idempotency and concurrency must prevent negative balance or double issuance.
- General Manager settles any owner/lottery obligation at any time, with partial payments and bank-transfer evidence; Lottery Admin views read-only balances and settlements.
- Each new lottery can choose `standard` (default RF, image/PDF, or both) or `reference_only` (RF required, no uploads); old lotteries remain standard.
- Redesign both admin workspaces as one active section at a time with lazy querying. Default General Manager overview; default Lottery Admin pending payments.
- **No tax reporting module** until government rules are official; Telegram feature work is out of scope for this chat.

## Financial engineering requirements before launch
- Use verified Firebase Auth customer identity and authenticated server-only writes. No client balance edits.
- Use integer santim, permanent double-entry or equivalent immutable wallet ledger, ledger idempotency keys, balance reconciliation and never delete ledger during lottery cleanup.
- Deposits, direct ticket payment and wallet credits share the permanent bank-reference claim namespace. A bank reference may be consumed once across ALL methods and lotteries, never double credited.
- For auto deposit: Check.et account/amount/status/date verification plus verified sender ownership are mandatory. Do not assume knowledge of RF proves ownership. 404, 409, ambiguous amount/receiver/sender, provider outage or stale receipt => manual review or explicit reject when provable.
- Wallet purchase is one Firestore transaction checking funds and lottery capacity, writing debit, unique ticket allocation, public status and owner-sale obligation. Repeated request ID returns same result, never second debit.
- General Manager can control payouts without changing buyer balance; partial settlements and full audit trails.
- Keep company money separate from personal funds and confirm regulatory/payment-provider eligibility before accepting live wallet deposits.

## Integration and acceptance gates
- Firestore emulator tests for concurrency, deposit threshold, duplicate RF cross-flow, fund ownership, race conditions, partial owner settlements and full rules isolation.
- Browser tests on actual admin roles and devices including lazy network queries and session expiry.
- Mocked provider tests first; live provider wrong-receiver and ownership validation only with explicit authorization.
- Load tests and alerts in isolated environment. Preserve production payments and rollback path.
- **Do not merge or activate wallet until backend, front-end, rules, auth and financial tests all pass.**

## Implementation status
This branch now includes free Firebase Phone Auth registration, a company-scoped wallet account, authenticated customer wallet routes, a 100 ETB deposit floor, permanent cross-flow bank-reference claims, atomic/idempotent wallet purchase and ticket assignment, refunds, owner obligations, partial General Manager settlements, read-only Lottery Admin finance views, RF-only/standard creation choice, and lazy single-workspace dashboards. Client Security Rules deny every wallet balance and financial-history write.

Automatic CBE deposits are deliberately fail-closed: the reference lookup validates receiver, amount, completed status, date and reference, but automatic credit additionally requires an authorized provider/KYC assertion binding the payer identity to the authenticated customer UID. The currently integrated Check.et response does not supply that ownership assertion, so such deposits remain pending for General Manager review. Do not enable `WALLET_AUTO_DEPOSITS_ENABLED` until provider authorization, receiver-account negative controls, payer-ownership integration and regulatory approval are documented.

Unit and responsive browser layout checks have been executed locally. Full Auth/Firestore emulator, authenticated role-browser, isolated load, production-compatibility and rollback drills remain required before merge. Production payments remain disabled and unchanged.
