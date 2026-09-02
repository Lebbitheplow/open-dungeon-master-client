#!/bin/bash
x86_64> <jobs>|x86_64> <jobs>
set -e
ARCH=$1; JOBS=${2:-16}
NDK=$HOME/Android/Sdk/ndk/28.2.13676358
SDK=26
TC=$NDK/toolchains/llvm/prebuilt/linux-x86_64
case $ARCH in
  arm64) DEST=arm64; PREFIX=aarch64-linux-android; GARCH=arm64;;
  x86_64) DEST=x64; PREFIX=x86_64-linux-android; GARCH=x64;;
esac
DIR=/tmp/odm-node/src-$ARCH
[ -d $DIR ] || cp -r --reflink=auto /tmp/odm-node/src $DIR
cd $DIR
./android-configure patch >/dev/null 2>&1 || true
export PATH=$TC/bin:$PATH
export CC=$TC/bin/$PREFIX$SDK-clang
export CXX=$TC/bin/$PREFIX$SDK-clang++
export CC_host=/usr/bin/clang CXX_host=/usr/bin/clang++
export GYP_DEFINES="target_arch=$GARCH v8_target_arch=$GARCH android_target_arch=$GARCH host_os=linux OS=android android_ndk_path=$NDK"
./configure --dest-cpu=$DEST --dest-os=android --openssl-no-asm --cross-compiling --with-intl=small-icu 2>&1 | tail -5
make -j$JOBS 2>&1 | tail -30
ls -la out/Release/node && file out/Release/node
