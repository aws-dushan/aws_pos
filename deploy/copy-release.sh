#!/bin/bash
# Copies a release already built by release.sh (deploy/releases/<version>) to the servers, without building it again: for when the
# build finished but the copy failed (e.g. SSH to the servers was blocked). Same copy steps as release.sh; nothing is deployed.
#
#   deploy/copy-release.sh <version>
set -euo pipefail
export MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL="*"

HERE=$(cd "$(dirname "$0")" && pwd)
V=${1:?usage: deploy/copy-release.sh <version>}
APP=${ONEPOS_APP_HOST:-aws-app}
DATA=${ONEPOS_DATA_HOST:-aws-data}
OUT=$HERE/releases/$V
[ -f "$OUT/api.tar.gz" ] && [ -f "$OUT/PG_IMAGE" ] || { echo "No built release in $OUT"; exit 1; }
PG_IMAGE=$(cat "$OUT/PG_IMAGE")
step() { echo; echo "== $*"; }

step "copy to $APP"
ssh "$APP" "mkdir -p /opt/aws/onepos/releases/$V /opt/aws/onepos/bin"
scp -q "$OUT"/*.tar.gz "$OUT/PG_IMAGE" "$APP:/opt/aws/onepos/releases/$V/"
[ -d "$OUT/device-service" ] && scp -q -r "$OUT/device-service" "$APP:/opt/aws/onepos/releases/$V/"
scp -q "$HERE/app/compose.yml" "$APP:/opt/aws/onepos/compose.app.yml"
scp -q "$HERE/app/edge-onepos.conf" "$APP:/opt/aws/onepos/edge-onepos.conf"
scp -q "$HERE/env/env.example" "$APP:/opt/aws/onepos/env.example"
scp -q "$HERE/bin/onepos" "$APP:/opt/aws/onepos/bin/onepos"
ssh "$APP" "sed -i 's/\r$//' /opt/aws/onepos/bin/onepos /opt/aws/onepos/compose.app.yml /opt/aws/onepos/edge-onepos.conf /opt/aws/onepos/env.example && chmod +x /opt/aws/onepos/bin/onepos && /opt/aws/onepos/bin/onepos load $V"

step "copy database image + files to $DATA"
ssh "$DATA" "mkdir -p /opt/aws/onepos/bin"
if ! ssh "$DATA" "docker image inspect $PG_IMAGE >/dev/null 2>&1"; then
  gunzip -c "$OUT/postgres.tar.gz" | ssh "$DATA" "docker load -q"
fi
scp -q "$HERE/data/compose.yml" "$DATA:/opt/aws/onepos/compose.data.yml"
scp -q "$HERE/bin/onepos-db" "$DATA:/opt/aws/onepos/bin/onepos-db"
ssh "$DATA" "sed -i 's/\r$//' /opt/aws/onepos/bin/onepos-db /opt/aws/onepos/compose.data.yml && chmod +x /opt/aws/onepos/bin/onepos-db"

# Local copies: keep the newest three.
ls -1dt "$HERE"/releases/*/ | tail -n +4 | xargs -r rm -rf

step "release $V is on the servers"
echo "  test:  ssh $APP /opt/aws/onepos/bin/onepos deploy test $V"
echo "  live:  ssh $APP /opt/aws/onepos/bin/onepos deploy live $V"
