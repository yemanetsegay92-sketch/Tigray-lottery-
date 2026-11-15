# Prepared browser acceptance plan — PR #34

Status: **NOT EXECUTED in a browser.** Node/VM auth-callback simulations are automated regression tests, not browser acceptance evidence. Record browser/version, tested commit, screenshots and network assertions when this plan is executed. Deployment approval remains blocked until these checks pass.

## Isolated setup

Use a disposable source copy, **not** www.tigraylottery.com or any production/staging Firebase project. Start Auth and Firestore emulators under a `demo-` project; load `firestore.rules`. Rewrite only the copy's `firebase.js` with that demo project's configuration and connect both SDK emulators before any read/auth listener. Connect secondary Auth instances to the Auth emulator too. Point any local API server exclusively at `127.0.0.1` emulators. Do not start without proving all Firebase hosts are local; fail closed for external Firebase/Storage/Check.et/Telegram requests.

Seed synthetic profiles and lotteries only in emulators:

- General Admin G (`generalAdmin`).
- Lottery Admin L (`lotteryAdmin`, `lotteryIds: ['lot-a']`).
- Lottery Admin U (assigned only `lot-b`).
- Auth user M without a profile; auth user B with a buyer role.
- Two manual lotteries, one synthetic pending request per lottery, and a permanent consumed claim from a deleted lottery.

No payment flags, real receiving accounts, provider keys, Telegram tokens or automatic activation records. Deny network to Check.et. The Preview review endpoints must return 403 regardless of client role or confirmation. Test the intentional production HTTP review path only with a local server explicitly bound to the demo emulators; the production environment label alone must never select real credentials.

## Acceptance matrix

| Scenario | Actions | Expected evidence |
| --- | --- | --- |
| Initial loading | Throttle profile reads; load each dashboard | Immediately “Verifying administrator access…”; header/content invisible before role resolution; no protected data calls before authorization |
| Correct General Admin | Log G in through general-login.html | Only General Admin dashboard; no transient Lottery Admin content |
| Correct Lottery Admin | Log L in through lottery-login.html | Only assigned lot-a; no lot-b request, receipt or summary reads; no General Admin flash |
| Wrong role | Open general.html as L; lottery.html as G | Direct redirect to correct dashboard, no flash/reload loop |
| Missing/buyer profile | Open each dashboard as M/B | Dashboard remains hidden; sign-in/error route; no private data fetched |
| Same-context two tabs | Open both login pages; sign in as G; switch to L in another tab after signing out | Firebase shared persistence propagates the current session; each tab verifies role before reveal; no claim of independent simultaneous accounts in shared storage |
| Isolated contexts | Use two browser profiles/contexts, G and L | Separate roles stay isolated; L's server access is limited to lot-a |
| Cross-tab logout | Log out in tab A while tab B has a dashboard open | Both dashboards hide; protected requests stop/fail; browser Back does not reveal usable protected controls |
| Stale auth callback | Delay G's profile response, then sign out/sign in as L | Late G response cannot reveal G dashboard; correct L routing |
| Expired/invalid session | Expire/revoke the emulator session, force a token refresh and a protected read in each dashboard | No protected reveal after failure; error/sign-in behavior without redirect loop; API rejects invalid token |
| Assignment change | Remove L's lot-a assignment in emulator during session | New server/Firestore reads and actions denied; fresh load does not show lot-a |
| Preview isolation | Send legacy diagnostics, review-details/save/verify and approve/reject/cancel with confirmCharge:true | HTTP 403 before Firebase/provider calls; zero changes to request, correction, audit, queue, rate-budget or claims |
| Authorized review | On local production-labelled demo API, open L's request, save correction, duplicate-check | Only explicit review path changes correction/audit; original customer/OCR/first provider evidence retained; actions on lot-b fail |
| Paid verification control | Cancel confirmation; double-click; submit two tabs with same revision against injected provider mock | No call when canceled; one reservation/mock call for competing tabs; ordered results; no live credits |
| Manual decisions | Confirm intended receiver/amount, approve; separately reject | Atomic tickets/claim/notification queue; second spend fails; consumed claims survive cleanup |

## Result record (complete during execution)

- Commit:
- Browser/version:
- Emulator project and hosts verified:
- Matrix passed/failed per row:
- Screenshots/network assertions:
- Remaining defects:

No row is currently marked passed. Real Firebase session-refresh and browser-persistence behavior remain unverified by this task's Node tests.
