# Public purchase abuse protection — staged production rollout

## Scope of this PR

- Adds a cheap 16 KiB JSON payload limit to the public purchase/upload authorization endpoint. Screenshots/PDFs are already uploaded **directly to private Storage** and are unaffected.
- Adds a **production-only**, default-off Firestore fixed-window backstop on the two public operations in `/api/customer/create-request`:
  - `submit`: 15 attempts/minute from one Vercel client IP.
  - `upload`: 30 signed receipt authorizations/minute from one Vercel client IP.
- Exceeded limits respond HTTP 429 and `Retry-After`. No file bytes, bank credentials, ticket numbers or payment references are added to the limiter.
- Admin endpoints, Telegram, Check.et auto-worker and Firestore ticket approval are unchanged.
- Existing buyer flow works normally with the guard OFF; it is **not enabled** by merging this PR.

## Why WAF first

Vercel's native WAF rate limiting checks requests **before they run a billed function**. The Firestore guard is only a secondary protection: it incurs reads and writes for each allowed request and itself could become costly under sustained attack. It is **not DDoS protection**.

Recommended safe initial WAF rollout on the production Vercel project:

1. Vercel -> project **Firewall** -> Configure -> New Rule (Hobby currently permits one rate-limit rule).
2. Match **Method POST** and **Path /api/customer/create-request**. Key: client IP; fixed window 60 seconds. Set an initially generous threshold (e.g., 60 requests/min/IP, combining upload+submit) and choose **Log**.
3. Review actual traffic, NAT/shared-network buyers, logs, 429 counts, and false positives. When safe, change action to 429 and adjust the limit. Do not block customers based on a guess.
4. Use Vercel usage alerts and cloud billing budgets. IP limits are not sufficient against distributed abuse; bot challenges may be required later.

Official documentation: https://vercel.com/docs/vercel-firewall/vercel-waf/rate-limiting

## Optional Firestore backstop (OFF until an explicit production decision)

1. Create a new **Production only** Vercel secret environment variable `LOTTERY_PUBLIC_RATE_LIMIT_PEPPER`, with at least 32 unpredictable bytes; never expose it in JavaScript, logs, GitHub or chat. It is distinct from the bank worker secret.
2. Leave `LOTTERY_PUBLIC_RATE_LIMIT_MODE` absent by default, so no extra Firestore read/writes occur. In preview environments it is always disabled.
3. After evaluating the WAF and limits, the owner may set `LOTTERY_PUBLIC_RATE_LIMIT_MODE=enforce` in Vercel Production and redeploy. Set pepper **before** enabling enforcement. Misconfigured enforcement fails closed with a 503 rather than allowing abuse.
4. If NAT/shared Wi-Fi buyers are blocked, remove the mode setting and redeploy, then adjust policy in a new reviewed PR.
5. Enable Firestore TTL on collection group `publicPurchaseRateLimits`, timestamp field `expiresAt`, to prevent counter document accumulation. TTL expiration is asynchronous and may incur database costs. This collection must remain denied for all direct client reads/writes (existing wildcard rules deny it).
6. Watch purchase success, 429/503/500 rates, Firestore contention, Vercel function invocations, and billing before gradually increasing exposure.

## Limitations and follow-up

- Server limiter consumes a Firestore transaction per allowed operation and **can contend** during same-IP bursts. WAF is preferred for very heavy traffic. These limits are deliberately conservative and unsuitable for a guaranteed 1,000-at-once shared-network deployment.
- Vercel overwrites `x-forwarded-for` on its hosted Functions. The guard uses only that header; malformed/missing IP fails closed when enforcing, not on the normal default-off path.
- A bad actor with many IP addresses can bypass per-IP limits. Follow up with a privacy-safe bot challenge, abuse alerting, and per-provider quotas.
- The limiter does not automatically refund payments, force approval, or change the successful CBE flow. Existing payment and notification queues remain intact.
- Do not use real customer payments in load testing. Use emulator/mock provider tests and an isolated lottery first.
- Do **not** merge until automated tests and independent code review pass. Do not automatically activate WAF blocking or the Firestore guard on the live site.
