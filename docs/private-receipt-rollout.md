# Private receipt upload rollout

## Why

The previous 20,000-buyer test uploaded images/PDFs through Vercel, bringing Fast Origin Transfer usage to 9.65 GB of 10 GB. The new implementation sends bytes browser -> private Cloud Storage, while Vercel issues small signed forms and validates stored metadata.

## Checkout flow

1. The existing 200–300 KB JPEG compressor is reused. PDF uploads up to 2 MB and transaction references without uploads are still supported.
2. POST /api/customer/receipt-upload issues a 10-minute GCS V4 signed POST policy, restricted to a random temporary object, MIME type, session metadata and upload size.
3. The browser uploads the binary file with FormData directly to Google Cloud Storage.
4. POST /api/customer/create-request receives only a small HMAC-signed proofUploadToken. It verifies the lottery, session, GCS metadata, file limits and magic bytes using small reads; it copies the private object into a permanent storage path before recording the request and an atomic one-time claim in Firestore.
5. Lottery admins receive a 60-second signed private read URL after Firebase authentication/authorization. Receipt bytes also bypass Vercel when admins view them.

## MANDATORY: production bucket CORS

Upload the supplied config/storage.cors.json into Google Cloud Shell, or clone this PR branch and run in its root:

    gcloud config set project tigiray-lottery
    gcloud storage buckets update gs://tigiray-lottery.firebasestorage.app --cors-file=config/storage.cors.json
    gcloud storage buckets describe gs://tigiray-lottery.firebasestorage.app --format="json(cors_config)"

The config permits only https://tigraylottery.com and https://www.tigraylottery.com.
For preview browser testing, add the EXACT preview origin temporarily, then remove it. CORS permits browser requests; it does not make the bucket public. Keep Firebase Storage client rules deny-all and do not grant allUsers access.

The existing FIREBASE_SERVICE_ACCOUNT_JSON credentials are reused to sign policies and object-read URLs. The service account needs GCS object permissions to read, create, copy and delete objects. Optionally configure PAYMENT_PROOF_TOKEN_SECRET as a separate random 32+ character Vercel environment secret; otherwise a domain-separated HMAC key is derived from the private key already held by the server. Never commit keys.

## Optional orphan cleanup

Temporary uploads are stored under payment-proof-incoming/. The sample config/storage.receipt-lifecycle.json deletes only those objects older than 1 day. Check the bucket's current lifecycle rules and MERGE the new rule; do not overwrite any existing rules blindly. Final payment-proofs/ are excluded.

## Security and rollout checks

- A signed policy constrains expiry, size, exact MIME, metadata and a random object name.
- Once validated, receipts are copied to a final location that the client CANNOT overwrite with its original signed policy. A Firestore receiptUploadClaims transaction prevents token reuse for multiple checkouts.
- The signer endpoint is anonymous because checkout supports buyers without accounts. Before production, add Vercel Firewall rate limits to /api/customer/receipt-upload and /api/customer/create-request to prevent upload-policy abuse and runaway Storage charges.
- Test one reference-only purchase, JPEG, PDF, admin receipt download, duplicate reference, tampered/expired token, oversized PDF, invalid mime and unfinished upload.
- Old cached checkout clients posting base64 proof data now receive a prompt to refresh the page, intentionally preventing future high-transfer uploads through Vercel.
- Confirm the Vercel Fast Origin Transfer meter stays low for new receipts.
- This PR is not deployed automatically. Set bucket CORS, test the preview in the browser, then merge only after validation.

## Test

    node tools/test-direct-receipts.js

Automated unit tests check token signatures, expiry, MIME, size and lottery binding. Actual Cloud Storage upload tests still require bucket CORS and Google credentials.
