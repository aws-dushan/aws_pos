#!/bin/bash
# Builds a One POS release ON the app server (aws-app) from the code in this checkout and deploys it: for when this PC can't reach
# the servers by SSH, or the update is done from the server itself (RDP). The same images as deploy/release.sh, built here.
#
#   cd /opt/aws/onepos/src && git pull && deploy/server-update.sh <version> [both|test|live]
#     both (default): test first; live only when test is healthy.   test: test only.   live: live only (a version already on test).
#
# The database image is not built here (it lives on aws-data): when deploy/postgres.Dockerfile or deploy/data/ changed, use
# deploy/release.sh from the PC instead; this script stops and says so.
set -euo pipefail
V=${1:?usage: deploy/server-update.sh <version> [both|test|live]}
WHAT=${2:-both}
HERE=$(cd "$(dirname "$0")" && pwd)
REPO=$(cd "$HERE/.." && pwd)
ROOT=/opt/aws/onepos
step() { echo; echo "== $*"; }
die() { echo "!! $*" >&2; exit 1; }

case "$WHAT" in both|test|live) ;; *) die "the second word is both, test or live" ;; esac
[ -x "$ROOT/bin/onepos" ] || die "$ROOT/bin/onepos is missing: this script runs on the app server (aws-app)"
cd "$REPO"
echo "One POS $V from $(git log --oneline -1 2>/dev/null || echo 'this folder')"

# The database image of this code; it must be the one the servers already have (it is built and copied by release.sh).
PG_HASH=$(cat "$HERE/postgres.Dockerfile" "$HERE"/data/*.sh "$HERE"/data/*.conf "$HERE"/data/initdb/* | sha1sum | cut -c1-10)
PG_IMAGE=onepos-postgres:17-$PG_HASH
LAST_PG=$(ls -1dt "$ROOT"/releases/*/ 2>/dev/null | while read -r d; do [ -f "$d/PG_IMAGE" ] && cat "$d/PG_IMAGE" && break; done || true)
if [ -n "$LAST_PG" ] && [ "$LAST_PG" != "$PG_IMAGE" ]; then
  die "the database image changed ($LAST_PG -> $PG_IMAGE): release this version from the PC with deploy/release.sh"
fi

if [ "$WHAT" != live ]; then
  step "build onepos-api:$V"
  docker build -q -f "$HERE/api.Dockerfile" --build-arg VERSION="$V" -t "onepos-api:$V" "$REPO"
  for e in live test; do
    bp=/onepos; [ $e = test ] && bp=/onepos-test
    step "build onepos-web-$e:$V (prefix $bp)"
    docker build -q -f "$HERE/web.Dockerfile" --build-arg VERSION="$V" --build-arg BASE_PATH=$bp \
      --build-arg API_URL="http://onepos-$e-api:8080" -t "onepos-web-$e:$V" "$REPO/web"
  done
  mkdir -p "$ROOT/releases/$V"
  echo "$PG_IMAGE" > "$ROOT/releases/$V/PG_IMAGE"
  # The deploy kit's own files, as release.sh copies them.
  step "update the deploy files"
  cp "$HERE/app/compose.yml" "$ROOT/compose.app.yml"
  cp "$HERE/app/edge-onepos.conf" "$ROOT/edge-onepos.conf"
  cp "$HERE/env/env.example" "$ROOT/env.example"
  cp "$HERE/bin/onepos" "$ROOT/bin/onepos"
  sed -i 's/\r$//' "$ROOT/bin/onepos" "$ROOT/compose.app.yml" "$ROOT/edge-onepos.conf" "$ROOT/env.example"
  chmod +x "$ROOT/bin/onepos"
fi

if [ "$WHAT" != live ]; then
  step "deploy test $V"
  "$ROOT/bin/onepos" deploy test "$V" || die "test isn't healthy: live was left as it is"
fi
if [ "$WHAT" != test ]; then
  step "deploy live $V"
  "$ROOT/bin/onepos" deploy live "$V"
fi

step "done"
tail -3 "$ROOT/deploy.log"
