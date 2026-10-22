# Moving to a VPS: migration runbook

This moves the app from Render + Neon to one VPS that runs the app, Postgres
(with pgvector) and Caddy (HTTPS) under Docker Compose. Nothing here changes the
running Render deployment until step 7, and Neon is left untouched until step 11,
so rolling back is easy until then.

Files in this directory:

| File | Purpose |
|---|---|
| `docker-compose.yml` | The stack: `db` (pgvector/pgvector), `app` (the image from GHCR), `caddy` |
| `postgres-init/01-databases.sh` | First start only: the `app` role, the `perfin` + `persistent` databases, `pgcrypto` + `vector` |
| `Caddyfile` | HTTPS (Let's Encrypt) → `app:3000` |
| `.env.example` | Compose settings: domain, Postgres passwords, image tag, backup settings |
| `app.env.example` | The application's environment (the same variables as on Render) |
| `deploy.sh` | Server half of `.github/workflows/deploy-vps.yml`: pull a tag, restart, health-check, roll back on failure |
| `backup.sh` | Nightly encrypted backups, verified, copied offsite |

Expect about **half a day** the first time: about 2 h for steps 1–6 (you can do
these days ahead), 30–60 min for the cutover (steps 7–9), then the follow-ups.

Throughout, `$` lines run on the server unless marked **(laptop)**.

---

## 1. Provision the server

- **Size:** 2 vCPU, 4 GB RAM (2 GB is the minimum), 40 GB disk. For example
  Hetzner CX22 / CAX11 (ARM works — both images are multi-architecture) or a
  DigitalOcean / Vultr equivalent.
- **Image:** Ubuntu 24.04 LTS.
- **Turn on the provider's automatic snapshots/backups** (roughly 20% of the
  server price) — they protect the whole disk, on top of `backup.sh`.
- Add your SSH public key when you create it.

## 2. Harden it (one time)

```bash
# as root, the first time
$ adduser --disabled-password --gecos "" admin && usermod -aG sudo admin
$ install -d -m 700 -o admin -g admin /home/admin/.ssh
$ cp ~/.ssh/authorized_keys /home/admin/.ssh/ && chown admin:admin /home/admin/.ssh/authorized_keys
$ passwd admin          # sudo password

# SSH: keys only, no root login
$ cat > /etc/ssh/sshd_config.d/10-hardening.conf <<'EOF'
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin no
EOF
$ systemctl reload ssh
# Open a NEW terminal and check `ssh admin@<server>` works before closing this one.

# Firewall: SSH, HTTP, HTTPS only
$ ufw allow OpenSSH && ufw allow 80/tcp && ufw allow 443/tcp && ufw allow 443/udp && ufw --force enable

# Automatic security updates, rebooting at 04:30 when a kernel update needs it
$ apt-get update && apt-get install -y unattended-upgrades gnupg rclone
$ cat > /etc/apt/apt.conf.d/52pers-fin <<'EOF'
Unattended-Upgrade::Automatic-Reboot "true";
Unattended-Upgrade::Automatic-Reboot-Time "04:30";
EOF
$ dpkg-reconfigure -f noninteractive unattended-upgrades

# Docker Engine + Compose plugin (Docker's own repository)
$ curl -fsSL https://get.docker.com | sh
```

`ufw` does not filter ports that Docker publishes — this stack publishes only 80
and 443 (Caddy), and Postgres is reachable from the compose network only.

## 3. The deploy user and the files

```bash
$ adduser --disabled-password --gecos "" deploy && usermod -aG docker deploy
$ install -d -o deploy -g deploy -m 750 /opt/pers-fin /opt/pers-fin/dumps /opt/pers-fin/secrets
```

**(laptop)** copy this directory up:

```bash
scp deploy/vps/{docker-compose.yml,Caddyfile,deploy.sh,backup.sh,.env.example,app.env.example} admin@<server>:/tmp/
scp -r deploy/vps/postgres-init admin@<server>:/tmp/
```

```bash
$ cd /opt/pers-fin
$ sudo mv /tmp/{docker-compose.yml,Caddyfile,deploy.sh,backup.sh,.env.example,app.env.example} /tmp/postgres-init .
$ sudo chown -R deploy:deploy /opt/pers-fin && sudo chmod 755 deploy.sh backup.sh postgres-init/01-databases.sh
```

**The deploy key** — **(laptop)** generate a key used only by the workflow:

```bash
ssh-keygen -t ed25519 -N "" -C deploy-vps -f deploy-vps-key
```

On the server, pin it to `deploy.sh` so it can do nothing else:

```bash
$ sudo install -d -o deploy -g deploy -m 700 /home/deploy/.ssh
$ echo 'command="/opt/pers-fin/deploy.sh",no-port-forwarding,no-agent-forwarding,no-X11-forwarding,no-pty <contents of deploy-vps-key.pub>' \
    | sudo tee /home/deploy/.ssh/authorized_keys
$ sudo chown deploy:deploy /home/deploy/.ssh/authorized_keys && sudo chmod 600 /home/deploy/.ssh/authorized_keys
```

Being in the `docker` group is equivalent to root on this machine, which is why
the key is restricted to the one script.

## 4. DNS

Pick a hostname (e.g. `finance.yourdomain.com`) and add an **A** record (and
**AAAA** if the server has IPv6) pointing at the server, TTL 300. Caddy can only
get a certificate once this resolves.

## 5. Configuration

```bash
$ cd /opt/pers-fin
$ cp .env.example .env && cp app.env.example app.env && chmod 600 .env app.env
$ openssl rand -hex 24   # → POSTGRES_PASSWORD
$ openssl rand -hex 24   # → APP_DB_PASSWORD (also goes into both URLs in app.env)
$ nano .env              # DOMAIN, ACME_EMAIL, the two passwords, PG_MAJOR (see step 8b)
$ nano app.env           # every value from Render → Environment
```

In `app.env`:

- Copy each value from the Render dashboard **unchanged**, especially
  `TOKEN_ENCRYPTION_PASSPHRASE`. A different passphrase can't decrypt any stored
  bank token, and every bank would need re-linking.
- The two database URLs point at `db` (in the template) with `APP_DB_PASSWORD`.
- `PUBLIC_URL=https://<DOMAIN>`, `ALWAYS_ON=true` and `SERVER_BACKUPS=true`
  (already in the template). Render set `RENDER_EXTERNAL_URL` automatically;
  `PUBLIC_URL` replaces it (the insight email's "Open Dashboard" link is built
  from it). `ALWAYS_ON` turns the keep-alive ping off. `SERVER_BACKUPS` makes
  Settings → Sync Health → Operator Checks read the time `backup.sh` records,
  and stop expecting the Database Backup workflow and its secrets.
- Google Sheets: put the key file at `secrets/service-account-key.json`
  (`chmod 644`) and uncomment the `volumes:` block under `app` in
  `docker-compose.yml`.

**The backup passphrase.** Use the same one as the GitHub
`BACKUP_ENCRYPTION_PASSPHRASE` secret if you already set it, so older backups
stay readable:

```bash
$ sudo sh -c 'umask 077; cat > /root/.pers-fin-backup-passphrase'   # paste it, then Ctrl-D
```

Keep a copy in your password manager. The backups can't be read without it.

## 6. The first image and the deploy workflow

In GitHub → **Settings → Secrets and variables → Actions**:

| Kind | Name | Value |
|---|---|---|
| Secret | `VPS_HOST` | the server's IP or hostname |
| Secret | `VPS_SSH_KEY` | contents of `deploy-vps-key` (the private half) |
| Secret | `VPS_KNOWN_HOSTS` | **(laptop)** `ssh-keyscan -t ed25519 <server>`. Check the fingerprint against the server's `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub` |
| Variable | `VPS_DOMAIN` | your `DOMAIN` |

Leave `VPS_DEPLOY_ENABLED` **unset** until step 9. The workflow does nothing
without it.

The image holds no secrets (certificates and keys come from `app.env`). While
the repo is public its GHCR package may be public too; making the repo private
makes new packages private, and the deploy logs in to GHCR on each run either
way.

---

## 7. Rehearsal (do this at least once before the cutover)

The rehearsal runs steps 8b–8e against a **live** Neon, **without starting the
app**. A second app instance would run the scheduled jobs (bank syncs, digest
emails) alongside Render. It checks that the dump, restore and token decryption
all work, with no downtime. Because Render is still writing, row counts in 8e
may differ by a few recent rows (new transactions, notifications). Only the
cutover needs them equal.

After the rehearsal, start the real cutover from a clean slate:

```bash
$ cd /opt/pers-fin && docker compose down -v      # -v deletes the rehearsal database volume
```

## 8. Cutover

### 8a. Stop writes

1. GitHub → **Actions**: disable **Daily Sync**, **Weekly Reconcile**,
   **Keep Alive**, **Knowledge Reindex** and **Job Radar Refresh** for the window.
   They call the old address.
2. Render → the service → **Settings → Suspend Web Service**. Nothing writes to
   Neon from here on.

### 8b. Check Neon's Postgres version

Use Neon's **direct** connection string (Dashboard → Connect → turn *Connection
pooling* OFF, so the host has no `-pooler`). `pg_dump` needs a direct session.
Use `read -rs` so the password stays out of shell history:

```bash
$ read -rsp "Perfin Neon URL: " NEON_PERFIN; echo
$ read -rsp "Per-sistant Neon URL: " NEON_PERSISTENT; echo
$ docker run --rm -e U="$NEON_PERFIN" pgvector/pgvector:pg16 sh -c 'psql "$U" -Atc "show server_version"'
```

If it prints **17.x**, set `PG_MAJOR=17` in `.env` and use `pg17` in every
`docker run` below. The target must be the same major version as Neon or newer,
and `pg_dump`'s client must be at least the server's version.

### 8c. Dump both databases

```bash
$ cd /opt/pers-fin
$ for pair in "perfin:$NEON_PERFIN" "persistent:$NEON_PERSISTENT"; do
    name="${pair%%:*}"; url="${pair#*:}"
    docker run --rm -e U="$url" -v /opt/pers-fin/dumps:/dumps pgvector/pgvector:pg16 \
      sh -c "pg_dump \"\$U\" -Fc --no-owner --no-acl -f /dumps/$name.dump" \
      && echo "$name: $(du -h dumps/$name.dump | cut -f1)"
  done
```

If `PERSISTENT_DATABASE_URL` on Render was never set (Per-sistant sharing
Perfin's database), the second dump is the same database. Restore it as both;
each app only uses its own tables.

### 8d. Start Postgres and restore

```bash
$ docker compose up -d db
$ docker compose logs db | grep "init:"     # → init: role app, databases perfin + persistent, extensions …

$ for db in perfin persistent; do
    # Skip the dump's extension entries: the init script already created
    # pgcrypto + vector as the superuser.
    docker compose exec -T db sh -c "pg_restore -l /dumps/$db.dump | grep -v -E 'EXTENSION - |COMMENT - EXTENSION ' > /tmp/$db.list"
    docker compose exec -T db pg_restore -U postgres -d "$db" --no-owner --no-acl --role=app \
      -L "/tmp/$db.list" "/dumps/$db.dump" 2> "restore-$db.err"
    echo "$db: exit $? — $(grep -c 'error' "restore-$db.err") error line(s)"
  done
$ docker compose exec -T db vacuumdb -U postgres --all --analyze-only --quiet
```

Read any `restore-*.err` that isn't empty. A warning about a Neon-only role or
setting can be ignored. A failed `CREATE TABLE` / `COPY` means stop and roll
back (step 10).

### 8e. Verify the copy

Row counts on both sides. They must match exactly, since nothing writes during
the window:

```bash
$ count() { # count <db> <neon-url> <table>…
    db=$1; url=$2; shift 2
    for t in "$@"; do
      a=$(docker run --rm -e U="$url" pgvector/pgvector:pg16 sh -c "psql \"\$U\" -Atc 'select count(*) from $t'")
      b=$(docker compose exec -T db psql -U postgres -d "$db" -Atc "select count(*) from $t")
      printf '%-28s neon=%-8s vps=%-8s %s\n' "$t" "$a" "$b" "$([ "$a" = "$b" ] && echo ok || echo MISMATCH)"
    done
  }
$ count perfin "$NEON_PERFIN" transactions linked_accounts plaid_items teller_enrollments \
    sync_cursors investment_accounts investment_holdings financial_insights net_worth_snapshots \
    account_balance_snapshots budgets financial_goals detected_subscriptions payee_obligations notification_log
$ count persistent "$NEON_PERSISTENT" todos notes emails contacts attachments documents facts \
    habits habit_logs job_listings user_settings
```

Check that every stored bank token decrypts with the passphrase (it prints only
counts):

```bash
$ read -rsp "TOKEN_ENCRYPTION_PASSPHRASE: " TEP; echo
$ docker compose exec -T db psql -U postgres -d perfin -v pass="$TEP" -At <<'SQL'
SELECT 'tokens: ' || count(*) || ', undecryptable: ' || count(*) FILTER (WHERE perfin_try_decrypt(access_token_enc, :'pass') IS NULL)
FROM (SELECT access_token_enc FROM teller_enrollments
      UNION ALL SELECT access_token_enc FROM plaid_items WHERE status <> 'CSV'
      UNION ALL SELECT access_token_enc FROM plaid_investment_items) t;
SQL
$ unset TEP
```

`undecryptable` must be **0**. If it isn't, the passphrase in `app.env` is wrong
— fix it before going further.

### 8f. Start the app (first deploy)

1. Start HTTPS first. Caddy gets the certificate while the app is still down,
   and answers 502 until the app is up:

```bash
$ docker compose up -d --no-deps caddy
$ docker compose logs -f caddy      # wait for "certificate obtained successfully", Ctrl-C
```

2. GitHub → Settings → Variables: set `VPS_DEPLOY_ENABLED` = `true`.
3. Actions → **Deploy to VPS** → **Run workflow** (on `main`, tag blank). It
   builds the image, pushes it to GHCR, and runs `deploy.sh`, which starts `app`
   and waits for it to be healthy. Boot runs both apps' migrations. They are
   idempotent, so on the restored schema they only add what's missing (on Neon
   without pgvector, this is when Knowledge's vector tables are created; the next
   vault sync embeds). Its last step checks `https://<DOMAIN>/health` from
   outside.

### 8g. Check it works

- `https://<DOMAIN>/` → PIN → lands in Per-sistant; open Perfin.
- **Settings → Sync Health**: no `decryption_failed`, no new errors. Run
  **Sync now** (both providers) and **Sync Balances**; both succeed.
- Dashboard numbers match what Render showed (net worth, this month's spending).
- Settings → Keep-Alive says the server is always on (`ALWAYS_ON`), with no
  controls left to change.
- Per-sistant **Knowledge** → status shows the vault and embeddings ready; run
  one **Reindex**.
- Send yourself a **test notification** (Settings → Notifications).

## 9. Point everything at the new address

| What | Change |
|---|---|
| GitHub secret `SERVER_URL` | `https://<DOMAIN>`, then re-enable **Daily Sync**, **Weekly Reconcile**, **Knowledge Reindex** and **Job Radar Refresh** (all optional backstops now). Leave **Keep Alive** disabled. |
| Passkeys / Face ID | Re-register in Settings → Security. A passkey is tied to the hostname, so the onrender.com ones don't work here. |
| Home-screen apps (PWA) | Remove the old icons; Add to Home Screen from the new address. Allow push notifications again. |
| Calendar feed | Re-subscribe to `https://<DOMAIN>/calendar.ics?token=…` |
| Plaid dashboard | Add the new domain anywhere it lists allowed domains / OAuth redirect URIs |
| Teller dashboard | Same check for the application's domain settings |
| `mobile/capacitor.config.json` | `server.url` + `allowNavigation` → the new host (a code change) |
| Uptime monitor | Point it at `https://<DOMAIN>/health` |

## 10. Rollback (while Neon is still there)

Neon has not been written to since 8a, so going back is:

```bash
$ cd /opt/pers-fin && docker compose stop app caddy
```

Then Render → **Resume Web Service**, set `SERVER_URL` back, and re-enable the
workflows. Anything written on the VPS after the cutover isn't on Neon. Bank data
comes back on the next sync (idempotent); manual edits made in between would need
re-doing, or a reverse dump/restore (step 8 with the roles swapped).

## 11. Decommission (after ~2 weeks of normal running)

1. Take one last Neon dump of each database (8c), encrypt it
   (`gpg --symmetric --cipher-algo AES256`) and keep it offsite.
2. Delete the Render service, then the Neon project.
3. Disable **Database Backup** and **Keep Alive** in GitHub → Actions. Neither
   can do anything for this server, and Operator Checks lists both as "not
   needed" (`SERVER_BACKUPS` / `ALWAYS_ON`) rather than warning.

---

## Backups

`backup.sh` dumps both databases nightly, encrypts each with the passphrase
file, **verifies** each file (decrypts it and reads its table list back), copies
it offsite with rclone, and prunes old copies. The format matches
`db-backup.yml`, so its restore instructions still apply.

**Offsite storage** (Backblaze B2 shown; anything rclone supports works):

```bash
$ sudo rclone config            # new remote "b2", type b2, an application key limited to one bucket
$ sudo rclone mkdir b2:pers-fin-backups
$ sudo nano /opt/pers-fin/.env  # BACKUP_REMOTE=b2:pers-fin-backups
```

Optionally create a free healthchecks.io check (daily, 2 h grace) and put its
URL in `BACKUP_HEALTHCHECK_URL`. A missed or failed night then emails you.

Each verified run is stamped in `user_settings.last_backup_at`. Settings →
Sync Health → Operator Checks shows "Database backup" as failing until the first
stamp and again whenever the newest one is more than 36 hours old. That check
needs no GitHub token.

**Schedule and first run:**

```bash
$ sudo /opt/pers-fin/backup.sh       # → perfin: …, persistent: …, copied to b2:…, backup OK
$ echo '17 3 * * * root /opt/pers-fin/backup.sh >> /var/log/pers-fin-backup.log 2>&1' | sudo tee /etc/cron.d/pers-fin-backup
```

**Restore drill** (do one now, then once or twice a year). It restores into
scratch databases next to the real ones:

```bash
$ cd /opt/pers-fin && f=$(ls -t /var/backups/pers-fin/perfin-*.dump.gpg | head -1)
$ sudo gpg --batch --pinentry-mode loopback --passphrase-file /root/.pers-fin-backup-passphrase -d "$f" > dumps/drill.dump
$ docker compose exec -T db createdb -U postgres -O app drill
$ docker compose exec -T db psql -U postgres -d drill -c 'CREATE EXTENSION pgcrypto; CREATE EXTENSION vector;'
$ docker compose exec -T db sh -c "pg_restore -l /dumps/drill.dump | grep -v -E 'EXTENSION - |COMMENT - EXTENSION ' > /tmp/drill.list"
$ docker compose exec -T db pg_restore -U postgres -d drill --no-owner --role=app -L /tmp/drill.list /dumps/drill.dump
$ docker compose exec -T db psql -U postgres -d drill -Atc 'select count(*) from transactions'
$ docker compose exec -T db dropdb -U postgres drill && rm dumps/drill.dump
```

**Restoring for real** (after a disaster) is the same, into `perfin` /
`persistent` on a fresh stack: `docker compose down -v`, `up -d db`, then step 8d
with the decrypted files.

## Routine upkeep

| When | What |
|---|---|
| Automatic | Security updates + 04:30 reboots (unattended-upgrades); nightly backups; deploys on each push to `main` |
| Monthly (~10 min) | `df -h /` (keep under 70%); `tail /var/log/pers-fin-backup.log`; `docker compose ps` all healthy |
| Quarterly (~15 min) | Postgres minor update: `docker compose pull db && docker compose up -d db` (minor versions are drop-in); `docker system df` / `docker image prune` |
| Yearly | A restore drill; `apt-get dist-upgrade`. Every ~2 years: Ubuntu LTS upgrade, or rebuild the server from this runbook |
| Postgres major (16→17, optional; 16 is supported to Nov 2028) | Take a backup, `docker compose down`, keep the old volume, set `PG_MAJOR=17`, start a fresh volume and restore (step 8d) from the backup. Confirm, then remove the old volume |

**Rolling back a bad deploy:** Actions → **Deploy to VPS** → Run workflow with
the previous commit's SHA as *tag*. `deploy.sh` also rolls back by itself when a
new image doesn't become healthy within 2 minutes.

**Logs:** `docker compose logs --since 1h app` (rotated at 3 × 10 MB per
container).
