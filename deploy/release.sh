#!/bin/sh
# loka のサーバー用イメージを箱で焼いて、registry に置く。
#
#   deploy/release.sh          焼いて置くだけ
#   deploy/release.sh deploy   それから haloy deploy -t world まで
#
# 最初の一回だけ、$WORLD_BOX 上にデータ置き場を作り、container の uid 1000 に合わせる。
#   ssh "$WORLD_BOX" 'mkdir -p /home/rocky/world/data && sudo chown -R 1000:1000 /home/rocky/world/data'
set -eu
BOX=${WORLD_BOX:?set WORLD_BOX to the SSH destination for the server}
SRC=${WORLD_SRC:-/home/rocky/world/src}
DEPLOY_REPO=${WORLD_DEPLOY_REPO:-}
HERE=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
HAKO=${WORLD_HAKO:-$HERE/hako}

echo "→ $SRC へ送る"
rsync -az --delete \
  --exclude node_modules --exclude room --exclude state \
  --exclude .token --exclude .env --exclude .data --exclude .git --exclude tmp-check.mjs --exclude hako \
  "$HERE/" "$BOX:$SRC/"

# Hako ライブラリも repo 内に置き、local と container で同じ相対パスを使う。
echo "→ 箱(hako)も送る"
ssh "$BOX" "mkdir -p '$SRC/hako/lib'"
rsync -az --delete "$HAKO/lib/" "$BOX:$SRC/hako/lib/"

echo "→ 箱で焼く"
ssh "$BOX" "cd '$SRC' && docker build -t 127.0.0.1:5000/world:v0 . && docker push 127.0.0.1:5000/world:v0"

if [ "${1:-}" = "deploy" ]; then
  : "${DEPLOY_REPO:?set WORLD_DEPLOY_REPO to the Haloy configuration checkout}"
  echo "→ haloy deploy -t world"
  ( cd "$DEPLOY_REPO" && haloy deploy -t world )
fi
