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

RUN find /etc/openvpn -name 'update.sh' -exec chmod +x {} + && \
    find /etc/openvpn -name 'map.sh'    -exec chmod +x {} + && \
    find /etc/openvpn -name 'up.sh'     -exec chmod +x {} + && \
    find /etc/s6-overlay/s6-rc.d -name 'run' -exec chmod +x {} + && \
    find /etc/s6-overlay/s6-rc.d -name 'up'  -exec chmod +x {} + && \
    chmod +x /scripts/*.sh

# Create symlinks to node_modules in epg-sites subdirectories so config files can require() dependencies
# This is needed because epg-grabber config files use require() but run in isolation
RUN mkdir -p /epg-sites && \
    for dir in /epg-sites/*/; do \
        if [ -d "$dir" ]; then \
            ln -sf /app/node_modules "$dir/node_modules"; \
        fi; \
    done

VOLUME ["/data", "/output", "/epg", "/epg-sites"]

EXPOSE 3005
EXPOSE 8118/tcp
