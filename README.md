# Tigray Lottery V5

V5 improves the V4 workflow:

1. General Admin no longer sees individual payment request cards. Lottery Admins are responsible for approving/rejecting their assigned lottery's payments.
2. Pending payment cards disappear after approval/rejection.
3. Every approved request stays in a report table for the lottery admin and can be downloaded as CSV or copied as tab-separated data directly into Excel/Google Sheets.
4. General Admin sees lottery-level counts/value and can open an approved-only summary report.
5. Payment screenshots are compressed in the buyer's browser before being stored. The target is <= 300 KB (with a hard safety ceiling of 360 KB).
6. General Admin creation of lottery-admin accounts uses a secondary Firebase Auth instance, so the General Admin session is not replaced.

## Important production note
This is still a prototype for testing. The approval/ticket assignment is browser-initiated. Before any real-money public launch, move approval/ticket assignment to trusted server-side code (Cloud Functions/Cloud Run), strengthen phone-status privacy, validate all fields in Firestore rules, and verify lottery/payment licensing and compliance requirements.
