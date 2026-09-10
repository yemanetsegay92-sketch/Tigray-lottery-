# Tigray Lottery V3 — Firebase foundation

This build is based on the V2 project and fixes the browser-module/admin-login problems.

## Included
- Firestore shared data
- Firebase Authentication login
- Multiple lotteries
- Multiple tickets per buyer
- General Admin and Lottery Admin roles
- Lottery Admin visibility limited by `lotteryIds`
- Pending/approved/rejected requests
- Random unique ticket numbers on approval (development implementation)
- Vercel-ready static deployment

## Required setup
1. Firebase configuration is already filled in `firebase.js` for project `tigiray-lottery`.
2. In Firestore create `users/{YOUR_ADMIN_UID}` with:
   `{ role: "generalAdmin", lotteryIds: [] }`
3. Publish `firestore.rules`.

## Find your UID
Firebase Console → Authentication → Users → open your admin user → copy User UID.
Then Firestore Database → Data → create collection `users` → document ID = that UID.

## Important
The included ticket assignment is for development/testing. For a real-money launch, move approval and ticket assignment to a trusted server/Cloud Function and tighten Firestore rules further.
