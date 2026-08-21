#!/usr/bin/env bash
# Post-processing script for linuxdeploy-plugin-gtk
# This script is copied to the Tauri cache as linuxdeploy-plugin-gtk.sh
# and runs AFTER the original plugin (saved as linuxdeploy-plugin-gtk-upstream.sh).
# It excludes GPU/Mesa libraries from the AppImage to prevent driver conflicts
# and patches WebKitGTK's helper-process lookup to resolve inside the AppDir.

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
    if ! curl --proto =https --proto-redir =https -sfL --retry 3 --retry-delay 2 "https://raw.githubusercontent.com/linuxdeploy/linuxdeploy-plugin-gtk/3b67a1d1c1b0c8268f57f2bce40fe2d33d409cea/linuxdeploy-plugin-gtk.sh" \
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

# ---------------------------------------------------------------------------
# WebKitGTK helper-process deployment + binary patch
#
# Problem:
#   The Ubuntu-built WebKitGTK library embeds its PKGLIBEXECDIR as an
#   absolute helper-process path.  Because AppImage does not provide a
#   chroot-like root filesystem, that path resolves against the host
#   filesystem rather than the mounted AppDir.
#
#   On Ubuntu (the build host) the path /usr/lib/<arch>-linux-gnu/
#   webkit2gtk-4.1 exists and the AppImage accidentally borrows the
#   host's helpers.  On Fedora/Arch/etc. the path doesn't exist, so
#   WebKitGTK calls g_error() → SIGTRAP → crash.
#
#   WEBKIT_EXEC_PATH is gated behind ENABLE(DEVELOPER_MODE) in
#   ProcessExecutablePathGLib.cpp and is NOT checked in release builds.
#   Mirroring the helpers at the absolute path inside the AppDir does
#   NOT work — the lookup is absolute, and the AppDir copy is never
#   consulted.  (Verified by nocx PR#100 and our own AppImage
#   architecture analysis.)
#
# Solution — four load-bearing steps, none of which can be omitted:
#
#   Step 1: Bundle the helper processes (and injected bundle) inside the
#           AppDir at the path corresponding to PKGLIBEXECDIR.
#
#   Step 2: Binary-patch libwebkit2gtk-4.1.so, replacing the absolute
#           PKGLIBEXECDIR with an equal-length RELATIVE path.
#
#   Step 3: Tauri's AppRun (AppImageKit's AppRun.c, a compiled C binary,
#           NOT a shell script that sources apprun-hooks) calls
#           chdir("$APPDIR/usr") unconditionally before execvp.
#
#   Step 4: The relative path from Step 2 resolves against the cwd
#           established by Step 3, reaching the bundled helpers from
#           Step 1:
#
#             cwd:       $APPDIR/usr          (Step 3: AppRun chdir)
#             relative:  ././/lib/<arch>/webkit2gtk-4.1  (Step 2: patch)
#             resolved:  $APPDIR/usr/lib/<arch>/webkit2gtk-4.1  (Step 1)
#
#   The patched relative path is intentionally relative to the working
#   directory established by the bundled AppRun implementation — NOT to
#   $APPDIR directly, and NOT to any AppImage-generic "mount root".
#
#   Equal-length transformation (x86_64, 40 bytes):
#     /usr/lib/x86_64-linux-gnu/webkit2gtk-4.1  (absolute)
#     ././/lib/x86_64-linux-gnu/webkit2gtk-4.1  (relative)
#
#   The ./ and // are no-ops in POSIX path resolution, used purely
#   as byte-level padding to preserve the exact length.  Equal length
#   is critical: no ELF offset moves, and the library's OTHER baked
#   string (PKGLIBEXECDIR + "/injected-bundle/") keeps its suffix.
#
#   This runs inside linuxdeploy's GTK plugin, which executes AFTER
#   executeDeferredOperations() (strip + setRPath) and BEFORE the
#   appimage output plugin packages the SquashFS.  So the patch is
#   applied to the final library state and is never stripped or
#   rewritten afterwards.
#
#   For deb/rpm: the distro package installs helpers at the native
#   PKGLIBEXECDIR, so no patch is needed.  The patch is AppImage-only.
# ---------------------------------------------------------------------------

# Determine the absolute PKGLIBEXECDIR baked into Ubuntu's
# libwebkit2gtk-4.1.so, based on the build host architecture.
# Ubuntu uses GNUInstallDirs multiarch paths.
#   x86_64:  /usr/lib/x86_64-linux-gnu/webkit2gtk-4.1  (40 bytes)
#   aarch64: /usr/lib/aarch64-linux-gnu/webkit2gtk-4.1  (41 bytes)
WEBKIT_PKG_LIBEXEC_DIR=""
case "$(uname -m)" in
    x86_64)   WEBKIT_PKG_LIBEXEC_DIR="/usr/lib/x86_64-linux-gnu/webkit2gtk-4.1" ;;
    aarch64)  WEBKIT_PKG_LIBEXEC_DIR="/usr/lib/aarch64-linux-gnu/webkit2gtk-4.1" ;;
    *)
        echo "Warning: Unsupported architecture $(uname -m) — WebKitGTK helper patch skipped." >&2
        ;;
esac

# Equal-length relative form, crafted for AppRun's chdir("$APPDIR/usr").
#
# The absolute path is /usr/lib/<arch>/webkit2gtk-4.1.
# AppRun chdir's to $APPDIR/usr, so the relative path must resolve
# to $APPDIR/usr/lib/<arch>/webkit2gtk-4.1.
#
# Strategy: replace "/usr/lib/" (10 bytes) with "././/lib/" (10 bytes).
#   /usr/lib/x86_64-linux-gnu/webkit2gtk-4.1  →  ././/lib/x86_64-linux-gnu/webkit2gtk-4.1
# Both are the same length.  ./ and // are no-ops in POSIX paths.
webkit_relative_path() {
    local abs="$1"
    # Replace the leading "/usr/" with "././/" — both 5 bytes.
    # This transforms /usr/lib/... into ././/lib/...
    local prefix="/usr/"
    local replacement="././/"
    if [ "${abs:0:${#prefix}}" = "$prefix" ]; then
        printf '%s%s' "$replacement" "${abs:${#prefix}}"
    else
        # Fallback: should not happen for Ubuntu paths.
        printf '%s' "${abs#/}"
    fi
}

deploy_webkit_helpers() {
    if [ -z "$WEBKIT_PKG_LIBEXEC_DIR" ]; then
        return 0
    fi

    local webkit_libdir=""
    local webkit_helpers=()

    # Locate the WebKitGTK process directory on the build host.
    # PKGLIBEXECDIR is the primary candidate; other distro paths are
    # fallbacks for local builds on non-Ubuntu distros.
    local candidate_dirs=()
    if command -v pkg-config >/dev/null 2>&1 || command -v pkgconf >/dev/null 2>&1; then
        local pc_var
        pc_var="$(pkg-config --variable=libdir webkit2gtk-4.1 2>/dev/null \
                   || pkgconf --variable=libdir webkit2gtk-4.1 2>/dev/null \
                   || true)"
        if [ -n "$pc_var" ] && [ -d "$pc_var/webkit2gtk-4.1" ]; then
            candidate_dirs+=("$pc_var/webkit2gtk-4.1")
        fi
    fi
    candidate_dirs+=(
        "$WEBKIT_PKG_LIBEXEC_DIR"
        "/usr/lib64/webkit2gtk-4.1"
        "/usr/lib/webkit2gtk-4.1"
    )

    for dir in "${candidate_dirs[@]}"; do
        if [ -d "$dir" ]; then
            webkit_libdir="$dir"
            break
        fi
    done

    if [ -z "$webkit_libdir" ]; then
        echo "Error: WebKitGTK process directory not found — cannot bundle helper processes." >&2
        echo "  The AppImage would crash on non-Debian distributions (Fedora, Arch, etc.)." >&2
        return 1
    fi

    echo "Deploying WebKitGTK helper processes from: $webkit_libdir"

    # Collect all WebKit*Process binaries.
    while IFS= read -r -d '' helper; do
        webkit_helpers+=("$helper")
    done < <(find "$webkit_libdir" -maxdepth 1 -type f -name 'WebKit*Process' -print0 2>/dev/null)

    if [ ${#webkit_helpers[@]} -eq 0 ]; then
        echo "Error: No WebKit*Process binaries found in $webkit_libdir" >&2
        return 1
    fi

    # Copy helpers into AppDir at the exact PKGLIBEXECDIR path.
    # The binary-patched library will look for them here via the
    # relative path resolved from the process cwd ($APPDIR/usr).
    local target_dir="$APPDIR$WEBKIT_PKG_LIBEXEC_DIR"
    mkdir -p "$target_dir"

    for helper in "${webkit_helpers[@]}"; do
        local name="${helper##*/}"
        cp -f "$helper" "$target_dir/$name"
        chmod +x "$target_dir/$name"
        echo "  Bundled: $name → $target_dir/"
    done

    # Also copy the injected bundle directory if it exists.
    # WebKitGTK may load it at runtime for web extension support.
    local bundle_src="$webkit_libdir/injected-bundle"
    local bundle_dst="$target_dir/injected-bundle"
    if [ -d "$bundle_src" ]; then
        mkdir -p "$bundle_dst"
        cp -f "$bundle_src"/* "$bundle_dst/" 2>/dev/null || true
        echo "  Bundled: injected-bundle/ → $bundle_dst/"
    fi

    # Verify mandatory helpers are present — fail-closed.
    # WebKitNetworkProcess and WebKitWebProcess are required for WebKitGTK
    # to spawn network and web-content worker processes.  Without them the
    # AppImage will crash on any distro.  WebKitGPUProcess is optional
    # (hardware acceleration falls back gracefully).
    for expected in WebKitNetworkProcess WebKitWebProcess; do
        if [[ ! -f "$target_dir/$expected" ]]; then
            echo "Error: mandatory helper $expected not found in $target_dir." >&2
            echo "  WebKitGTK cannot function without this process — aborting build." >&2
            return 1
        fi
    done

    # Provenance audit: record version metadata and binary digests.
    #
    # pkg-config --modversion reports the version declared in the .pc file
    # found on the pkg-config search path.  This is version metadata / audit
    # evidence, NOT a mathematical proof that helpers and library share the
    # same build: the .pc file could in principle disagree with the actual
    # binaries.  The real provenance guarantee is structural: all components
    # are copied from the same webkit_libdir during a single packaging
    # invocation on the same build host.
    #
    # The version string and SHA-256 digests are recorded for audit — they
    # make the provenance inspectable in CI logs after the fact, but do not
    # gate the build (no reference database to compare against).
    local webkit_version=""
    if command -v pkg-config >/dev/null 2>&1; then
        webkit_version="$(pkg-config --modversion webkit2gtk-4.1 2>/dev/null || true)"
    elif command -v pkgconf >/dev/null 2>&1; then
        webkit_version="$(pkgconf --modversion webkit2gtk-4.1 2>/dev/null || true)"
    fi

    if [ -n "$webkit_version" ]; then
        echo "  WebKitGTK version (pkg-config): $webkit_version"
    else
        echo "  Warning: could not determine WebKitGTK version via pkg-config." >&2
    fi
    echo "  Provenance: all components copied from $webkit_libdir in a single packaging invocation"

    # Record SHA-256 digests for audit trail.
    echo "  SHA-256 digests:"
    for helper in "$target_dir"/WebKit*Process; do
        [ -f "$helper" ] || continue
        local name="${helper##*/}"
        local digest
        digest="$(sha256sum "$helper" | cut -d' ' -f1)"
        echo "    $name: $digest"
    done
}

# Binary-patch libwebkit2gtk-4.1.so: replace the absolute PKGLIBEXECDIR
# with an equal-length relative path.
#
# This is the core of the cross-distro fix.  The absolute path is an
# ordinary data string in the .rodata section — no RPATH, patchelf, or
# LD_LIBRARY_PATH reaches it.  The only lever is the string itself.
#
# Hard invariants (each verified post-patch):
#   1. Patch before: absolute path byte-sequence count > 0
#   2. Patch after:  absolute path byte-sequence count == 0
#   3. Patch after:  relative path byte-sequence count == original count
#   4. File size unchanged (byte-for-byte)
#   5. ELF magic intact
#
# Provenance audit (evidence recorded in deploy_webkit_helpers):
#   6. WebKitGTK version metadata recorded via pkg-config --modversion
#   7. SHA-256 digests of all helper executables recorded for audit
#   8. All components copied from the same webkit_libdir on the build host
#      during a single packaging invocation (structural provenance guarantee)
patch_webkit_libexec_path() {
    if [ -z "$WEBKIT_PKG_LIBEXEC_DIR" ]; then
        return 0
    fi

    local old="$WEBKIT_PKG_LIBEXEC_DIR"
    local new
    new="$(webkit_relative_path "$old")"

    # Verify equal length — this is a hard requirement.
    if [ "${#old}" -ne "${#new}" ]; then
        echo "Error: path length mismatch (${#old} vs ${#new}) — refusing to patch." >&2
        echo "  old: $old" >&2
        echo "  new: $new" >&2
        return 1
    fi

    # Find the bundled libwebkit2gtk-4.1.so.0 (resolve symlinks).
    local lib=""
    for name in \
        "libwebkit2gtk-4.1.so.0" \
        "libwebkit2gtk-4.1.so"; do
        local candidate="$APPDIR/usr/lib/$name"
        if [ -f "$candidate" ]; then
            lib="$(readlink -f "$candidate")"
            break
        fi
    done

    if [[ -z "$lib" || ! -f "$lib" ]]; then
        echo "Error: libwebkit2gtk-4.1.so not found in AppDir — cannot apply binary patch." >&2
        echo "  The AppImage would crash on non-Debian distributions without this patch." >&2
        return 1
    fi

    # Hard requirement: perl is used for byte-level binary patching and
    # byte-level occurrence counting on ELF .rodata.  grep -c is
    # newline-oriented and unreliable on binary data.  Checked here (not at
    # script entry) so that non-AppImage builds without libwebkit2gtk are
    # not blocked by a missing perl.
    command -v perl >/dev/null 2>&1 || {
        echo "ERROR: perl is required for byte-level WebKitGTK patching but was not found." >&2
        return 1
    }

    # Defensive guard: old and new must be non-empty before running perl.
    if [ -z "$old" ] || [ -z "$new" ]; then
        echo "ERROR: old or new path is empty — refusing to patch." >&2
        return 1
    fi

    echo "Patching WebKitGTK PKGLIBEXECDIR in: $lib"

    # Check if already patched (idempotency).
    # Use perl for byte-level search to avoid grep's newline-oriented
    # semantics on binary data.  Environment variables (NEW/OLD) are passed
    # inline before the perl command so they reach the perl process.
    local already_new already_old
    already_new="$(NEW="$new" perl -0777 -ne 'print scalar(() = /\Q$ENV{NEW}\E/g)' "$lib" 2>/dev/null || true)"
    already_new="${already_new:-0}"
    already_old="$(OLD="$old" perl -0777 -ne 'print scalar(() = /\Q$ENV{OLD}\E/g)' "$lib" 2>/dev/null || true)"
    already_old="${already_old:-0}"
    if [ "$already_new" -gt 0 ] && [ "$already_old" -eq 0 ]; then
        echo "  Already patched — skipping."
        return 0
    fi

    # Invariant 1: absolute path must exist before patching.
    # Use perl for byte-level occurrence counting on binary data — grep -c
    # is newline-oriented and can undercount when the needle spans or
    # intersects NUL bytes or embedded newlines in .rodata.
    # OLD is passed as an env var inline so perl receives it via $ENV{OLD}.
    count="$(OLD="$old" perl -0777 -ne 'print scalar(() = /\Q$ENV{OLD}\E/g)' "$lib" 2>/dev/null || true)"
    count="${count:-0}"

    if [[ "$count" -eq 0 ]]; then
        echo "Error: PKGLIBEXECDIR string not found in $lib — patch is a no-op." >&2
        echo "  Expected: $old" >&2
        echo "  The library may use a different path layout; the AppImage cannot be safely shipped unpatched." >&2
        return 1
    fi

    # Record file size before patch for post-patch verification.
    local size_before
    size_before="$(wc -c < "$lib" | tr -d ' ')"

    echo "  Found $count occurrence(s) of absolute path"
    echo "  Replacing: $old → $new (equal length: ${#new} bytes)"
    echo "  File size before: $size_before bytes"

    # Perform the binary replacement using perl (available on ubuntu-22.04).
    # perl -0777 reads the entire file, performs in-place substitution,
    # and writes it back.  \Q...\E quotemetas the path (slashes, etc.).
    if ! perl -0777 -pi -e "s/\Q$old\E/$new/g" "$lib"; then
        echo "Error: perl binary patch failed." >&2
        return 1
    fi

    # Invariant 2: absolute path must be completely gone.
    # Use perl byte-level counting (same rationale as invariant 1).
    remaining="$(OLD="$old" perl -0777 -ne 'print scalar(() = /\Q$ENV{OLD}\E/g)' "$lib" 2>/dev/null || true)"
    remaining="${remaining:-0}"
    if [ "$remaining" -gt 0 ]; then
        echo "Error: $remaining occurrence(s) of absolute path survived the patch." >&2
        return 1
    fi

    # Invariant 3: relative path count must match original count.
    patched="$(NEW="$new" perl -0777 -ne 'print scalar(() = /\Q$ENV{NEW}\E/g)' "$lib" 2>/dev/null || true)"
    patched="${patched:-0}"
    if [ "$patched" -ne "$count" ]; then
        echo "Error: expected $count patched site(s), found $patched." >&2
        return 1
    fi

    # Invariant 4: file size must be unchanged.
    local size_after
    size_after="$(wc -c < "$lib" | tr -d ' ')"
    if [ "$size_before" -ne "$size_after" ]; then
        echo "Error: file size changed ($size_before → $size_after) — patch corrupted the file." >&2
        return 1
    fi

    # Invariant 5: ELF magic must be intact (byte-level check).
    if [ "$(head -c 4 "$lib" | od -An -tx1 | tr -d ' \n')" != "7f454c46" ]; then
        echo "Error: ELF magic missing after patch — file corrupted." >&2
        return 1
    fi

    echo "  Patch verified: $patched site(s), ELF magic intact, size unchanged ($size_after bytes)."
}

deploy_webkit_helpers || exit 1
patch_webkit_libexec_path || exit 1

# ---------------------------------------------------------------------------
# GPU/Mesa library exclusion
# ---------------------------------------------------------------------------

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
