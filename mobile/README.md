# Perfin iOS wrapper (Capacitor, remote-URL mode)

A native iOS shell whose WebView loads the **live Render deployment**
(`https://pers-fin-tracker.onrender.com`). There is no bundled web build —
every server deploy is instantly the "new app version." The home-screen PWA
keeps working independently alongside this app (separate icon, separate
session, and the PWA keeps receiving web-push notifications regardless of
which one you use — note that tapping a push notification opens the PWA,
not this app).

## What this build is (free-signing reality check)

Signed with a free Apple ID personal team:
- **Re-expires every 7 days** — rebuild from Xcode (or automate with AltStore).
- **No push notifications** — the APNs entitlement requires the $99/yr
  Apple Developer Program, and Web Push does not run inside WKWebView.
  Notifications keep arriving via the installed PWA.
- Pull-to-refresh works here (the shared web JS detects `window.Capacitor`).

If the native feel wins the A/B against the PWA, upgrading to the paid
program later needs no code changes here — just real signing + an APNs
delivery path server-side.

## Build & install (on your Mac)

```bash
cd mobile
npm install
npx cap sync ios        # installs CocoaPods deps into the generated project
npx cap open ios        # opens Xcode
```

In Xcode:
1. Select the **App** target → Signing & Capabilities → check
   "Automatically manage signing" → Team: *your personal team* (your Apple ID
   via Xcode → Settings → Accounts if it's not listed).
2. If the bundle id collides, change it (e.g. add a suffix) — it's
   `com.robinchoudhury.persfin` from `capacitor.config.json`.
3. Plug in your iPhone (or same-Wi-Fi wireless debugging), pick it as the
   run destination, hit Run.
4. First launch on-device: iPhone Settings → General → VPN & Device
   Management → trust your developer certificate.

Weekly re-sign: just hit Run again from Xcode (the project stays set up).

## Maintenance notes

- **Server URL / allowed hosts** live in `capacitor.config.json`
  (`server.url`, `server.allowNavigation` — Teller/Plaid domains are
  allowlisted so bank-link flows stay in the WebView; anything else opens
  in Safari).
- **Icons** were generated from `assets/icon.png` (the unified-shell
  mask-crop artwork) via `npx capacitor-assets generate --ios`. Add
  `assets/splash.png` (2732×2732) and re-run to customize the launch screen.
- **Offline**: the service worker doesn't run in WKWebView by default; if
  you want offline parity with the PWA, add `WKAppBoundDomains` (with the
  Render host) to `ios/App/App/Info.plist`. Without it, no network at cold
  start shows `www/index.html` (a branded "can't reach server" stub).
- This package is intentionally **not** in the root npm workspaces —
  server deploys must never install Capacitor/native tooling.

## Things to test on first install (Phase 2 checklist)

- PIN login + session persistence across app relaunches
- FaceID (WebAuthn works in WKWebView on iOS 15.5+)
- Pull-to-refresh, notch/safe-area, keyboard behavior on forms
- Teller Connect + Plaid Link flows (the allowNavigation list above —
  if a bank OAuth bounces to Safari and doesn't return cleanly, report it)
