#!/usr/bin/env bash
set -euo pipefail

usage() {
    echo "Usage: $(basename "$0") [options]"
    echo "Options:"
    echo "  -r REPO       Docker repository (default: ghcr.io/brycelarge/tuliprox-vpn)"
    echo "  -p            Push images after build"
    echo "  -l            Build/push :latest (master)"
    echo "  -n            Build/push :next (develop)"
    echo "  -a ARCH       Buildx platforms (default: linux/amd64,linux/arm64)"
    echo "  -s            Single-platform build (auto-detect host platform)"
    echo "  -t TARGET     Rust target (default: x86_64-unknown-linux-musl)"
    echo "  -h            Show help"
    exit 1
}

log() {
    echo "[$(date +'%Y-%m-%d %H:%M:%S')] $1" >&2
}

trap 'log "Error on line $LINENO"' ERR

DOCKER_REPO="ghcr.io/brycelarge/m3u4proxy"
PUSH=false
BUILD_LATEST=false
BUILD_NEXT=false
PLATFORMS="linux/amd64"
SINGLE_PLATFORM=false
RUST_TARGET="x86_64-unknown-linux-musl"

while getopts "r:plna:st:h" opt; do
    case "${opt}" in
        r) DOCKER_REPO="$OPTARG" ;;
        p) PUSH=true ;;
        l) BUILD_LATEST=true ;;
        n) BUILD_NEXT=true ;;
        a) PLATFORMS="$OPTARG" ;;
        s) SINGLE_PLATFORM=true ;;
        t) RUST_TARGET="$OPTARG" ;;
        h) usage ;;
        \?) usage ;;
    esac
done

if [ "${BUILD_LATEST}" = "false" ] && [ "${BUILD_NEXT}" = "false" ]; then
    BUILD_LATEST=true
    BUILD_NEXT=true
fi

require_buildx() {
    if ! docker buildx version >/dev/null 2>&1; then
        log "docker buildx not available"
        exit 1
    fi
}

detect_platform() {
    local arch
    arch="$(uname -m)"
    case "${arch}" in
        x86_64) echo "linux/amd64" ;;
        arm64|aarch64) echo "linux/arm64" ;;
        *)
            log "Unsupported host arch: ${arch}. Use -a to specify platform(s)."
            exit 1
            ;;
    esac
}

build_tag() {
    local tag="$1"
    local ref="$2"

    log "Building ${DOCKER_REPO}:${tag} (TULIPROX_REF=${ref})"

    local push_args=( )
    local platforms="${PLATFORMS}"

    # buildx limitation: --load only supports a single platform.
    # Default behavior: if not pushing, automatically build only for host platform.
    if [ "${PUSH}" = "true" ]; then
        push_args+=( --push )
        if [ "${SINGLE_PLATFORM}" = "true" ]; then
            platforms="$(detect_platform)"
        fi
    else
        push_args+=( --load )
        platforms="$(detect_platform)"
    fi

    local cache_args=( )
    # Registry cache is optional. GHCR cache pulls can fail with 403 if auth/scopes
    # are missing or the cache tag doesn't exist yet.
    # Enable with: REGISTRY_CACHE_FROM=1 ./scripts/build.sh -p -l
    if [ "${PUSH}" = "true" ]; then
        cache_args+=( --cache-to "type=registry,ref=${DOCKER_REPO}:${tag}-cache,mode=max" )
        if [ "${REGISTRY_CACHE_FROM:-0}" = "1" ]; then
            cache_args+=( --cache-from "type=registry,ref=${DOCKER_REPO}:${tag}-cache" )
        fi
    else
        cache_args+=( --cache-to "type=local,dest=/tmp/docker-cache-${tag},mode=max" )
        cache_args+=( --cache-from "type=local,src=/tmp/docker-cache-${tag}" )
    fi

    docker buildx build \
        --platform "${platforms}" \
        -t "${DOCKER_REPO}:${tag}" \
        --build-arg "TULIPROX_REF=${ref}" \
        --build-arg "RUST_TARGET=${RUST_TARGET}" \
        --build-arg "BUILDKIT_INLINE_CACHE=1" \
        "${cache_args[@]}" \
        "${push_args[@]}" \
        .
}

require_buildx

if [ "${BUILD_LATEST}" = "true" ]; then
    build_tag latest master
fi

if [ "${BUILD_NEXT}" = "true" ]; then
    build_tag next develop
fi

log "Done"
