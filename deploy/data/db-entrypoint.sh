#!/bin/bash
# One POS database container: PostgreSQL (the image's own entrypoint) plus the pgBackRest scheduler next to it.
#   - once the server is up: stanza-create (no-op when it exists), then a first full backup if the repository has none;
#   - every night at BACKUP_AT: full on Sundays, differential on other days; then expire by the retention in pgbackrest.conf.
set -uo pipefail

mkdir -p /var/lib/pgbackrest/log
chown -R postgres:postgres /var/lib/pgbackrest

pgbr() { gosu postgres pgbackrest --stanza=onepos "$@"; }

scheduler() {
  until pg_isready -q -U "$POSTGRES_USER" -d "$POSTGRES_DB" -h /var/run/postgresql; do sleep 5; done
  # The image's first-run init starts a temporary server; wait until the real one has been up for a while.
  sleep 20
  until pg_isready -q -U "$POSTGRES_USER" -d "$POSTGRES_DB" -h /var/run/postgresql; do sleep 5; done
  pgbr stanza-create || echo "[backup] stanza-create failed; will retry tonight"
  if ! pgbr info --output=json 2>/dev/null | grep -q '"label"'; then
    echo "[backup] no backup yet: taking the first full backup"
    pgbr --type=full backup && pgbr check || echo "[backup] first full backup failed"
  fi
  local last=""
  while :; do
    local now day
    now=$(date +%H:%M); day=$(date +%F)
    if [ "$now" = "${BACKUP_AT:-01:45}" ] && [ "$last" != "$day" ]; then
      last=$day
      local type=diff; [ "$(date +%u)" = "7" ] && type=full
      echo "[backup] $(date '+%F %T') $type backup"
      pgbr stanza-create >/dev/null 2>&1
      if pgbr --type=$type backup; then
        date '+%F %T' > /var/lib/pgbackrest/last-ok
        echo "[backup] done"
      else
        echo "[backup] FAILED"
      fi
    fi
    sleep 30
  done
}

scheduler &
exec docker-entrypoint.sh "$@"
