# loka。Node が MCP と窓口を出し、Ruby が部屋を触る。
#
#   箱で焼く:  deploy/release.sh
#   単体で:    docker build -t loka . && docker run -p 8790:8790 -v loka-data:/data loka
#
# 部屋と認可の記録は /data に住む。合鍵が無ければ起動時に作って
# /data/state/passphrase に置き、ログに一度だけ出す。

FROM node:24-bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends ruby \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

COPY server.mjs paths.mjs ruby.mjs room.mjs state.mjs web.mjs auth.mjs oauth.mjs portal.mjs external.mjs sukhi_login.mjs settings.mjs tools.mjs ./
COPY ruby ./ruby
# 部屋を本当に触る箱(hako)。repo 内の同じパスを local / container で使う。
COPY hako/lib ./hako/lib

ENV WORLD_TRANSPORT=http \
    WORLD_HOST=0.0.0.0 \
    WORLD_PORT=8790 \
    WORLD_DATA=/data

RUN mkdir -p /data && chown node:node /data
VOLUME ["/data"]
EXPOSE 8790

USER node
CMD ["node", "server.mjs"]
