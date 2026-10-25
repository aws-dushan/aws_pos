#!/bin/bash
# One POS nightly backup, run on the application server (container onepos-<env>-backup, deploy/app/compose.yml).
#   /backups/db/onepos-<env>-<stamp>.dump    pg_dump custom format: portable, restores on any PostgreSQL 17 (bin/restore.sh, bin/move)
#   /backups/files/onepos-<env>-<stamp>.tgz  attachments, sign-in keys, e-invoice / mail folders (DATA_DIR/files)
# then deletes copies older than KEEP_DAYS and, when OFFSITE_TARGET is set, mirrors /backups to the other server (rsync over ssh).
#
#   onepos-app-backup          scheduler (the container's entrypoint)
#   onepos-app-backup now      one backup immediately (bin/deploy.sh runs this before every live deploy); exit code = result
set -uo pipefail

one() {
  local stamp; stamp=$(date +%Y%m%d-%H%M%S)
  mkdir -p /backups/db /backups/files
  local db="/backups/db/onepos-${ONEPOS_ENV}-${stamp}.dump" files="/backups/files/onepos-${ONEPOS_ENV}-${stamp}.tgz"
  echo "[backup] $(date '+%F %T') dump -> $db"
  if ! pg_dump -h "$DB_HOST" -p "$DB_PORT" -U onepos_owner -d onepos -Fc -Z 6 -f "$db.part"; then
    rm -f "$db.part"; echo "[backup] dump FAILED"; return 1
  fi
  mv "$db.part" "$db"
  tar -czf "$files.part" -C /data . && mv "$files.part" "$files" || { rm -f "$files.part"; echo "[backup] files FAILED"; return 1; }
  find /backups/db /backups/files -type f -mtime +"${KEEP_DAYS:-14}" -name "onepos-${ONEPOS_ENV}-*" -delete
  date '+%F %T' > /backups/last-ok
  echo "[backup] ok ($(du -h "$db" | cut -f1) database, $(du -h "$files" | cut -f1) files)"
  offsite
}

offsite() {
  [ -n "${OFFSITE_TARGET:-}" ] || return 0
  [ -s /run/offsite_key ] || { echo "[backup] OFFSITE_TARGET set but no key mounted"; return 1; }
  install -m 600 /run/offsite_key /tmp/offsite_key
  if rsync -a --delete -e "ssh -i /tmp/offsite_key -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=/backups/.known_hosts -o BatchMode=yes" \
       /backups/db /backups/files /backups/last-ok "$OFFSITE_TARGET/"; then
    echo "[backup] copied to $OFFSITE_TARGET"
  else
    echo "[backup] copy to $OFFSITE_TARGET FAILED"
  fi
  rm -f /tmp/offsite_key
}

if [ "${1:-}" = "now" ]; then one; exit $?; fi

last=""
while :; do
  if [ "$(date +%H:%M)" = "${BACKUP_AT:-02:30}" ] && [ "$last" != "$(date +%F)" ]; then
    last=$(date +%F)
    one || true
  fi
  sleep 30
done
