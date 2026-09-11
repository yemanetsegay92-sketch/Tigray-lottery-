# Tigray Lottery

Professional customer-facing lottery management prototype using Firebase and Vercel.

## Customer side
- English and Tigrigna language support
- Mobile-first ticket purchase flow
- Quantity minus/plus controls
- Payment proof: reference number, screenshot, or both
- Screenshot compression before saving
- Customer status lookup by phone number
- Approved ticket numbers shown only after approval

## Admin side
- General Admin manages lotteries and Lottery Admin accounts
- One Lottery Admin can manage multiple lotteries
- Lottery Admin handles payment verification for assigned lotteries
- Sequential ticket allocation without exposing the next number to customers
- Approved/rejected requests leave the pending queue
- Approved sales table with CSV download and Excel copy
- Basic operational statistics

## Firebase
Use the Firebase web configuration already included in `firebase.js`.
Publish `firestore.rules` in Firebase Firestore Rules before testing.

## Deployment
Extract the project and deploy the folder containing `index.html` directly to Vercel.

## Important
This build records payment information and supports manual verification. It does not implement an online money-transfer gateway. Real-money operation should be enabled only after required regulatory and operational approvals.
