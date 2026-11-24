# AfroMessage phone OTP foundation — pilot only

**Status:** PREPARATION ONLY. Do not enable public registrations or merge until reviewed. This PR adds a disabled-by-default, server-side phone-verification alternative using AfroMessage; Firebase Auth/Firestore and the existing UID remain the source of identity.

## Boundaries
- No real SMS tests, provider billing changes, token disclosure, user-data migrations, or production configuration changes are included.
- Endpoint is **POST /api/customer/create-request** with `action: afro-otp-start` and `action: afro-otp-verify`, to avoid increasing Vercel function count.
- Production sending is denied unless `AFROMESSAGE_OTP_ENABLED=true`, a server-only `AFROMESSAGE_API_TOKEN`, a separate 32+ character `AFROMESSAGE_PHONE_HASH_KEY`, and a matching pilot-phone HMAC are configured. All controls are off by default.
- **Unrestricted public registrations are not implemented** in this PR, even if commercial-looking flags are set. This is necessary while the AfroMessage Beta Tester account requires preverified contacts and commercial approval is unresolved.
- Only existing customer phone UIDs are reused; users with existing admin roles/claims are not eligible for the alternate customer login.
- Production wallet deposits, purchases, refunds, settlements and bank verification flags remain unchanged.

## Provider behavior
- Challenge: `GET https://api.afromessage.com/api/challenge` with a 6-digit code and 300-second expiry.
- Verify: `GET https://api.afromessage.com/api/verify` with server-stored provider verification ID, phone and code.
- Provider's challenge response contains the plaintext OTP, message and phone. **Never print, persist, return, or log the raw provider response**. The service only stores a short-lived verification ID.
- The verify response must match the stored phone, provider verification ID and submitted code before a one-time Firebase custom token can be issued.
- A wrong/expired code has a maximum of five attempts. Successful challenges are consumed once.
- Sending is limited by Firestore transactions: 3 requests per phone in 30 minutes, 8 per platform-reported IP in 30 minutes and a daily total (default 10, maximum 100). Network failures fail closed. These are defense in depth, not a replacement for a professional bot-control review.
- Short-lived `afroOtpChallenges` documents contain the phone and provider verification ID and are only accessed via Firebase Admin. Configure Firestore TTL on `expiresAt` after reviewing retention. `afroOtpRates` can also use TTL on `expiresAt`. Do not expose either collection to clients in Firestore rules.

## Environment variables
| Variable | Purpose |
|---|---|
| `AFROMESSAGE_OTP_ENABLED` | Must equal `true` to permit requests |
| `AFROMESSAGE_API_TOKEN` | Server-side bearer token, never browser-visible |
| `AFROMESSAGE_PHONE_HASH_KEY` | Separate random secret >= 32 characters for HMAC phone/IP digests |
| `AFROMESSAGE_PILOT_PHONE_HASHES` | Comma-separated HMAC-SHA256 digests of normalized E.164 pilot numbers; no plaintext numbers |
| `AFROMESSAGE_DAILY_SMS_CAP` | Optional integer 1–100, default 10, enforced before send |

Keep all variables unset in production at this stage. Never paste credentials in chat, code, screenshots or CI logs. When approved to test, compute the digest privately from the E.164 number and the configured hash key using Node crypto, not an online hashing website.

## Verification gates before activation
1. Obtain written provider confirmation of commercial eligibility for a lottery authentication use case and the ability to send to unregistered contacts on both networks.
2. Set up a verified sender name and contract as required by AfroMessage.
3. Review/implement production bot protection, WAF, on-call spend monitoring and incident response before public activation.
4. Run fully isolated Firebase Auth/Firestore emulator tests using only synthetic phone numbers and mock provider responses; confirm the Firebase ID token contains `phone_number` after custom-token login and the existing wallet authorization still works.
5. Confirm data retention, privacy policy and phone-consent notice, and agree on UID account recovery and SIM-swap controls.
6. Complete an approved, controlled real pilot with an AfroMessage verified test contact only after reviews.
7. Only after a *separate* security review should public registrations be proposed. This PR explicitly does **not** support the public path.

## Recovery
- Remove/turn off `AFROMESSAGE_OTP_ENABLED`; existing Firebase phone sign-in and wallet account UIDs remain untouched.
- Do not delete existing Firebase users or wallet documents as part of reverting the pilot.

## Controlled real-SMS end-to-end test (personal preverified contact, not production)

Only run on a trusted Windows PC. This is not a public rollout, and it does not need any Firebase production secrets.

1. Open PowerShell in this PR branch checkout and run:
   `powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools/local/start-real-sms-pilot.ps1`
2. Enter your own already-AfroMessage-verified Ethio Telecom `09XXXXXXXX` contact and the AfroMessage API token in the **hidden** terminal prompt. The token is passed only through the local process environment and must not be pasted into GitHub, screenshots, chat or files.
3. The test script starts an isolated local demo Firebase Auth + Firestore instance with random hash key and a one-phone HMAC allowlist. Only the real AfroMessage `/api/challenge` and `/api/verify` requests are allowed to leave the local PC; all other outbound API requests are blocked. The daily SMS cap is **2** for this local session.
4. Open `http://127.0.0.1:4174/account.html`. Enter the same phone number and click **Send via AfroMessage**, then type the received code into the page and click **Verify AfroMessage code**. Do not share the code.
5. Verify that the legal-name form appears. Enter a synthetic name only (the test database is disposable), register, and confirm a **0.00 ETB** wallet. Deposits or purchases in this local emulator are test-only and never touch real bank accounts.
6. Sign out and sign in again with the same number using a second real SMS if desired. Confirm the wallet is unchanged and does not duplicate. Use at most two messages.
7. Press **Ctrl+C** to stop. The local Firebase data is reset by the next fresh emulator start. Sensitive env vars are cleared by the PowerShell wrapper on exit. Do not post raw terminal traces containing credentials, OTPs, full numbers or Firebase tokens.

**Safety:** This pilot only works when the local demo project, Firebase Auth and Firestore emulators, loopback host, exact demo env flags, private token and preverified phone HMAC all match. Opening the normal `https://tigraylottery.com` site does NOT use this pilot. Never set these pilot variables in Vercel or in production. This deliberately costs up to two real SMS charges and must be started manually.
