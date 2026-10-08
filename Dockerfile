# loka。Node が MCP と窓口を出し、Ruby が部屋を触る。
#
#   箱で焼く:  deploy/release.sh
#   単体で:    docker build -t loka . && docker run -p 8790:8790 -v loka-data:/data loka
#
# 部屋と認可の記録は /data に住む。合鍵が無ければ起動時に作って
# /data/state/passphrase に置き、ログに一度だけ出す。

FROM node:24-bookworm-slim AS mruby-build

ARG MRUBY_VERSION=4.0.0
ARG MRUBY_ONIG_REGEXP_REV=4962d7eb42de079f6b3faec4b40560eb2941eeec

RUN apt-get update \
    && apt-get install -y --no-install-recommends bison build-essential ca-certificates curl git libreadline-dev ruby \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /tmp
RUN curl -fsSLo mruby.tar.gz "https://github.com/mruby/mruby/archive/refs/tags/${MRUBY_VERSION}.tar.gz" \
    && echo "e2ea271dbed14e9f2b33df773ae447b747dbc242ce2675022c0a57efea85a7b4  mruby.tar.gz" | sha256sum -c - \
    && tar -xzf mruby.tar.gz \
    && git init /tmp/mruby-onig-regexp \
    && git -C /tmp/mruby-onig-regexp remote add origin https://github.com/mattn/mruby-onig-regexp.git \
    && git -C /tmp/mruby-onig-regexp fetch --depth 1 origin "${MRUBY_ONIG_REGEXP_REV}" \
    && git -C /tmp/mruby-onig-regexp checkout --detach FETCH_HEAD \
    && test "$(git -C /tmp/mruby-onig-regexp rev-parse HEAD)" = "${MRUBY_ONIG_REGEXP_REV}" \
    && cd "mruby-${MRUBY_VERSION}" \
    && cp build_config/default.rb build_config/loka.rb \
    && sed -i "s/conf.gembox 'default'/conf.gembox 'full-core'/" build_config/loka.rb \
    && sed -i "/conf.gembox 'full-core'/a\\  conf.gem :gemdir => '/tmp/mruby-onig-regexp'" build_config/loka.rb \
    && MRUBY_CONFIG="$PWD/build_config/loka.rb" make -j2 \
    && install -D "build/host/bin/mruby" /out/usr/local/bin/mruby

COPY hako/landlock-exec.c /tmp/landlock-exec.c
RUN cc -O2 -Wall -Wextra /tmp/landlock-exec.c -o /out/usr/local/bin/loka-sandbox

FROM node:24-bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends libreadline8 ruby \
       git python3 build-essential \
    && gem install mcp --no-document \
    && rm -rf /var/lib/apt/lists/*

COPY --from=mruby-build /out/usr/local/bin/mruby /usr/local/bin/mruby
COPY --from=mruby-build /out/usr/local/bin/loka-sandbox /usr/local/bin/loka-sandbox
COPY --from=mruby-build /tmp/mruby-onig-regexp/README.md /usr/share/doc/loka/mruby-onig-regexp-README.md
COPY --from=mruby-build /tmp/mruby-onig-regexp/onigmo-6.2.0.tar.gz /usr/share/doc/loka/onigmo-6.2.0.tar.gz

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

COPY server.mjs paths.mjs ruby.mjs room.mjs state.mjs web.mjs auth.mjs oauth.mjs portal.mjs external.mjs sukhi_login.mjs settings.mjs tools.mjs mac.mjs tool-context.mjs ./
COPY ruby ./ruby
# 部屋を本当に触る箱(hako)。repo 内の同じパスを local / container で使う。
COPY hako/lib ./hako/lib

ENV LANG=C.UTF-8 \
    WORLD_TRANSPORT=http \
    WORLD_HOST=0.0.0.0 \
    WORLD_PORT=8790 \
    WORLD_DATA=/data

RUN mkdir -p /data && chown node:node /data
VOLUME ["/data"]
EXPOSE 8790

USER node
CMD ["node", "server.mjs"]
