# Tigray Lottery V7.4

Fixes Telegram webhook reliability:
- Robust JSON body parsing on Vercel.
- Robust secret-header handling.
- `/start`, `/start@bot`, `/start admin_...`, `/link ...`, and `/connect ...` parsing.
- Webhook errors are surfaced in Vercel logs instead of silently swallowed.
- Setup endpoint reports sanitized Telegram webhook diagnostics.
- Existing buyer notifications, admin notifications, and Mini App remain.

Keep Telegram and Firebase credentials only in Vercel environment variables.


V7.5 uses a separate Telegram Admin Bot. Add these Production environment variables in Vercel: TELEGRAM_ADMIN_BOT_TOKEN, TELEGRAM_ADMIN_BOT_USERNAME (use tigraylotteryadmin_bot), TELEGRAM_ADMIN_WEBHOOK_SECRET, TELEGRAM_ADMIN_SETUP_SECRET. The existing customer-bot variables remain unchanged. Run /api/telegram/setup-admin?key=... once after deployment.
