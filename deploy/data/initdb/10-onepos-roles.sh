#!/bin/bash
# First start of an empty database only (docker-entrypoint-initdb.d): the API's login role with this environment's password, before the
# API's migrations run (and before a restore: a dump's grants name it). Migration 0001 creates onepos_app only when missing, so its
# development password never applies on a server.
set -euo pipefail
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" -v app_pw="$DB_APP_PASSWORD" <<'SQL'
CREATE ROLE onepos_app LOGIN PASSWORD :'app_pw' NOSUPERUSER NOBYPASSRLS;
SQL
