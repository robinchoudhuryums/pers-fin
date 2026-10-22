#!/bin/bash
# Runs ONCE, when the db container starts with an empty data volume
# (docker-entrypoint-initdb.d). Creates the application role, the two
# databases (Perfin and Per-sistant — they can't share one: both have a
# user_settings table) and, as the superuser, the extensions both apps'
# migrations expect. pgvector may not be creatable by a non-superuser, and the
# migrations' `CREATE EXTENSION IF NOT EXISTS` is then a no-op.
set -euo pipefail

: "${APP_DB_USER:?}" "${APP_DB_PASSWORD:?}"

psql -v ON_ERROR_STOP=1 --username postgres --dbname postgres \
  --set app_user="$APP_DB_USER" --set app_password="$APP_DB_PASSWORD" <<'SQL'
CREATE ROLE :"app_user" LOGIN PASSWORD :'app_password';
CREATE DATABASE perfin OWNER :"app_user";
CREATE DATABASE persistent OWNER :"app_user";
SQL

for db in perfin persistent; do
  psql -v ON_ERROR_STOP=1 --username postgres --dbname "$db" <<'SQL'
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS vector;
SQL
done

echo "init: role ${APP_DB_USER}, databases perfin + persistent, extensions pgcrypto + vector"
