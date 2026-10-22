#!/usr/bin/env bash
# ============================================================================
# Nightly encrypted backup of both databases, run on the VPS by cron:
#   17 3 * * *  /opt/pers-fin/backup.sh >> /var/log/pers-fin-backup.log 2>&1
# ============================================================================
# The same format as .github/workflows/db-backup.yml, so its restore runbook
# applies unchanged: pg_dump custom format → gpg symmetric AES-256
# (<db>-YYYY-MM-DD.dump.gpg). Each file is VERIFIED before it counts: decrypted
# and read back with `pg_restore --list`. Then it is copied offsite with rclone
# and old copies are pruned locally and remotely. The time of each verified run
# is stamped in user_settings.last_backup_at, which Operator Checks reads.
#
# Settings come from /opt/pers-fin/.env (BACKUP_*). The passphrase lives in its
# own root-only file; keep a copy OUTSIDE this server — the backups are
# unreadable without it. Never prints database contents.
set -Eeuo pipefail

cd "$(dirname "$0")"
set -a; . ./.env; set +a

PASSFILE="${BACKUP_PASSPHRASE_FILE:-/root/.pers-fin-backup-passphrase}"
DIR="${BACKUP_DIR:-/var/backups/pers-fin}"
KEEP="${BACKUP_KEEP_DAYS:-7}"
REMOTE="${BACKUP_REMOTE:-}"
REMOTE_KEEP="${BACKUP_REMOTE_KEEP_DAYS:-90}"
HC="${BACKUP_HEALTHCHECK_URL:-}"
STAMP="$(date -u +%F)"

ping_hc() { [ -n "$HC" ] && curl -fsS -m 10 --retry 3 -o /dev/null "$HC$1" || true; }
CUR=""
fail() {
  echo "$(date -u +%FT%TZ) backup FAILED: ${CUR:+$CUR: }$*" >&2
  rm -f "${DIR:-/nonexistent}"/*.partial
  ping_hc /fail; exit 1
}
trap 'fail "line $LINENO"' ERR

[ -s "$PASSFILE" ] || fail "passphrase file $PASSFILE is missing or empty"
[ "$(stat -c %a "$PASSFILE")" = 600 ] || fail "$PASSFILE must be chmod 600"
command -v gpg >/dev/null || fail "gpg not installed"

install -d -m 700 "$DIR"
ping_hc /start

for db in perfin persistent; do
  CUR="$db"
  out="$DIR/$db-$STAMP.dump.gpg"
  tmp="$out.partial"
  docker compose exec -T db pg_dump -U postgres -Fc --no-owner --no-acl "$db" \
    | gpg --batch --yes --pinentry-mode loopback --passphrase-file "$PASSFILE" \
          --symmetric --cipher-algo AES256 -o "$tmp"
  # Verify: decrypts (gpg's integrity check) and is a readable archive.
  entries="$(gpg --batch --quiet --pinentry-mode loopback --passphrase-file "$PASSFILE" -d "$tmp" \
    | docker compose exec -T db pg_restore --list | grep -c ' TABLE ' || true)"
  [ "${entries:-0}" -gt 0 ] || fail "verification read no tables"
  mv "$tmp" "$out"
  echo "$(date -u +%FT%TZ) $db: $(du -h "$out" | cut -f1), $entries table entries"
done
CUR=""

# Record the verified backup for Settings → Sync Health → Operator Checks
# (SERVER_BACKUPS=true in app.env). A failed stamp doesn't fail the backup —
# the check will just report it as missing until the next night's stamp.
docker compose exec -T db psql -U postgres -d perfin -qc \
  "UPDATE user_settings SET last_backup_at = now() WHERE id = 1" >/dev/null \
  || echo "$(date -u +%FT%TZ) WARNING: couldn't record the backup time in user_settings" >&2

find "$DIR" -name '*.dump.gpg' -mtime +"$KEEP" -delete
find "$DIR" -name '*.partial' -delete

if [ -n "$REMOTE" ]; then
  rclone copy "$DIR" "$REMOTE" --include "*-$STAMP.dump.gpg"
  rclone delete "$REMOTE" --min-age "${REMOTE_KEEP}d" --include "*.dump.gpg"
  echo "$(date -u +%FT%TZ) copied to $REMOTE"
else
  echo "$(date -u +%FT%TZ) WARNING: BACKUP_REMOTE is empty — backups exist on this server only"
fi

ping_hc ""
echo "$(date -u +%FT%TZ) backup OK"
