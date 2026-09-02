#!/bin/bash
# Builds cloudflared for Android from Cloudflare's tagged source with Go and
# the NDK, one static-free Go executable per ABI, named libcloudflared.so so
# Gradle ships it in the app's native library directory next to libnode.so
# (see bundle-android-payload.mjs). CGO on purpose: Go's own resolver reads
# /etc/resolv.conf, which Android does not have, so name lookups must go
# through bionic's getaddrinfo.
#
#   mobile/scripts/build-cloudflared-android.sh [version]
#
# Output: mobile/runtime/cloudflared-android/<abi>/libcloudflared.so, which
# CI receives as a release asset (cloudflared-android-<version>.tar.gz).
set -e
VERSION=${1:-2026.8.3}
NDK=${NDK:-$HOME/Android/Sdk/ndk/28.2.13676358}
SDK=26
TC=$NDK/toolchains/llvm/prebuilt/linux-x86_64
export PATH=/usr/local/go/bin:$PATH
HERE=$(cd "$(dirname "$0")" && pwd)
OUT=$HERE/../runtime/cloudflared-android
SRC=/tmp/odm-cloudflared/src-$VERSION
mkdir -p /tmp/odm-cloudflared "$OUT"
[ -d "$SRC" ] || git clone -q --depth 1 --branch "$VERSION" https://github.com/cloudflare/cloudflared "$SRC"
cd "$SRC"
STAMP=$(date -u +%Y-%m-%dT%H:%M:%SZ)
for pair in "arm64-v8a arm64 aarch64-linux-android" "x86_64 amd64 x86_64-linux-android"; do
  set -- $pair
  ABI=$1; GOARCH=$2; PREFIX=$3
  mkdir -p "$OUT/$ABI"
  echo "cloudflared $VERSION for $ABI"
  GOOS=android GOARCH=$GOARCH CGO_ENABLED=1 CC=$TC/bin/$PREFIX$SDK-clang \
    go build -mod=vendor -trimpath \
      -ldflags="-s -w -X main.Version=$VERSION -X main.BuildTime=$STAMP" \
      -o "$OUT/$ABI/libcloudflared.so" ./cmd/cloudflared
  ls -la "$OUT/$ABI/libcloudflared.so"
done
