# Perfin → Per-sistant Integration

This branch closes the webhook gap between Perfin and Per-sistant. Before
this, Perfin was posting `insights_generated` webhooks to
`POST /api/perfin/webhook` but Per-sistant had no such endpoint, so every
insight email 404'd silently.

## What this branch adds

- `POST /api/perfin/webhook` — HMAC-verified receiver
  (`routes/perfin.js`). On `insights_generated`, queues a scheduled email
  with Perfin's pre-rendered HTML body; on `test`, returns OK.
- `GET /api/perfin/webhook/status` — reports whether the receiver is
  configured (for the settings UI).
- `body_html` column on `emails` + `perfin_webhook_recipient` on
  `user_settings` (`db/011_perfin_webhook.sql`).
- `server.js`: `express.json({ verify })` captures `req.rawBody` so the
  webhook handler verifies the signature against the exact bytes Perfin
  signed (not a restringified copy). Email scheduler now sends the HTML
  body alongside text when present.
- `routes/emails.js`: accepts `body_html` on create/update and includes
  it on manual send.
- `routes/settings.js`: accepts/returns `perfin_webhook_recipient` and
  exposes `perfin_webhook_configured`.
- `.env.example`: documents `PERSISTENT_WEBHOOK_SECRET` and `SSO_SECRET`.

## Forest + Mint palette

- `views/css-palette.js` — a small override layer that replaces the
  warm-tan primary + cyan accent with deep forest (`#4a8a5a`) + mint
  (`#6fd4b0`), visually distinct from Perfin while sharing the same
  component structure. Injected in `views.js` after the main stylesheet
  so the cascade wins.

## Configuration

On Per-sistant (this repo):
```
PERSISTENT_WEBHOOK_SECRET=<same openssl rand -base64 32 value used on Perfin>
SSO_SECRET=<same value used on Perfin>
# optional — otherwise falls back to SMTP_FROM / SMTP_USER:
# set via API:  PATCH /api/settings { "perfin_webhook_recipient": "you@example.com" }
```

On Perfin:
```
PERSISTENT_URL=https://<per-sistant host>
PERSISTENT_WEBHOOK_SECRET=<same value>
SSO_SECRET=<same value>
```

## Manual follow-up (not landed in this branch)

The settings page (`pages/settings.js`) could surface an input for
`perfin_webhook_recipient` and a status line from
`/api/perfin/webhook/status`. Until that UI lands, configure via:

```sh
curl -X PATCH http://localhost:3001/api/settings \
  -H 'Content-Type: application/json' \
  -d '{"perfin_webhook_recipient":"you@example.com"}'
```

The API already accepts and persists this field.
