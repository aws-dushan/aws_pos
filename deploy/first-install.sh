#!/bin/bash
# One POS — first install on the SFA servers (run once, from this PC in Git Bash, after deploy/release.sh <version>):
#   deploy/first-install.sh <version>
# 1. writes /opt/aws/onepos/{live,test}/.env on AWS-App with fresh random passwords (mode 600) and copies them to AWS-Data;
# 2. makes the backup key on AWS-App and authorises it on AWS-Data, limited (rrsync) to writing into /opt/aws/onepos/offsite;
# 3. starts both databases, deploys <version> to test and live, publishes the Device Service, installs the gateway route.
# Safe to re-run: an existing .env or key is kept as it is.
#   ONEPOS_SEED_PASSWORD=<first admin password> deploy/first-install.sh <version>   (user ERP_Admin; ONEPOS_SEED_USER to change)
set -euo pipefail
export MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL="*"
V=${1:?version (deploy/release.sh made it)}
# The first administrator's username and password (it must be changed at the first sign-in): ONEPOS_SEED_USER / ONEPOS_SEED_PASSWORD.
SEED_USER=${ONEPOS_SEED_USER:-ERP_Admin}
SEED_PW=${ONEPOS_SEED_PASSWORD:?set ONEPOS_SEED_PASSWORD (the first admin password; it must be changed at the first sign-in)}
[[ "$SEED_USER$SEED_PW" =~ ^[A-Za-z0-9_.@-]+$ ]] || { echo "username and password: letters, digits and _ . @ - only here"; exit 1; }
APP=${ONEPOS_APP_HOST:-aws-app}
DATA=${ONEPOS_DATA_HOST:-aws-data}
HERE=$(cd "$(dirname "$0")" && pwd)
R=/opt/aws/onepos

echo "== environment files"
for e in live test; do
  port=5444; bp=/onepos; [ $e = test ] && { port=5445; bp=/onepos-test; }
  ssh "$APP" "E=$e PORT=$port BP=$bp R=$R SEED_USER=$SEED_USER SEED_PW=$SEED_PW bash -s" <<'EOS'
set -euo pipefail
mkdir -p "$R/$E" "$R/backups/$E" "$R/keys"
f=$R/$E/.env
if [ -f "$f" ]; then echo "$E: .env kept"; exit 0; fi
pw() { openssl rand -base64 33 | tr -d '/+=' | cut -c1-32; }
umask 077
sed -e "s|^ONEPOS_ENV=.*|ONEPOS_ENV=$E|" -e "s|^BASE_PATH=.*|BASE_PATH=$BP|" \
    -e "s|^PUBLIC_URL=.*|PUBLIC_URL=https://ralsnahashho.dyndns.org:1000$BP|" -e "s|^DB_PORT=.*|DB_PORT=$PORT|" \
    -e "s|^DB_OWNER_PASSWORD=.*|DB_OWNER_PASSWORD=$(pw)|" -e "s|^DB_APP_PASSWORD=.*|DB_APP_PASSWORD=$(pw)|" \
    -e "s|^PINS_SECRET=.*|PINS_SECRET=$(pw)|" -e "s|^SEED_ADMIN_USERNAME=.*|SEED_ADMIN_USERNAME=$SEED_USER|" -e "s|^SEED_ADMIN_PASSWORD=.*|SEED_ADMIN_PASSWORD=$SEED_PW|" \
    -e "s|^DATA_DIR=.*|DATA_DIR=$R/$E|" -e "s|^BACKUP_DIR=.*|BACKUP_DIR=$R/backups/$E|" \
    -e "s|^OFFSITE_TARGET=.*|OFFSITE_TARGET=admin-data@172.30.0.20:$E|" "$R/env.example" > "$f"
if [ "$E" = test ]; then
  sed -i -e "s|^BACKUP_KEEP_DAYS=.*|BACKUP_KEEP_DAYS=7|" -e "s|^API_MEMORY=.*|API_MEMORY=1g|" -e "s|^WEB_MEMORY=.*|WEB_MEMORY=512m|" \
         -e "s|^DB_MEMORY=.*|DB_MEMORY=1g|" -e "s|^DB_CPUS=.*|DB_CPUS=2|" -e "s|^PG_SHARED_BUFFERS=.*|PG_SHARED_BUFFERS=256MB|" \
         -e "s|^PG_EFFECTIVE_CACHE=.*|PG_EFFECTIVE_CACHE=768MB|" "$f"
fi
chmod 600 "$f"; echo "$E: .env written"
EOS
done

echo "== backup key (AWS-App -> AWS-Data, write-only into $R/offsite)"
ssh "$APP" "[ -f $R/keys/offsite_ed25519 ] || ssh-keygen -q -t ed25519 -N '' -C onepos-backup@aws-app -f $R/keys/offsite_ed25519"
pub=$(ssh "$APP" "cat $R/keys/offsite_ed25519.pub")
ssh "$DATA" "mkdir -p $R/offsite/live $R/offsite/test $R/live $R/test && grep -qF 'onepos-backup@aws-app' ~/.ssh/authorized_keys || echo 'command=\"/usr/bin/rrsync $R/offsite\",restrict $pub' >> ~/.ssh/authorized_keys"

echo "== environment files to AWS-Data"
for e in live test; do
  ssh "$APP" "cat $R/$e/.env" | ssh "$DATA" "umask 077; cat > $R/$e/.env.new && { [ -f $R/$e/.env ] && rm -f $R/$e/.env.new || mv $R/$e/.env.new $R/$e/.env; }"
done

echo "== databases"
pg=$(ssh "$APP" "cat $R/releases/$V/PG_IMAGE")
for e in test live; do ssh "$DATA" "$R/bin/onepos-db up $e $pg"; done

echo "== deploy $V"
for e in test live; do ssh "$APP" "$R/bin/onepos deploy $e $V"; done
if ssh "$APP" "[ -d $R/releases/$V/device-service ]"; then
  for e in test live; do ssh "$APP" "$R/bin/onepos publish-device $e $R/releases/$V/device-service"; done
fi

echo "== gateway route"
ssh "$APP" "$R/bin/onepos route"

echo
ssh "$APP" "$R/bin/onepos status"
echo
echo "First sign-in on each: $SEED_USER with the password given to this script; One POS asks for a new one straight away."
