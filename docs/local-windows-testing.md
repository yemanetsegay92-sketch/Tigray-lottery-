# Windows 11 local wallet testing

This environment uses only the synthetic Firebase project `demo-tigray-wallet`. It does not log in to Firebase, read Vercel variables, use service-account credentials, send SMS messages, contact Check.et, deploy, or write production data.

## Start

Requirements: Windows 11, Node.js 24, npm, and `curl.exe`. Java is detected automatically; if missing, the script downloads an isolated Eclipse Temurin JRE into the ignored `.firebase-local` directory.

```powershell
cd "C:\path\to\Tigray-lottery-"
npm.cmd ci
npm.cmd run test:local:start
```

Keep that terminal open. In a second PowerShell terminal, verify isolation:

```powershell
cd "C:\path\to\Tigray-lottery-"
npm.cmd run test:local:smoke
```

The start command fails if the project ID is not `demo-tigray-wallet`, either emulator is missing, a service-account credential is present, or the browser/API configuration could fall back to a non-local URL.

## Local addresses

- Application and API server: http://127.0.0.1:4174
- Synthetic account chooser: http://127.0.0.1:4174/local-login
- Customer wallet: http://127.0.0.1:4174/account.html
- Admin sign-in: http://127.0.0.1:4174/admin/login.html
- Firebase Emulator Suite UI: http://127.0.0.1:4000
- Firestore emulator: `127.0.0.1:8080`
- Authentication emulator: `127.0.0.1:9099`

Use the Emulator Suite UI to inspect Auth users, Firestore documents, wallet ledgers, immutable financial audits, obligations and settlements.

## Synthetic sign-in accounts

All email accounts use password `LocalTest!2026`.

| Role | Email | Assignment |
|---|---|---|
| General Manager | `gm.local@tigray.test` | All local lotteries |
| Lottery Admin | `rf.admin.local@tigray.test` | `local-rf-lottery` only |
| Lottery Admin | `standard.admin.local@tigray.test` | `local-standard-lottery` only |
| Customer One | `customer1.local@tigray.test` | Phone `+251911000101`; registered and funded with 200 ETB |
| Customer Two | `customer2.local@tigray.test` | Phone `+251911000102`; phone-verified Auth user with no wallet profile, for registration testing |

The `/local-login` page signs in against the Auth emulator only. To exercise the phone UI itself, sign out on the customer account page, enter `0911000101` or `0911000102`, and use the verification code shown by the Authentication emulator/terminal. No real SMS is sent.

## Synthetic lotteries and payments

- `local-rf-lottery`: active, 25 ETB tickets, RF-only evidence, assigned to the RF Lottery Admin.
- `local-standard-lottery`: active, 50 ETB tickets, standard evidence, assigned to the Standard Lottery Admin.
- Company receiving account: `1000000000001`, owner `Tigray Lottery Local`.
- Pending seeded deposit: `FTLOCALDEPOSIT01`, 100 ETB, Customer One.
- Additional mock references: `FTLOCALDEPOSIT02` (100 ETB, Customer Two) and `FTLOCALSTANDARD01` (50 ETB, Customer One).

The Check.et adapter is forced to `http://127.0.0.1:4174/mock/checket`. Unknown references return synthetic not-found results. Automatic wallet credit remains disabled because the mock deliberately does not assert genuine independent payer ownership.

## Suggested manual flow

1. Sign in as Customer Two and create the free wallet to test registration.
2. Submit `FTLOCALDEPOSIT02` for 100 ETB.
3. Sign in as the General Manager, open Wallet finance, and manually approve a pending deposit. Enter the synthetic receiving account/owner and an explanatory review note.
4. Sign in as a customer and buy from either active lottery. Confirm instant ticket allocation and wallet deduction in the Emulator UI.
5. As General Manager, record a partial owner settlement with a unique synthetic transfer reference, receiving account, owner, date and note.
6. Try refunding the settled sale; it must be blocked. Use a different unsettled purchase to test a successful refund and preserved cancelled ticket history.
7. Sign in as each Lottery Admin and confirm that only the assigned lottery and its financial history are visible and read-only.
8. Navigate both admin dashboards and customer pages normally; all browser Firebase requests remain on ports 8080/9099.

## Stop and reset

Press `Ctrl+C` once in the terminal running `npm.cmd run test:local:start`. The emulators use in-memory data, so stopping and starting again resets Auth and Firestore and reruns the deterministic seed.

The ignored `.firebase-local` directory contains only the downloaded JRE and Firebase CLI configuration cache. It contains no production credentials. Delete it only if you want to force a clean Java/tool cache download; it is not necessary to reset test data.

## Relevant automated tests

```powershell
npm.cmd test
npm.cmd run test:emulator
npm.cmd run test:local:smoke
```

The existing Windows OCR fixture may remain platform-sensitive; do not change OCR as part of local wallet testing.

## Cloud Chromium E2E

The dedicated `PR36 cloud wallet browser E2E` GitHub Actions workflow starts the same Auth and Firestore emulators, deterministic seed and localhost API server on an Ubuntu runner. It installs the Playwright-pinned Chromium build and exercises the real customer, General Manager and Lottery Admin pages.

The job has no Firebase or payment-provider secrets. Production wallet flags remain false, Google metadata detection is disabled, Firebase browser modules are served from localhost, Telegram is replaced by an inert local stub, and every browser request is asserted to use `localhost` or `127.0.0.1`.

Every run uploads a 14-day `pr36-wallet-cloud-e2e-*` artifact containing:

- the HTML and JUnit reports;
- a screenshot for every test;
- traces and video for failures;
- emulator, seed and local-server logs;
- the emulator health response.
