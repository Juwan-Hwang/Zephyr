#!/usr/bin/env bash
# Custom linuxdeploy-plugin-gtk.sh that excludes GPU/Mesa libraries
# This prevents AppImage from bundling GPU drivers that conflict with the host system.
# Based on: https://github.com/linuxdeploy/linuxdeploy-plugin-gtk

set -euo pipefail

# GPU/Mesa libraries to exclude from the AppImage
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

# If linuxdeploy-plugin-gtk is not cached, download it
CACHE_DIR="${XDG_CACHE_HOME:-$HOME/.cache}/tauri"
PLUGIN_PATH="$CACHE_DIR/linuxdeploy-plugin-gtk.sh"

if [ ! -f "$PLUGIN_PATH" ]; then
    echo "Downloading linuxdeploy-plugin-gtk.sh..."
    mkdir -p "$CACHE_DIR"
    curl -sL "https://raw.githubusercontent.com/linuxdeploy/linuxdeploy-plugin-gtk/master/linuxdeploy-plugin-gtk.sh" \
        -o "$PLUGIN_PATH"
    chmod +x "$PLUGIN_PATH"
fi

# Run the original plugin, then remove excluded libraries from the AppDir
"$PLUGIN_PATH" "$@"

# Clean up GPU libraries from AppDir
APPDIR="${APPDIR:-}"
if [ -z "$APPDIR" ]; then
    APPDIR="$(dirname "$0")/../../AppDir"
fi

if [ -d "$APPDIR/usr/lib" ]; then
    find "$APPDIR/usr/lib" -type f \( -name "*.so" -o -name "*.so.*" \) | while read -r lib; do
        if should_exclude "$lib"; then
            echo "Excluding GPU library from AppImage: $lib"
            rm -f "$lib"
        fi
    done
fi
