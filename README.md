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
