# Tigray Lottery V8

Professional prototype for Tigray Lottery.

## V8 improvements
- Mistakenly approved requests can be cancelled before the lottery is drawn. Assigned ticket documents are released, but cancelled numbers are permanently retired and are not reused.
- General Admin can set a new temporary password for an existing Lottery Admin who forgets their password. Passwords are never stored in Firestore.
- Live draw panel: ten movable balls (0-9), one digit revealed per tap, with review and explicit save of the final draw result.
- Existing V7.5 Telegram customer/admin integration remains in place.
- Existing multi-lottery admin assignment and reports remain in place.

## Deployment
Upload/deploy the entire project. Keep all Telegram and Firebase secrets in Vercel Environment Variables; never commit secrets to GitHub.

## Firestore
The current Firestore rules can continue to protect the browser-based data operations. V8 cancellation and password-reset actions use trusted Vercel API functions with the Firebase Admin SDK, so no ticket-delete permission is needed in client rules.

## Final V8 additions
- Public home page has a WhatsApp Contact Us section controlled by General Admin.
- General Admin can save the public WhatsApp contact in `settings/site`.
- Public footer credits YOAS Digital Solution.
- Live draw uses opaque, colored 3D-style balls. Digits stay hidden until a ball is drawn/revealed.
- Cancel-approval endpoint uses Firebase Admin `DocumentSnapshot.exists` correctly.
