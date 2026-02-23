# ── Frontend build ───────────────────────────────────────────────────────────
FROM node:22-alpine AS builder

WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build


# ── Final image ───────────────────────────────────────────────────────────────
FROM brycelarge/alpine-baseimage:3.21

ARG OPENVPN_TOOLS_REF=main

ENV TZ=UTC \
    PORT=3005 \
    DATA_DIR=/data \
    DNS_SERVERS=1.1.1.1,8.8.8.8

RUN apk add --no-cache \
        bash \
        ca-certificates \
        curl \
        dos2unix \
        git \
        iproute2 \
        iptables \
        jq \
        moreutils \
        nodejs \
        npm \
        openvpn \
        privoxy \
        tzdata && \
    git clone --depth 1 --branch "${OPENVPN_TOOLS_REF}" \
        https://github.com/brycelarge/openvpn-buildtools.git /tmp/openvpn-buildtools && \
    cp -r /tmp/openvpn-buildtools/root/. / && \
    cp -r /tmp/openvpn-buildtools/scripts/. /scripts/ && \
    rm -rf /tmp/openvpn-buildtools

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY server/ ./server/
COPY --from=builder /app/dist ./dist

COPY root/ /

# can we not create directories and set permissions here?

RUN find /etc/openvpn -name 'update.sh' -exec chmod +x {} + && \
    find /etc/openvpn -name 'map.sh'    -exec chmod +x {} + && \
    find /etc/openvpn -name 'up.sh'     -exec chmod +x {} + && \
    find /etc/s6-overlay/s6-rc.d -name 'run' -exec chmod +x {} + && \
    find /etc/s6-overlay/s6-rc.d -name 'up'  -exec chmod +x {} + && \
    chmod +x /scripts/*.sh

# Create m3u4prox user and group during build
RUN addgroup --system m3u4prox && \
    adduser --disabled-password --home /app --ingroup m3u4prox --no-create-home --system m3u4prox && \
    mkdir -p /data/db /data/epg/tmp /data/epg-sites /data/logs/m3u4prox /data/logos /data/playlists /data/config && \
    ln -sf /data/epg /epg && \
    ln -sf /data/epg-sites /epg-sites && \
    chown -R m3u4prox:m3u4prox /data && \
    chmod -R 755 /data

# Create symlink to node_modules in epg-sites so config files can import dependencies
# This is needed because epg-grabber config files use import statements
RUN mkdir -p /data/epg-sites && \
    ln -sf /app/node_modules /data/epg-sites/node_modules

VOLUME ["/data"]

EXPOSE 3005
EXPOSE 8118/tcp
