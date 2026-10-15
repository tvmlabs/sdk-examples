#!/usr/bin/env bash
# Builds the tvm-sdk Node.js addon (tvmsdk.node) for Linux inside a Debian 11
# container, so the result runs on any system with glibc 2.31 or newer, and
# puts it into addon/linux-<arch>/ next to this script. The architecture is the
# one Docker runs on.
set -euo pipefail

# Debian 11 (glibc 2.31) with Node.js 22 headers and build tools.
IMAGE=node:22.14.0-bullseye
RUST_VERSION=1.98.1
NODE_GYP_VERSION=11.1.0
DEFAULT_REF=feature/update-to-tvm-sdk-3.0.6

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
CACHE_DIR=${ACKI_CACHE_DIR:-${XDG_CACHE_HOME:-$HOME/.cache}/acki-nacki-scripts}/addon-build

usage() {
    cat <<EOF
Usage: $(basename "$0") TVM_SDK_JS_DIR [REF]

Builds packages/lib-node of a tvm-sdk-js checkout at git REF
(default: $DEFAULT_REF) in Docker image $IMAGE
and writes addon/linux-<arch>/tvmsdk.node next to this script.

Rust, cargo and npm caches are kept in $CACHE_DIR,
so later builds are faster.
EOF
}

die() {
    echo "Error: $*" >&2
    exit 1
}

[[ ${1:-} != -h && ${1:-} != --help ]] || { usage; exit 0; }
[[ $# -ge 1 && $# -le 2 ]] || { usage >&2; exit 2; }
REPO=$1
REF=${2:-$DEFAULT_REF}

command -v docker >/dev/null || die "docker is not installed"
docker info >/dev/null 2>&1 || die "docker is not running or not accessible"
COMMIT=$(git -C "$REPO" rev-parse --verify --short "$REF^{commit}" 2>/dev/null) ||
    die "$REPO: no git commit '$REF'"

case $(docker info --format '{{.Architecture}}') in
    x86_64 | amd64) ARCH=x64 ;;
    aarch64 | arm64) ARCH=arm64 ;;
    *) die "unsupported Docker architecture $(docker info --format '{{.Architecture}}')" ;;
esac
OUT_DIR=$SCRIPT_DIR/addon/linux-$ARCH

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
git -C "$REPO" archive "$COMMIT" packages/lib-node | tar -x -C "$WORK"
mkdir -p "$CACHE_DIR" "$WORK/out"

echo "==> Building tvmsdk.node from tvm-sdk-js $COMMIT ($REF) for linux-$ARCH in $IMAGE"
docker run --rm -i \
    --user "$(id -u):$(id -g)" \
    -v "$WORK/packages/lib-node:/src" \
    -v "$WORK/out:/out" \
    -v "$CACHE_DIR:/cache" \
    -e HOME=/cache/home \
    -e RUSTUP_HOME=/cache/rustup \
    -e CARGO_HOME=/cache/cargo \
    -e CARGO_TARGET_DIR=/cache/target \
    -e npm_config_cache=/cache/npm \
    -e npm_config_devdir=/cache/node-gyp \
    -e RUST_VERSION="$RUST_VERSION" \
    -e NODE_GYP_VERSION="$NODE_GYP_VERSION" \
    -w /src/lib \
    "$IMAGE" bash -euo pipefail -s <<'EOF'
mkdir -p "$HOME"
if [[ ! -x $CARGO_HOME/bin/rustup ]]; then
    curl -sSf https://sh.rustup.rs | sh -s -- -y --no-modify-path --profile minimal --default-toolchain none
fi
export PATH=$CARGO_HOME/bin:$PATH
rustup toolchain install --profile minimal "$RUST_VERSION"
cargo +"$RUST_VERSION" build --release
cp "$CARGO_TARGET_DIR/release/libtvmsdk.a" .
npx --yes "node-gyp@$NODE_GYP_VERSION" rebuild
strip --strip-unneeded build/Release/tvmsdk.node
cp build/Release/tvmsdk.node /out/
echo "glibc required: $(objdump -T /out/tvmsdk.node | grep -o 'GLIBC_[0-9.]*' | sort -uV | tail -1)"
EOF

mkdir -p "$OUT_DIR"
mv "$WORK/out/tvmsdk.node" "$OUT_DIR/tvmsdk.node"
echo "==> $OUT_DIR/tvmsdk.node"
sha256sum "$OUT_DIR/tvmsdk.node"
