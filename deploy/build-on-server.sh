#!/bin/bash
# Builds a One POS release ON THE APP SERVER from the GitHub source, then deploys it to test and (if test is healthy) live.
# For when the release can't be copied from the build PC (e.g. its SSH to the servers is blocked). Run on aws-app as admin-app:
#
#   curl -fsSL https://raw.githubusercontent.com/aws-dushan/aws_pos/main/deploy/build-on-server.sh | bash -s <version>
#
# Needs internet on the server (GitHub, Docker Hub, NuGet, npm). The database image is not rebuilt: the one already on the server
# is used when its hash matches (deploy/data unchanged); otherwise it is built too. The Device Service is not part of it.
set -euo pipefail
V=${1:?usage: build-on-server.sh <version>}
ROOT=/opt/aws/onepos
SRC=$ROOT/src
say() { echo "$(date '+%H:%M:%S')  $*"; }

say "download the source from GitHub (main)"
rm -rf "$SRC.new" && mkdir -p "$SRC.new"
curl -fsSL https://codeload.github.com/aws-dushan/aws_pos/tar.gz/refs/heads/main | tar -xz -C "$SRC.new" --strip-components=1
rm -rf "$SRC" && mv "$SRC.new" "$SRC"
cd "$SRC"

say "build onepos-api:$V"
docker build -q -f deploy/api.Dockerfile --build-arg VERSION="$V" -t "onepos-api:$V" . >/dev/null
for e in live test; do
  bp=/onepos; [ $e = test ] && bp=/onepos-test
  say "build onepos-web-$e:$V ($bp)"
  docker build -q -f deploy/web.Dockerfile --build-arg VERSION="$V" --build-arg BASE_PATH=$bp \
    --build-arg API_URL="http://onepos-$e-api:8080" -t "onepos-web-$e:$V" web >/dev/null
done

PG_HASH=$(cat deploy/postgres.Dockerfile deploy/data/*.sh deploy/data/*.conf deploy/data/initdb/* | sha1sum | cut -c1-10)
PG_IMAGE=onepos-postgres:17-$PG_HASH
if ! docker image inspect "$PG_IMAGE" >/dev/null 2>&1; then
  say "build $PG_IMAGE (deploy/data changed: also run onepos-db up on aws-data)"
  docker build -q -f deploy/postgres.Dockerfile -t "$PG_IMAGE" deploy >/dev/null
fi
mkdir -p "$ROOT/releases/$V" && echo "$PG_IMAGE" > "$ROOT/releases/$V/PG_IMAGE"

say "deploy test $V"
"$ROOT/bin/onepos" deploy test "$V" 2>&1 | tail -n 1
if grep -q "deploy test $V: healthy" "$ROOT/deploy.log"; then
  say "deploy live $V"
  "$ROOT/bin/onepos" deploy live "$V" 2>&1 | tail -n 1
else
  say "test is not healthy: live NOT deployed"; exit 1
fi
grep -E "$V" "$ROOT/deploy.log" | tail -n 4
