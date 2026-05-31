#!/usr/bin/env bash
# Custom linuxdeploy-plugin-gtk.sh that excludes GPU/Mesa libraries
# This prevents AppImage from bundling GPU drivers that conflict with the host system.
# Based on: https://github.com/linuxdeploy/linuxdeploy-plugin-gtk

set -euo pipefail

EXCLUDE_PATTERNS=(
    "libEGL"
    "libGL"
    "libGLES"
    "libdrm"
    "libgbm"
    "libglapi"
    "libwayland-client"
    "libwayland-egl"
    "libwayland-cursor"
    "libwayland-server"
    "dri/"
    "vdpau/"
    "libvulkan"
    "libXvMCr600"
)

should_exclude() {
    local file="$1"
    for pattern in "${EXCLUDE_PATTERNS[@]}"; do
        if [[ "$file" == *"$pattern"* ]]; then
            return 0
        fi
    done
    return 1
}

CACHE_DIR="${XDG_CACHE_HOME:-$HOME/.cache}/tauri"
PLUGIN_PATH="$CACHE_DIR/linuxdeploy-plugin-gtk.sh"

if [ ! -f "$PLUGIN_PATH" ]; then
    echo "Downloading linuxdeploy-plugin-gtk.sh..."
    mkdir -p "$CACHE_DIR"
    curl -sfL "https://raw.githubusercontent.com/linuxdeploy/linuxdeploy-plugin-gtk/3b67a1d1c1b0c8268f57f2bce40fe2d33d409cea/linuxdeploy-plugin-gtk.sh" \
        -o "$PLUGIN_PATH"
    chmod +x "$PLUGIN_PATH"
fi

"$PLUGIN_PATH" "$@"

if [ -z "${APPDIR:-}" ]; then
    echo "Error: APPDIR environment variable is not set." >&2
    exit 1
fi

if [ -d "$APPDIR/usr/lib" ]; then
    find "$APPDIR/usr/lib" \( -type f -o -type l \) \( -name "*.so" -o -name "*.so.*" \) -print0 | while IFS= read -r -d '' lib; do
        if should_exclude "$lib"; then
            echo "Excluding GPU library from AppImage: $lib"
            rm -f "$lib"
        fi
    done
fi
