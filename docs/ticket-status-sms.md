# SMS ticket-decision notification foundation

**Status: draft only. No SMS provider calls or production notifications are enabled.**

## Motivation

Buyers provide a phone number at checkout but that is **not phone ownership verification** and does not make them a verified contact in AfroMessage. The AfroMessage Beta Tester account refused an SMS to an unverified test contact. We must not claim it can notify arbitrary ticket buyers. Commercial qualification, provider permission for lottery-related transactional messages, and messaging permissions are unresolved.

This change is provider-neutral. The existing Telegram buyer-notification service is unchanged. Customers can continue checking their ticket status on the website.

## Prepared in this PR

- The public ticket checkout has an unchecked checkbox in English and Tigrinya for **ticket-status SMS updates only**, not marketing. It clearly states that SMS updates depend on future service availability.
- The purchase API defaults missing consent to false, accepts only real booleans and stores `smsNotificationConsent` and optional `smsNotificationConsentAt` in the private ticket request.
- On approval, rejection or cancellation, the same existing atomic decision transaction attaches `smsRequested` and `smsDeliveryState:'not_enabled'` to the existing `buyerNotificationQueue` event.
- `lib/ticket-sms-foundation.js` offers pure phone normalization and short, status-only SMS text. To avoid leaking information to a typo or someone else's phone number, SMS texts never include a name, ticket number, bank reference, amount, rejection reason, or other private data.
- No new serverless endpoint, additional Firestore collection, scheduler, Firestore rule, provider credential, or production flag is introduced. There is **no sending implementation**. Existing Telegram retry and waiting-for-link behavior is untouched.

## Follow-on work, only after provider approval

1. Confirm an SMS provider permits *commercial lottery-ticket transactional notifications* and messages to new/unverified contacts without pre-registering them. Confirm whether a sender ID, licensed company, and template are required.
2. Treat phone supplied at checkout as **unverified**. Enforce per-submission consent, avoid promotional content, and design an opt-out/complaint handling process.
3. Implement a distinct SMS delivery state machine on notifications, independent of Telegram status. Use idempotent decision identifiers (`requestId + decision + channel`), a transactional claim/lease, bounded attempts, and error redaction. An API acknowledgement is not the same as handset delivery.
4. Set a per-day spend ceiling and global disabled-by-default kill switch. Do not retry automatic HTTP sends after ambiguous provider timeouts unless the provider supports idempotency or status lookup; avoid double billing.
5. Test with mock provider and Firebase emulators, then with one opt-in verified test contact only; inspect actual provider receipts and message status.
6. Limit message text to a private-data-free status notice and direct the buyer to `https://tigraylottery.com/check.html` for details.
7. Update customer-facing wording once the SMS service is truly operational. Do not promise messages before activation.

## Rollout

Leave this PR as a draft. There is no provider activation, SMS bill, Firestore migration or wallet change. Existing non-opted-in and legacy requests remain opted out. Deployment and merging require a separate decision.
