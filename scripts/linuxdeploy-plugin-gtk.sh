#!/usr/bin/env bash
# Post-processing script for linuxdeploy-plugin-gtk
# This script is copied to the Tauri cache as linuxdeploy-plugin-gtk.sh
# and runs AFTER the original plugin (saved as linuxdeploy-plugin-gtk-upstream.sh).
# It excludes GPU/Mesa libraries from the AppImage to prevent driver conflicts.

set -euo pipefail

CACHE_DIR="${XDG_CACHE_HOME:-$HOME/.cache}/tauri"
UPSTREAM_PLUGIN="$CACHE_DIR/linuxdeploy-plugin-gtk-upstream.sh"

if [ ! -f "$UPSTREAM_PLUGIN" ]; then
    echo "Downloading linuxdeploy-plugin-gtk-upstream.sh..."
    mkdir -p "$CACHE_DIR"
    curl -sfL "https://raw.githubusercontent.com/linuxdeploy/linuxdeploy-plugin-gtk/3b67a1d1c1b0c8268f57f2bce40fe2d33d409cea/linuxdeploy-plugin-gtk.sh" \
        -o "$UPSTREAM_PLUGIN"
    chmod +x "$UPSTREAM_PLUGIN"
fi

"$UPSTREAM_PLUGIN" "$@"

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
