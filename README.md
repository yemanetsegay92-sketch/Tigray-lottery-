# Tigray Lottery V7

V7 keeps the tested V6 website/admin workflow and adds Telegram integration.

## What V7 adds
- Telegram bot welcome flow with a Telegram Mini App button.
- Telegram Mini App at `/telegram.html` for viewing active lotteries and opening the buying flow inside Telegram.
- Lottery Admin can connect a Telegram account from the admin dashboard.
- New ticket requests notify every connected Lottery Admin assigned to that lottery.
- After a Lottery Admin approves or rejects a request in the web dashboard, the buyer receives a Telegram notification when their request is linked to Telegram.
- Website buyers can click **Get Telegram notifications** after submitting a request and then press **Start** in the bot.
- Telegram bot token and Firebase Admin credentials stay on the Vercel server; they are never placed in browser JavaScript.

## Vercel environment variables
Set these in the Vercel project before using Telegram:

`TELEGRAM_BOT_TOKEN` = token from @BotFather

`TELEGRAM_BOT_USERNAME` = bot username without the @ sign

`TELEGRAM_WEBHOOK_SECRET` = a long random secret string (for example 32+ random characters)

`TELEGRAM_SETUP_SECRET` = another long random secret used only to run the setup endpoint

`TELEGRAM_MINI_APP_URL` = `https://tigraylottery.com/telegram.html`

`FIREBASE_SERVICE_ACCOUNT_JSON` = the complete Firebase service-account JSON. Keep this secret. Do not paste it into chat or browser code.

## Firebase service account
Firebase Console → Project settings → Service accounts → Generate new private key.
Copy the complete JSON into the Vercel environment variable `FIREBASE_SERVICE_ACCOUNT_JSON`.

## Telegram bot setup
1. Create a dedicated bot with @BotFather and copy its token.
2. Set `TELEGRAM_BOT_TOKEN` and `TELEGRAM_BOT_USERNAME` in Vercel.
3. Redeploy.
4. Visit:
   `https://tigraylottery.com/api/telegram/setup?key=YOUR_TELEGRAM_SETUP_SECRET`
5. The endpoint will set the webhook, `/start` and `/help` commands, and the Telegram chat menu button.
6. Open the bot and press **Start**.

## Connecting a Lottery Admin
Login as a Lottery Admin → **Connect Telegram** → open the bot → press **Start** → return to the dashboard and refresh.

## Buyer notifications
- Buyers who use the Telegram Mini App are automatically linked for Telegram notifications.
- Website buyers can choose **Get Telegram notifications** after submitting their request and then press **Start** in the bot.
- If a buyer never connects Telegram, the normal website status checker continues to work.

## Important
This stage uses Telegram for notifications and the Mini App only. Approval/rejection stays in the web admin dashboard.

Before real-money launch, move approval/ticket assignment and notification triggers to trusted server-side automation and complete the required bank/regulatory integration and security review.
