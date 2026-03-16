#!/bin/sh
# Write PEM files from environment variables if they don't already exist on disk.
# This supports platforms like Render (Secret Files) and Fly.io ([[files]]) where
# PEM content can be injected as env vars or mounted directly.

CERT_PATH="${TELLER_CERT_PATH:-./certificate.pem}"
KEY_PATH="${TELLER_KEY_PATH:-./private_key.pem}"

# If cert file doesn't exist but env var is set, write it with restrictive permissions
if [ ! -f "$CERT_PATH" ] && [ -n "$TELLER_CERT_CONTENT" ]; then
  umask 077
  printf '%s\n' "$TELLER_CERT_CONTENT" > "$CERT_PATH"
  echo "Wrote certificate to $CERT_PATH"
fi

if [ ! -f "$KEY_PATH" ] && [ -n "$TELLER_KEY_CONTENT" ]; then
  umask 077
  printf '%s\n' "$TELLER_KEY_CONTENT" > "$KEY_PATH"
  echo "Wrote private key to $KEY_PATH"
fi

exec "$@"
