#!/bin/bash
# Builds a One POS release on this PC and copies it to the servers (Git Bash; needs Docker, the .NET SDK and `ssh aws-app` / `ssh aws-data`).
#
#   deploy/release.sh [version]        build + copy + load (default version: yyyy.mm.dd-HHMM)
#   ssh aws-app /opt/aws/onepos/bin/onepos deploy test <version>     try it on test
#   ssh aws-app /opt/aws/onepos/bin/onepos deploy live <version>     the SAME release on live, once test is accepted
#
# One release = onepos-api:<v> (the same image for test and live), onepos-web-live:<v> and onepos-web-test:<v> (identical source, each built
# with its web address prefix), the database / backup image onepos-postgres:17-<hash> (rebuilt only when deploy/data changes), and the
# till Device Service installer built for the servers' web address (published to both environments; tills update within 6 hours).
#   SKIP_DEVICE=1 deploy/release.sh …  leaves the Device Service out (nothing changed in it).
set -euo pipefail
# Git Bash on Windows would turn /onepos into C:/…/Git/onepos in the build arguments.
export MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL="*"

HERE=$(cd "$(dirname "$0")" && pwd)
REPO=$(cd "$HERE/.." && pwd)
# docker.exe and powershell need Windows paths (C:/…) under Git Bash; scp and the shell keep the normal ones.
DHERE=$(cd "$HERE" && (pwd -W 2>/dev/null || pwd))
DREPO=$(cd "$REPO" && (pwd -W 2>/dev/null || pwd))
V=${1:-$(date +%Y.%m.%d-%H%M)}
APP=${ONEPOS_APP_HOST:-aws-app}
DATA=${ONEPOS_DATA_HOST:-aws-data}
PUBLIC_HOST=${ONEPOS_PUBLIC_HOST:-https://ralsnahashho.dyndns.org:1000}
OUT=$HERE/releases/$V
mkdir -p "$OUT"
step() { echo; echo "== $*"; }

PG_HASH=$(cat "$HERE/postgres.Dockerfile" "$HERE"/data/*.sh "$HERE"/data/*.conf "$HERE"/data/initdb/* | sha1sum | cut -c1-10)
PG_IMAGE=onepos-postgres:17-$PG_HASH
echo "$PG_IMAGE" > "$OUT/PG_IMAGE"

step "build onepos-api:$V"
docker build -q -f "$DHERE/api.Dockerfile" --build-arg VERSION="$V" -t "onepos-api:$V" "$DREPO"
for e in live test; do
  bp=/onepos; [ $e = test ] && bp=/onepos-test
  step "build onepos-web-$e:$V (prefix $bp)"
  docker build -q -f "$DHERE/web.Dockerfile" --build-arg VERSION="$V" --build-arg BASE_PATH=$bp \
    --build-arg API_URL="http://onepos-$e-api:8080" -t "onepos-web-$e:$V" "$DREPO/web"
done
step "build $PG_IMAGE"
docker build -q -f "$DHERE/postgres.Dockerfile" -t "$PG_IMAGE" "$DHERE"

if [ -z "${SKIP_DEVICE:-}" ]; then
  DV=$(grep -o '<Version>[^<]*' "$REPO/src/OnePos.DeviceService/OnePos.DeviceService.csproj" | head -1 | cut -d'>' -f2)
  step "build the Device Service $DV installer for $PUBLIC_HOST"
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$DREPO/tools/release-device-service.ps1" -Version "$DV" -WebOrigin "$PUBLIC_HOST" \
    -Releases "$(cd "$OUT" && pwd -W 2>/dev/null || pwd)/device-service" | tail -2
fi

step "save images"
docker save "onepos-api:$V" | gzip -1 > "$OUT/api.tar.gz"
for e in live test; do docker save "onepos-web-$e:$V" | gzip -1 > "$OUT/web-$e.tar.gz"; done
docker save "$PG_IMAGE" | gzip -1 > "$OUT/postgres.tar.gz"
du -sh "$OUT"/*

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
echo "  test:  ssh $APP /opt/aws/onepos/bin/onepos deploy test $V      -> $PUBLIC_HOST/onepos-test"
echo "  live:  ssh $APP /opt/aws/onepos/bin/onepos deploy live $V      -> $PUBLIC_HOST/onepos"
echo "  database image $PG_IMAGE (if new: ssh $DATA /opt/aws/onepos/bin/onepos-db up <env> $PG_IMAGE)"
[ -d "$OUT/device-service" ] && echo "  Device Service: ssh $APP /opt/aws/onepos/bin/onepos publish-device <env> /opt/aws/onepos/releases/$V/device-service"
exit 0
