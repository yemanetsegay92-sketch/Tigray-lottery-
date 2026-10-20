# Tigray Lottery V9

V9 builds on the tested V8 release.

## Public
- Main: https://tigraylottery.com
- Alternate: https://www.tigraylottery.com
- Customer side defaults to ትግርኛ and remembers language choice.
- Each lottery card has Buy Ticket, Check Ticket, and Winner Awards.

## Admin links
- General Admin: /admin/general-login.html
- Lottery Admin: /admin/lottery-login.html
- The role is still verified by Firebase; separate URLs are only an entry point/convenience.

## V9 scaling change
Customer ticket submissions now go through /api/customer/create-request and use the Firebase Admin SDK on the server. This keeps customer browsers from opening direct Firestore write channels for each submission and gives us a single validated write path.

## Winner awards
General Admin can enter one award per line when creating a lottery and can edit awards later. Customer-facing Winner Awards opens a modal from each lottery card.

## Important
Keep Firebase service-account JSON and Telegram bot tokens only in Vercel Environment Variables. Do not commit them to GitHub.

## Test deployment
Preview deployments for the `v9` branch are used to verify V9 changes before merging them into `main`.


<!-- Vercel deployment trigger checkpoint -->


## Buyer Telegram delivery (review before enabling)

Purchases no longer send a per-request notification to admins. The customer receives a Telegram notification after an administrator approves, rejects, or cancels a request, provided the customer connected the buyer bot. The notification includes assigned ticket numbers or the rejection reason, but not a bank screenshot/PDF.

### Security and migration

- The admin dashboard now makes both approval and rejection decisions via the authenticated /api/admin/approvals server endpoint; each decision atomically creates a buyerNotificationQueue document in Firestore.
- The /api/telegram/notify-buyer endpoint verifies the Firebase ID token, generalAdmin/lotteryAdmin role and the lottery assignment before attempting delivery.
- Buyers receive a 63-character one-time Telegram /start deep-link using a random 20-hex-character secret; the secret's SHA-256 hash is in Firestore. Legacy /start request_<requestId> linking is intentionally disabled because knowing the request ID alone was insufficient proof of ownership.
- A buyer who does not connect Telegram still checks payment and ticket status on the website. After a valid later link, a previously queued decision can be delivered.
- Existing Firebase Storage rules stay deny-all for direct client access. The private receipt upload/download system is not modified here.
- The buyerNotificationQueue collection must remain server-only; existing Firestore rules have no matching client permission and deny access by default.
- Never commit bot keys, scheduler secrets, or service-account credentials.

### Required background retry setup

The admin interface tries an immediate send after approving/rejecting, but browser closure and transient Telegram errors must not lose updates. Configure Google Cloud Scheduler (or another trustworthy external scheduler) to POST to:

    https://www.tigraylottery.com/api/telegram/notify-buyer

Add a random, secret HTTP header:

    x-buyer-notification-secret: <long random secret, at least 24 characters>

Put the **same** secret in Vercel's server-side environment variable BUYER_NOTIFICATION_CRON_SECRET. Use a schedule of **every minute** (\`* * * * *\`), POST with an empty JSON body, and ensure Cloud Scheduler's job can reach the production URL. Before enabling, deploy and verify the endpoint is authenticated (missing/wrong secret returns 401) and the secret does not leak into client JavaScript. The worker processes up to 100 due notifications per invocation (8 at a time), using Firestore transaction leases and exponential retry; test under the real Vercel function-duration and Telegram throughput limits. Google Cloud Scheduler usage can be billable.

There is no exactly-once guarantee from Telegram's API if a send succeeds but the acknowledgment is lost. Queue delivery is best effort with duplicate-risk during ambiguous network failures. Check Firestore jobs in state \`failed\` after 12 attempts and manage them manually; never reset sent jobs blindly.

### Before production release

1. Run a staging test for two buyer accounts, including an attempt to reuse or steal a used deep-link.
2. Verify one approval and one rejection each create one queue job, correct Firestore ticket/public status, and notify the correct linked buyer.
3. Kill the admin browser before notification dispatch; verify the scheduled worker delivers the queued job once Telegram recovers.
4. Verify a different lottery admin (or ordinary Firebase user) cannot invoke the admin notification endpoint.
5. Ensure no real customer data or messages are used in load tests; use staging data and a mocked Telegram provider.
6. Compare current Firestore rules with server-authorized decisions: legacy rules may still permit a lottery admin to modify ticket request status directly. Plan a separate reviewed rules deployment to restrict client-side status writes after testing all admin workflows.
