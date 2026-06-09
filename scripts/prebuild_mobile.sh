#!/bin/bash
set -e

echo "====================================="
echo "  Zephyr Mobile Pre-build Pipeline"
echo "====================================="

# 1. Design Token generation
echo "\n[1/3] Generating Design Tokens..."
cd packages/tokens && npm run build && cd ../..

# 2. Host build (basis for Kotlin/Swift binding generation, must precede iOS script)
echo "\n[2/3] Host build..."
cd crates/core && cargo build --release

# 3. Android NDK build (independent of iOS, serial locally, parallel in CI)
echo "\n[3/3] Android NDK build..."
cargo ndk -t arm64-v8a -t x86_64 \
    -o ../../android/app/src/main/jniLibs \
    build --release
cd ../..

echo "\n====================================="
echo "  Pre-build complete! Next steps:"
echo "  Android: Android Studio -> Run"
echo "  iOS:     cd crates/core && ./build_ios.sh"
echo "           then Xcode -> Run"
echo "====================================="
