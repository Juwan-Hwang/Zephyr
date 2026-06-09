#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FFI_DIR="$SCRIPT_DIR/../core-ffi"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
# Cargo workspace puts all output in workspace root target/
TARGET_DIR="$PROJECT_ROOT/target"
OUT_DIR="$PROJECT_ROOT/ios"
UNIFFI_OUT="$OUT_DIR/Sources/UniFFI"

mkdir -p "$UNIFFI_OUT"

# Step 1: Host build (must be explicit, don't assume target/release already exists)
echo "==> [1/4] Host build (metadata extraction)"
cd "$FFI_DIR"
cargo build --release

# Step 2: iOS cross-compilation (compatible with Apple Silicon and Intel Macs)
echo "==> [2/4] iOS cross-compilation"
cargo build --release --target aarch64-apple-ios
cargo build --release --target aarch64-apple-ios-sim
cargo build --release --target x86_64-apple-ios   # Intel Mac simulator

# Merge simulator architectures (aarch64-sim + x86_64 -> universal fat library)
mkdir -p "$TARGET_DIR/ios-sim/release"
lipo -create \
    "$TARGET_DIR/aarch64-apple-ios-sim/release/libzephyr_core_ffi.a" \
    "$TARGET_DIR/x86_64-apple-ios/release/libzephyr_core_ffi.a" \
    -output "$TARGET_DIR/ios-sim/release/libzephyr_core_ffi_sim.a"

# Step 3: Generate Swift bindings (from host artifact, auto-detect OS suffix)
echo "==> [3/4] Generate Swift bindings"
OS_NAME="$(uname -s)"
LIB_EXT="so"
[ "$OS_NAME" = "Darwin" ] && LIB_EXT="dylib"

uniffi-bindgen generate \
    --library "$TARGET_DIR/release/libzephyr_core_ffi.${LIB_EXT}" \
    --language swift \
    --out-dir "$UNIFFI_OUT"

# Auto-generate module.modulemap
HEADER_NAME="zephyr_coreFFI.h"
cat > "$UNIFFI_OUT/module.modulemap" << EOF
module ZephyrCoreFFI {
    header "${HEADER_NAME}"
    export *
}
EOF

# Step 4: Package XCFramework (pass two .a directly, no lipo fat binary needed)
echo "==> [4/4] Package XCFramework"
rm -rf "$OUT_DIR/ZephyrCore.xcframework"
xcodebuild -create-xcframework \
    -library "$TARGET_DIR/aarch64-apple-ios/release/libzephyr_core_ffi.a" \
    -headers "$UNIFFI_OUT" \
    -library "$TARGET_DIR/ios-sim/release/libzephyr_core_ffi_sim.a" \
    -headers "$UNIFFI_OUT" \
    -output "$OUT_DIR/ZephyrCore.xcframework"

echo "==> Done"
