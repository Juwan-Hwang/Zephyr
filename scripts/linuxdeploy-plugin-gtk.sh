#!/usr/bin/env bash
# Post-processing script for linuxdeploy-plugin-gtk
# This script is copied to the Tauri cache as linuxdeploy-plugin-gtk.sh
# and runs AFTER the original plugin (saved as linuxdeploy-plugin-gtk-upstream.sh).
# It excludes GPU/Mesa libraries from the AppImage to prevent driver conflicts.

set -euo pipefail

ORIGINAL_ARGS=("$@")
APPDIR=
while [ $# -gt 0 ]; do
    case "$1" in
        --plugin-api-version)
            CACHE_DIR="${XDG_CACHE_HOME:-${HOME:-}/.cache}/tauri"
            UPSTREAM_PLUGIN="$CACHE_DIR/linuxdeploy-plugin-gtk-upstream.sh"
            if [ -f "$UPSTREAM_PLUGIN" ]; then
                exec "$UPSTREAM_PLUGIN" --plugin-api-version
            fi
            echo "0"
            exit 0
            ;;
        --appdir=*)
            APPDIR="${1#*=}"
            shift
            ;;
        --appdir)
            if [ $# -lt 2 ]; then
                echo "Error: --appdir requires a value" >&2
                exit 1
            fi
            APPDIR="$2"
            shift 2
            ;;
        *)
            shift
            ;;
    esac
done

if [ -z "$APPDIR" ]; then
    echo "Error: --appdir not provided" >&2
    exit 1
fi

CACHE_DIR="${XDG_CACHE_HOME:-${HOME:-}/.cache}/tauri"
UPSTREAM_PLUGIN="$CACHE_DIR/linuxdeploy-plugin-gtk-upstream.sh"
TMPFILE=""

cleanup() {
    if [ -n "$TMPFILE" ] && [ -f "$TMPFILE" ]; then
        rm -f "$TMPFILE"
    fi
}
trap cleanup EXIT

if [ ! -f "$UPSTREAM_PLUGIN" ]; then
    echo "Downloading linuxdeploy-plugin-gtk-upstream.sh..."
    mkdir -p "$CACHE_DIR"
    TMPFILE="$(mktemp "$CACHE_DIR/.upstream.XXXXXX")"
    if ! curl -sfL --retry 3 --retry-delay 2 "https://raw.githubusercontent.com/linuxdeploy/linuxdeploy-plugin-gtk/3b67a1d1c1b0c8268f57f2bce40fe2d33d409cea/linuxdeploy-plugin-gtk.sh" \
        -o "$TMPFILE"; then
        echo "Error: Failed to download upstream linuxdeploy-plugin-gtk.sh" >&2
        exit 1
    fi
    mv "$TMPFILE" "$UPSTREAM_PLUGIN"
    chmod +x "$UPSTREAM_PLUGIN"
    TMPFILE=""
fi

"$UPSTREAM_PLUGIN" "${ORIGINAL_ARGS[@]}"

HOOKFILE="$APPDIR/apprun-hooks/linuxdeploy-plugin-gtk.sh"
if [ -f "$HOOKFILE" ]; then
    sed -i '/^export GDK_BACKEND=x11[[:space:]]*$/d' "$HOOKFILE"
fi

EXCLUDE_PREFIXES=(
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
    "libvulkan"
    "libXvMCr600"
)

should_exclude() {
    local base="${1##*/}"
    for prefix in "${EXCLUDE_PREFIXES[@]}"; do
        if [[ "$base" == "$prefix"* ]]; then
            return 0
        fi
    done
    return 1
}

if [ -d "$APPDIR/usr/lib" ]; then
    while IFS= read -r -d '' lib; do
        if should_exclude "$lib"; then
            echo "Excluding GPU library from AppImage: $lib"
            rm -f "$lib"
        fi
    done < <(find "$APPDIR/usr/lib" \( -type f -o -type l \) \( -name "*.so" -o -name "*.so.*" \) -not -path "*/dri/*" -not -path "*/vdpau/*" -print0)
fi
