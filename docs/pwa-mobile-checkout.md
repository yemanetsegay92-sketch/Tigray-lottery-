# Tigray Lottery: installable PWA and mobile checkout

This draft adds a home-screen app experience and improves receipt handling without changing the payment backend. It deliberately does not activate any payment feature, alter Firebase rules or deploy production.

- Web app manifest uses `display: standalone`, stable app ID, root scope, start URL, and 192/512 PNG icons.
- A shared installation button on public pages opens the browser's native installation prompt when supported. Otherwise it shows instructions for Chrome, Samsung Internet, iOS or an embedded webview. Native browsers may handle installation differently; embedded apps cannot be forced to install or launch an external browser.
- The service worker caches only a static offline notice. Public navigations are network-first with an offline notice on failure; it never caches purchase data, success responses, receipts, Firestore, API calls, admin pages or Telegram content. Payments and ticket lookup always require internet.
- The existing signed private Storage upload and Check.et workflow are unchanged.
- Receipt image compression now falls back to HTMLImageElement when an embedded browser does not support createImageBitmap(File). PDF support and server upload limits are unchanged. Async file selection and rapid double submissions are guarded.

## Tests

Automated: `node --test tools/test-pwa.cjs`, plus existing regression tests. Do not assume passing static tests proves real-device PWA installation.

**Actual in-app browser acceptance remains to be run on devices:**

1. Android Chrome and Samsung Internet: install the PWA, launch its icon, confirm own standalone window without address bar.
2. WhatsApp, Facebook/Messenger, TikTok and imo: open only a permitted public link, inspect page layout, form controls and installation guidance; record which apps permit file selection and any browser handoff.
3. Telegram Mini App: verify existing buyer flow unchanged.
4. On 320/360/390/412-pixel screens: name, phone, ticket count, reference, file picker, total and submit must remain usable and readable.
5. Test JPG/PNG/WebP/PDF selection; simulate createImageBitmap absence; race two attachments; double tap Submit against an isolated mocked API.
6. Switch offline: app displays a truthful notice; no payment can be submitted or shown as successful; verify caches contain no private/API responses.
7. Test with real users and payments only after platform policies and lottery authorization are confirmed.

Record device, Android version, app version, site origin, screenshots and issues. No true WhatsApp/imo/TikTok/Facebook built-in browser test has been performed in this PR.

## Release and rollback

Keep PR draft, review CI, and test in an isolated setup before merging. Git deployment is disabled for the feature branch. On a later approved release, confirm the install prompt and manifest/icon MIME over HTTPS. Roll back by restoring the previous Vercel deployment; the offline cache contains no transaction records.
