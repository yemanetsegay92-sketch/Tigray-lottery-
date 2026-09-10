# Tigray Lottery V4

V4 keeps the Firebase/Firestore foundation from V3 and adds:

1. Customer phone-based status lookup.
2. Approved ticket numbers shown to the customer.
3. Separate General Admin and Lottery Admin dashboards.
4. Lottery admins are routed only to their assigned lottery dashboard.
5. Lottery admins can rename and change price, and approve/reject requests for their own lottery.
6. General Admin can create lotteries and create lottery-admin Firebase accounts from the dashboard.
7. Multi-ticket requests and unique ticket document reservation using Firestore transactions.

## Important
The public phone lookup is intentionally simple for V4 and should be hardened before handling real-money activity. Current Firestore rules are much safer than the V3 test rules, but ticket assignment is still initiated by the browser. For a production-money launch, move approval/ticket assignment to a trusted server/Cloud Function and add stronger customer privacy controls.

## Admin profile setup
General admin profile:
users/{UID}
- role: generalAdmin
- lotteryIds: []

Lottery admin profile is created by the General Admin dashboard.

## Local testing
Use an HTTP server, not file://:
python -m http.server 8158
Then open http://localhost:8158/
