# 1,000 screenshot load test

This directory is isolated from the production application. The test calls the existing `/api/customer/create-request` endpoint and does not modify customer or approval code.

Run:
```bash
node load-tests/1000-screenshot-test.js --base=https://www.tigraylottery.com --lottery=YOUR_LOTTERY_ID --image=./test-payment.jpg
```

Optional: `--concurrency=10`, `--count=1000`, `--start=1`.

The image should preferably be a screenshot compressed by the current customer UI and stay below the production 520,000-character screenshot limit. Each request uses a unique reference and remains pending. The test does not approve requests and does not call Telegram notification endpoints.

**This writes real Firestore data. Run it only when you intentionally want 1,000 pending test requests.**
