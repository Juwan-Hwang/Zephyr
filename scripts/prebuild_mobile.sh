#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

echo "====================================="
echo "  Zephyr Mobile Pre-build Pipeline"
echo "====================================="

# 1. Design Token generation (must run from workspace root, config paths are root-relative)
echo
echo "[1/3] Generating Design Tokens..."
cd "$PROJECT_ROOT"
pnpm exec style-dictionary build --config packages/tokens/config.js

# 2. Host build (basis for Kotlin/Swift binding generation, must precede iOS script)
echo
echo "[2/3] Host build..."
cd "$PROJECT_ROOT/crates/core-ffi" && cargo build --release

# 3. Android NDK build (independent of iOS, serial locally, parallel in CI)
echo
echo "[3/3] Android NDK build..."
cargo ndk -t arm64-v8a -t x86_64 \
    -o "$PROJECT_ROOT/android/app/src/main/jniLibs" \
    build --release

echo
echo "====================================="
echo "  Pre-build complete! Next steps:"
echo "  Android: Android Studio -> Run"
echo "  iOS:     cd crates/core && ./build_ios.sh"
echo "           then Xcode -> Run"
echo "====================================="
