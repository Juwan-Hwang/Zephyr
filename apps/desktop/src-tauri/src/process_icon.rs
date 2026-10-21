//! Real application icons for the connection lists.
//!
//! mihomo reports the executable behind each connection (`processPath`).
//! [`get_process_icon`] turns that path into a small `data:` URL the webview
//! shows in an `<img>`:
//!
//! - Windows: the icon embedded in the executable.
//! - macOS: the icon of the outermost enclosing `.app` bundle.
//! - Linux: the icon named by the matching `.desktop` entry (or the Flatpak
//!   app id), looked up in the `hicolor` theme and `pixmaps`.
//!
//! `None` means no icon was found; the UI then keeps its neutral placeholder.
//! Found icons are cached for the life of the process; misses only for
//! [`MISS_TTL`], so an app whose icon is installed later still gets it.

use std::collections::HashMap;
use std::path::Path;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use base64::Engine as _;

/// Upper bound on cached paths; the cache is simply cleared when it fills up.
const MAX_CACHE_ENTRIES: usize = 256;
/// Largest icon payload we are willing to inline into the webview.
#[cfg(any(target_os = "macos", target_os = "linux", test))]
const MAX_ICON_BYTES: u64 = 512 * 1024;
/// Paths longer than this are not real executables.
const MAX_PATH_LEN: usize = 4096;
/// How long a path without an icon is remembered before it is looked up again.
const MISS_TTL: Duration = Duration::from_secs(300);

/// Cached lookups: the icon (or `None`) and when it was resolved.
type CacheMap = HashMap<String, (Option<String>, Instant)>;
static CACHE: Mutex<Option<CacheMap>> = Mutex::new(None);

/// Icon of the application at `path` as a `data:` URL, or `None`.
#[tauri::command]
pub async fn get_process_icon(path: String) -> Option<String> {
    if !is_acceptable_path(&path) {
        return None;
    }
    if let Some(hit) = cache_get(&path) {
        return hit;
    }
    let key = path.clone();
    let icon = tokio::task::spawn_blocking(move || platform::icon_for(Path::new(&key)))
        .await
        .ok()
        .flatten();
    cache_put(path, icon.clone());
    icon
}

/// Only plain, local, absolute paths are looked up.
fn is_acceptable_path(path: &str) -> bool {
    if path.is_empty() || path.len() > MAX_PATH_LEN || path.contains('\0') {
        return false;
    }
    // Never touch network shares: resolving an icon there would make the OS
    // connect (and on Windows authenticate) to the remote host.
    if path.starts_with("\\\\") || path.starts_with("//") {
        return false;
    }
    Path::new(path).is_absolute()
}

fn cache_get(path: &str) -> Option<Option<String>> {
    let (icon, at) = CACHE.lock().ok()?.as_ref()?.get(path).cloned()?;
    (icon.is_some() || at.elapsed() < MISS_TTL).then_some(icon)
}

fn cache_put(path: String, icon: Option<String>) {
    let Ok(mut guard) = CACHE.lock() else {
        return;
    };
    let map = guard.get_or_insert_with(HashMap::new);
    if map.len() >= MAX_CACHE_ENTRIES {
        map.clear();
    }
    map.insert(path, (icon, Instant::now()));
}

fn data_url(mime: &str, bytes: &[u8]) -> String {
    let encoded = base64::engine::general_purpose::STANDARD.encode(bytes);
    format!("data:{mime};base64,{encoded}")
}

/// Reads a regular file of at most `cap` bytes.
#[cfg(any(target_os = "macos", target_os = "linux", test))]
fn read_capped(path: &Path, cap: u64) -> Option<Vec<u8>> {
    let meta = std::fs::metadata(path).ok()?;
    if !meta.is_file() || meta.len() == 0 || meta.len() > cap {
        return None;
    }
    std::fs::read(path).ok()
}

// ── PNG encoding (Windows hands us raw pixels) ─────────────────────────────

#[cfg(any(target_os = "windows", test))]
const PNG_SIGNATURE: [u8; 8] = [0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];

/// CRC-32 (IEEE) as used by PNG chunks.
#[cfg(any(target_os = "windows", test))]
fn crc32<'a>(bytes: impl Iterator<Item = &'a u8>) -> u32 {
    let mut crc = 0xFFFF_FFFF_u32;
    for &byte in bytes {
        crc ^= u32::from(byte);
        for _ in 0..8 {
            crc = if crc & 1 == 0 {
                crc >> 1
            } else {
                0xEDB8_8320 ^ (crc >> 1)
            };
        }
    }
    !crc
}

#[cfg(any(target_os = "windows", test))]
fn push_png_chunk(out: &mut Vec<u8>, kind: [u8; 4], data: &[u8]) -> Option<()> {
    out.extend_from_slice(&u32::try_from(data.len()).ok()?.to_be_bytes());
    out.extend_from_slice(&kind);
    out.extend_from_slice(data);
    out.extend_from_slice(&crc32(kind.iter().chain(data)).to_be_bytes());
    Some(())
}

/// Encodes straight (non-premultiplied) RGBA pixels as an 8-bit RGBA PNG.
#[cfg(any(target_os = "windows", test))]
fn encode_png(width: u32, height: u32, rgba: &[u8]) -> Option<Vec<u8>> {
    use std::io::Write as _;

    let stride = usize::try_from(width).ok()?.checked_mul(4)?;
    let rows = usize::try_from(height).ok()?;
    if stride == 0 || rows == 0 || rgba.len() != stride.checked_mul(rows)? {
        return None;
    }
    let mut raw = Vec::with_capacity(rgba.len() + rows);
    for row in rgba.chunks_exact(stride) {
        raw.push(0); // filter type: None
        raw.extend_from_slice(row);
    }
    let mut encoder = flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::default());
    encoder.write_all(&raw).ok()?;
    let idat = encoder.finish().ok()?;

    let mut ihdr = Vec::with_capacity(13);
    ihdr.extend_from_slice(&width.to_be_bytes());
    ihdr.extend_from_slice(&height.to_be_bytes());
    // bit depth 8, colour type 6 (RGBA), compression 0, filter 0, no interlace
    ihdr.extend_from_slice(&[8, 6, 0, 0, 0]);

    let mut png = Vec::with_capacity(idat.len() + 64);
    png.extend_from_slice(&PNG_SIGNATURE);
    push_png_chunk(&mut png, *b"IHDR", &ihdr)?;
    push_png_chunk(&mut png, *b"IDAT", &idat)?;
    push_png_chunk(&mut png, *b"IEND", &[])?;
    Some(png)
}

// ── ICNS parsing (macOS bundles) ───────────────────────────────────────────

/// Picks the PNG-encoded image closest to 64 px from an `.icns` file.
///
/// Modern `.icns` files store their larger sizes as plain PNG streams, which
/// the webview can show directly; legacy (ARGB / JPEG 2000) entries are skipped.
#[cfg(any(target_os = "macos", test))]
fn best_png_in_icns(data: &[u8]) -> Option<&[u8]> {
    // ic12 = 32pt@2x (64 px), ic07 = 128 px, ic13 = 128pt@2x, ic08 = 256 px,
    // ic14 = 256pt@2x, ic09 = 512 px, ic11 = 16pt@2x (32 px), ic10 = 1024 px.
    const PREFERRED: [&[u8; 4]; 8] = [
        b"ic12", b"ic07", b"ic13", b"ic08", b"ic14", b"ic09", b"ic11", b"ic10",
    ];
    const PNG_MAGIC: [u8; 8] = [0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];

    if data.get(..4)? != b"icns" {
        return None;
    }
    let max_entry = usize::try_from(MAX_ICON_BYTES).ok()?;
    let mut entries: Vec<(&[u8], &[u8])> = Vec::new();
    let mut offset = 8_usize;
    while let Some(header) = data.get(offset..offset.checked_add(8)?) {
        let kind = header.get(..4)?;
        let len_bytes: [u8; 4] = header.get(4..8)?.try_into().ok()?;
        let len = usize::try_from(u32::from_be_bytes(len_bytes)).ok()?;
        if len < 8 {
            break;
        }
        let end = offset.checked_add(len)?;
        let body = data.get(offset.checked_add(8)?..end)?;
        if body.starts_with(&PNG_MAGIC) && body.len() <= max_entry {
            entries.push((kind, body));
        }
        offset = end;
    }
    PREFERRED.iter().find_map(|want| {
        entries
            .iter()
            .find(|(kind, _)| kind == want)
            .map(|&(_, body)| body)
    })
}

// ── Info.plist (macOS bundles) ─────────────────────────────────────────────

#[cfg(any(target_os = "macos", test))]
const MAX_PLIST_BYTES: u64 = 1024 * 1024;

/// Icon file names an `Info.plist` (XML or binary) declares, best first:
/// `CFBundleIconFile`, then `CFBundleIconName` (asset-catalog apps ship a
/// same-named `.icns` next to `Assets.car`).
#[cfg(any(target_os = "macos", test))]
fn icon_names_from_plist(plist: &Path) -> Vec<String> {
    let Some(bytes) = read_capped(plist, MAX_PLIST_BYTES) else {
        return Vec::new();
    };
    let Ok(value) = plist::Value::from_reader(std::io::Cursor::new(bytes)) else {
        return Vec::new();
    };
    let Some(dict) = value.as_dictionary() else {
        return Vec::new();
    };
    ["CFBundleIconFile", "CFBundleIconName"]
        .iter()
        .filter_map(|key| dict.get(key)?.as_string())
        .map(str::trim)
        .filter(|name| is_plain_file_name(name))
        .map(str::to_owned)
        .collect()
}

/// A bare file name that cannot leave `Contents/Resources`.
#[cfg(any(target_os = "macos", test))]
fn is_plain_file_name(name: &str) -> bool {
    !name.is_empty() && !name.contains('/') && !name.contains("..") && !name.contains('\0')
}

// ── Platform lookups ───────────────────────────────────────────────────────

#[cfg(target_os = "windows")]
mod platform {
    use std::ffi::OsStr;
    use std::os::windows::ffi::OsStrExt as _;
    use std::path::{Component, Path, Prefix};

    use windows_sys::Win32::Graphics::Gdi::{
        CreateCompatibleDC, DeleteDC, DeleteObject, GetDIBits, GetObjectW, BITMAP, BITMAPINFO,
        BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS, HBITMAP, HDC,
    };
    use windows_sys::Win32::Storage::FileSystem::GetDriveTypeW;
    use windows_sys::Win32::UI::Shell::SHDefExtractIconW;
    use windows_sys::Win32::UI::WindowsAndMessaging::{DestroyIcon, GetIconInfo, HICON, ICONINFO};

    use super::{data_url, encode_png};

    /// Requested edge length; the shell scales the closest embedded image.
    const ICON_SIZE: u32 = 64;
    const MAX_EDGE: u32 = 256;
    /// `GetDriveTypeW` results that must not be touched: no such root, or a
    /// network drive (mapped `Z:` shares would make the shell connect to it).
    const DRIVE_NO_ROOT_DIR: u32 = 1;
    const DRIVE_REMOTE: u32 = 4;

    fn wide_nul(text: &OsStr) -> Vec<u16> {
        text.encode_wide().chain(std::iter::once(0)).collect()
    }

    /// `C:\` for `C:\dir\app.exe`; `None` for anything without a drive letter.
    fn drive_root(exe: &Path) -> Option<String> {
        let Some(Component::Prefix(prefix)) = exe.components().next() else {
            return None;
        };
        if let Prefix::Disk(letter) = prefix.kind() {
            Some(format!("{}:\\", char::from(letter)))
        } else {
            None
        }
    }

    /// Only executables on local drives are read; mapped network drives are not.
    fn is_local_drive(exe: &Path) -> bool {
        let Some(root) = drive_root(exe) else {
            return false;
        };
        let wide = wide_nul(OsStr::new(&root));
        // SAFETY: `wide` is a NUL-terminated UTF-16 root path that outlives the call.
        let kind = unsafe { GetDriveTypeW(wide.as_ptr()) };
        kind != DRIVE_REMOTE && kind != DRIVE_NO_ROOT_DIR
    }

    pub(super) fn icon_for(exe: &Path) -> Option<String> {
        if !is_local_drive(exe) {
            return None;
        }
        let wide = wide_nul(exe.as_os_str());
        let mut icon: HICON = std::ptr::null_mut();
        // SAFETY: `wide` is NUL-terminated and outlives the call, `icon` is a
        // valid out-pointer, and the small-icon out-pointer may be null.
        let hr = unsafe {
            SHDefExtractIconW(
                wide.as_ptr(),
                0,
                0,
                &mut icon,
                std::ptr::null_mut(),
                ICON_SIZE,
            )
        };
        // S_FALSE (1) means the file has no icon of its own.
        if hr != 0 || icon.is_null() {
            return None;
        }
        let pixels = icon_pixels(icon);
        // SAFETY: `icon` was created by SHDefExtractIconW above and is destroyed once.
        unsafe { DestroyIcon(icon) };
        let (width, height, rgba) = pixels?;
        Some(data_url("image/png", &encode_png(width, height, &rgba)?))
    }

    /// RGBA pixels of an icon, alpha taken from the mask for icons without one.
    fn icon_pixels(icon: HICON) -> Option<(u32, u32, Vec<u8>)> {
        // SAFETY: ICONINFO is plain data; all-zero is a valid value.
        let mut info: ICONINFO = unsafe { std::mem::zeroed() };
        // SAFETY: `icon` is a live icon handle and `info` a valid out-pointer.
        if unsafe { GetIconInfo(icon, &mut info) } == 0 {
            return None;
        }
        let pixels = bitmap_pixels(info.hbmColor, info.hbmMask);
        // GetIconInfo hands ownership of both bitmaps to the caller.
        if !info.hbmColor.is_null() {
            // SAFETY: `hbmColor` came from GetIconInfo and is deleted once.
            unsafe { DeleteObject(info.hbmColor) };
        }
        if !info.hbmMask.is_null() {
            // SAFETY: `hbmMask` came from GetIconInfo and is deleted once.
            unsafe { DeleteObject(info.hbmMask) };
        }
        pixels
    }

    fn bitmap_pixels(color: HBITMAP, mask: HBITMAP) -> Option<(u32, u32, Vec<u8>)> {
        // Monochrome icons carry no colour bitmap; leave those to the placeholder.
        if color.is_null() {
            return None;
        }
        // SAFETY: BITMAP is plain data; all-zero is a valid value.
        let mut bm: BITMAP = unsafe { std::mem::zeroed() };
        let size = i32::try_from(std::mem::size_of::<BITMAP>()).ok()?;
        // SAFETY: `color` is a live bitmap and `bm` is a writable BITMAP of `size` bytes.
        let got = unsafe { GetObjectW(color, size, std::ptr::from_mut(&mut bm).cast()) };
        if got == 0 {
            return None;
        }
        let width = u32::try_from(bm.bmWidth).ok()?;
        let height = u32::try_from(bm.bmHeight).ok()?;
        if width == 0 || height == 0 || width > MAX_EDGE || height > MAX_EDGE {
            return None;
        }
        // SAFETY: a null DC asks for a memory DC compatible with the screen.
        let dc = unsafe { CreateCompatibleDC(std::ptr::null_mut()) };
        if dc.is_null() {
            return None;
        }
        let color_bits = dib_bits(dc, color, width, height);
        let has_alpha = color_bits.as_ref().is_some_and(|px| {
            px.chunks_exact(4)
                .any(|p| p.get(3).is_some_and(|&a| a != 0))
        });
        let and_mask = if has_alpha || mask.is_null() {
            None
        } else {
            dib_bits(dc, mask, width, height)
        };
        // SAFETY: `dc` was created above and is deleted once.
        unsafe { DeleteDC(dc) };
        let bgra = color_bits?;

        let mut rgba = vec![0_u8; bgra.len()];
        for (i, (dst, src)) in rgba
            .chunks_exact_mut(4)
            .zip(bgra.chunks_exact(4))
            .enumerate()
        {
            if let ([r, g, b, a], [sb, sg, sr, sa]) = (dst, src) {
                *r = *sr;
                *g = *sg;
                *b = *sb;
                *a = if has_alpha {
                    *sa
                } else {
                    // AND mask: white (set) pixels are transparent.
                    let transparent = and_mask
                        .as_ref()
                        .and_then(|m| m.get(i.checked_mul(4)?))
                        .is_some_and(|&v| v != 0);
                    if transparent {
                        0
                    } else {
                        255
                    }
                };
            }
        }
        Some((width, height, rgba))
    }

    /// Top-down 32-bit BGRA rows of `bitmap`.
    fn dib_bits(dc: HDC, bitmap: HBITMAP, width: u32, height: u32) -> Option<Vec<u8>> {
        // SAFETY: BITMAPINFO is plain data; all-zero is a valid value.
        let mut info: BITMAPINFO = unsafe { std::mem::zeroed() };
        info.bmiHeader.biSize = u32::try_from(std::mem::size_of::<BITMAPINFOHEADER>()).ok()?;
        info.bmiHeader.biWidth = i32::try_from(width).ok()?;
        info.bmiHeader.biHeight = -i32::try_from(height).ok()?;
        info.bmiHeader.biPlanes = 1;
        info.bmiHeader.biBitCount = 32;
        info.bmiHeader.biCompression = BI_RGB;
        let len = usize::try_from(width.checked_mul(height)?.checked_mul(4)?).ok()?;
        let mut buf = vec![0_u8; len];
        // SAFETY: `buf` holds exactly `height` rows of `width` 32-bit pixels as
        // described by `info`; `dc` and `bitmap` are live GDI handles.
        let lines = unsafe {
            GetDIBits(
                dc,
                bitmap,
                0,
                height,
                buf.as_mut_ptr().cast(),
                &mut info,
                DIB_RGB_COLORS,
            )
        };
        (lines == i32::try_from(height).ok()?).then_some(buf)
    }
}

#[cfg(target_os = "macos")]
mod platform {
    use std::path::{Path, PathBuf};

    use super::{best_png_in_icns, data_url, icon_names_from_plist, read_capped};

    const MAX_ICNS_BYTES: u64 = 16 * 1024 * 1024;

    pub(super) fn icon_for(exe: &Path) -> Option<String> {
        let bundle = outermost_app_bundle(exe)?;
        let resources = bundle.join("Contents").join("Resources");
        let named = icon_names_from_plist(&bundle.join("Contents").join("Info.plist"))
            .into_iter()
            .map(|name| resources.join(with_icns_ext(&name)))
            .find(|p| p.is_file());
        let icns = named.or_else(|| fallback_icns(&bundle, &resources))?;
        let data = read_capped(&icns, MAX_ICNS_BYTES)?;
        Some(data_url("image/png", best_png_in_icns(&data)?))
    }

    /// Helpers live in nested bundles (`Foo.app/…/Foo Helper.app`); users know
    /// the outer app, so its icon wins.
    fn outermost_app_bundle(exe: &Path) -> Option<PathBuf> {
        exe.ancestors()
            .filter(|p| {
                p.extension()
                    .is_some_and(|ext| ext.eq_ignore_ascii_case("app"))
                    && p.is_dir()
            })
            .last()
            .map(Path::to_path_buf)
    }

    fn with_icns_ext(name: &str) -> String {
        if name.to_ascii_lowercase().ends_with(".icns") {
            name.to_owned()
        } else {
            format!("{name}.icns")
        }
    }

    fn fallback_icns(bundle: &Path, resources: &Path) -> Option<PathBuf> {
        let stem = bundle
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or_default();
        ["AppIcon.icns".to_owned(), format!("{stem}.icns")]
            .iter()
            .map(|name| resources.join(name))
            .find(|p| p.is_file())
    }
}

#[cfg(target_os = "linux")]
mod platform {
    use std::ffi::OsStr;
    use std::path::{Path, PathBuf};
    use std::sync::{Arc, Mutex};
    use std::time::{Duration, Instant};

    use super::{data_url, read_capped, MAX_ICON_BYTES};

    const MAX_DESKTOP_BYTES: u64 = 256 * 1024;
    /// `.desktop` files are re-scanned after this long, so new installs show up.
    const INDEX_TTL: Duration = Duration::from_secs(300);
    const ICON_SIZES: [&str; 8] = [
        "64x64", "48x48", "96x96", "128x128", "256x256", "512x512", "32x32", "scalable",
    ];
    /// Directories shared by unrelated programs: a common parent proves nothing.
    const SHARED_DIRS: [&str; 16] = [
        "/bin",
        "/sbin",
        "/usr/bin",
        "/usr/sbin",
        "/usr/local/bin",
        "/usr/local/sbin",
        "/usr/games",
        "/usr/local/games",
        "/usr/lib",
        "/usr/lib64",
        "/usr/libexec",
        "/opt/bin",
        "/snap/bin",
        "/var/lib/flatpak/exports/bin",
        "/run/current-system/sw/bin",
        "/nix/var/nix/profiles/default/bin",
    ];
    /// The same, relative to `$HOME` (pipx, cargo, go, `.AppImage` launchers…).
    const HOME_SHARED_DIRS: [&str; 6] = [
        "bin",
        ".local/bin",
        ".cargo/bin",
        "go/bin",
        ".nix-profile/bin",
        ".local/share/flatpak/exports/bin",
    ];
    /// Interpreters and launchers that start many unrelated applications
    /// (`Exec=java -jar app.jar`, `Exec=flatpak run …`): the program says
    /// nothing about which application a process is.
    const LAUNCHERS: [&str; 22] = [
        "sh",
        "bash",
        "dash",
        "zsh",
        "env",
        "java",
        "python",
        "python3",
        "node",
        "perl",
        "ruby",
        "mono",
        "dotnet",
        "wine",
        "gjs",
        "electron",
        "flatpak",
        "snap",
        "steam",
        "gtk-launch",
        "xdg-open",
        "pkexec",
    ];

    #[derive(Debug)]
    pub(super) struct DesktopEntry {
        /// Canonical executable from `Exec=` (or `TryExec=`), when resolvable
        /// and not a shared launcher.
        pub(super) exec: Option<PathBuf>,
        /// Lower-case names that identify the application itself:
        /// `StartupWMClass` and the `.desktop` file id.
        pub(super) ids: Vec<String>,
        /// Lower-case file name of the program (`None` for launchers).
        pub(super) program: Option<String>,
        pub(super) icon: String,
    }

    type Index = Arc<Vec<DesktopEntry>>;
    static INDEX: Mutex<Option<(Instant, Index)>> = Mutex::new(None);

    pub(super) fn icon_for(exe: &Path) -> Option<String> {
        let entries = desktop_index();
        let bases = icon_base_dirs();
        icon_names_for(exe, &entries)
            .iter()
            .find_map(|name| resolve_icon(name, &bases))
    }

    /// Candidate icon names, best first.
    pub(super) fn icon_names_for(exe: &Path, entries: &[DesktopEntry]) -> Vec<String> {
        let mut names = Vec::new();
        if let Some(id) = flatpak_app_id(exe) {
            names.push(id);
        }
        if let Some(icon) = match_desktop_entry(entries, exe, home_dir().as_deref()) {
            names.push(icon);
        }
        // Many packages name their icon after the binary.
        if let Some(base) = exe.file_name().and_then(OsStr::to_str) {
            names.push(base.to_owned());
        }
        names
    }

    /// `/var/lib/flatpak/app/<id>/<arch>/<branch>/<hash>/files/bin/foo` → `<id>`.
    fn flatpak_app_id(exe: &Path) -> Option<String> {
        let text = exe.to_str()?;
        let rest = text.split_once("/flatpak/app/")?.1;
        let id = rest.split('/').next()?;
        (id.contains('.') && !id.contains("..")).then(|| id.to_owned())
    }

    /// `google-chrome` / `org.mozilla.firefox` name the `chrome` / `firefox` binary.
    fn id_names(id: &str, base: &str) -> bool {
        id == base
            || id
                .strip_suffix(base)
                .is_some_and(|rest| rest.ends_with(['-', '.', '_']))
    }

    /// The one entry among `candidates`; when several share it (web-app
    /// shortcuts next to their browser), the single one whose id names
    /// `base`. `None` when the choice would be a guess.
    fn pick<'a>(candidates: &[&'a DesktopEntry], base: &str) -> Option<&'a DesktopEntry> {
        if let [only] = candidates {
            return Some(*only);
        }
        let exact = candidates
            .iter()
            .find(|e| e.ids.iter().any(|id| id == base));
        if let Some(entry) = exact {
            return Some(*entry);
        }
        let mut named = candidates
            .iter()
            .filter(|e| e.ids.iter().any(|id| id_names(id, base)));
        match (named.next(), named.next()) {
            (Some(entry), None) => Some(*entry),
            _ => None,
        }
    }

    fn is_shared_dir(dir: &Path, home: Option<&Path>) -> bool {
        SHARED_DIRS.iter().any(|shared| Path::new(shared) == dir)
            || home.is_some_and(|h| HOME_SHARED_DIRS.iter().any(|rel| h.join(rel) == dir))
    }

    pub(super) fn match_desktop_entry(
        entries: &[DesktopEntry],
        exe: &Path,
        home: Option<&Path>,
    ) -> Option<String> {
        let canonical = std::fs::canonicalize(exe).unwrap_or_else(|_err| exe.to_path_buf());
        let base = exe.file_name()?.to_str()?.to_ascii_lowercase();
        let filtered = |keep: &dyn Fn(&DesktopEntry) -> bool| -> Vec<&DesktopEntry> {
            entries.iter().filter(|e| keep(e)).collect()
        };
        // 1. The entry launches exactly this executable.
        pick(
            &filtered(&|e| e.exec.as_deref() == Some(canonical.as_path())),
            &base,
        )
        // 2. The window class or desktop file id is the process name.
        .or_else(|| entries.iter().find(|e| e.ids.contains(&base)))
        // 3. The entry's program has this name (only when unambiguous).
        .or_else(|| {
            pick(
                &filtered(&|e| e.program.as_deref() == Some(base.as_str())),
                &base,
            )
        })
        // 4. A helper in the application's own directory (not a shared bin dir).
        .or_else(|| {
            let dir = canonical.parent().filter(|d| !is_shared_dir(d, home))?;
            pick(
                &filtered(&|e| e.exec.as_deref().and_then(Path::parent) == Some(dir)),
                &base,
            )
        })
        .map(|e| e.icon.clone())
    }

    fn desktop_index() -> Index {
        let cached = INDEX.lock().ok().and_then(|guard| {
            guard
                .as_ref()
                .filter(|(built, _)| built.elapsed() < INDEX_TTL)
                .map(|(_, index)| Arc::clone(index))
        });
        if let Some(index) = cached {
            return index;
        }
        let index: Index = Arc::new(build_index(&desktop_dirs()));
        if let Ok(mut guard) = INDEX.lock() {
            *guard = Some((Instant::now(), Arc::clone(&index)));
        }
        index
    }

    fn home_dir() -> Option<PathBuf> {
        std::env::var_os("HOME")
            .filter(|h| !h.is_empty())
            .map(PathBuf::from)
    }

    /// `$XDG_DATA_HOME` followed by `$XDG_DATA_DIRS`, with the spec defaults.
    fn data_dirs() -> Vec<PathBuf> {
        let mut dirs = Vec::new();
        match std::env::var_os("XDG_DATA_HOME").filter(|v| !v.is_empty()) {
            Some(v) => dirs.push(PathBuf::from(v)),
            None => dirs.extend(home_dir().map(|h| h.join(".local").join("share"))),
        }
        match std::env::var_os("XDG_DATA_DIRS").filter(|v| !v.is_empty()) {
            Some(v) => dirs.extend(std::env::split_paths(&v)),
            None => dirs.extend([
                PathBuf::from("/usr/local/share"),
                PathBuf::from("/usr/share"),
            ]),
        }
        dirs.push(PathBuf::from("/var/lib/flatpak/exports/share"));
        dirs.extend(home_dir().map(|h| h.join(".local/share/flatpak/exports/share")));
        dirs.dedup();
        dirs
    }

    fn desktop_dirs() -> Vec<PathBuf> {
        let mut dirs: Vec<PathBuf> = data_dirs().iter().map(|d| d.join("applications")).collect();
        dirs.push(PathBuf::from("/var/lib/snapd/desktop/applications"));
        dirs
    }

    fn icon_base_dirs() -> Vec<PathBuf> {
        let mut dirs: Vec<PathBuf> = data_dirs().iter().map(|d| d.join("icons")).collect();
        dirs.extend(home_dir().map(|h| h.join(".icons")));
        dirs
    }

    pub(super) fn build_index(dirs: &[PathBuf]) -> Vec<DesktopEntry> {
        let mut files = Vec::new();
        for dir in dirs {
            collect_desktop_files(dir, 1, &mut files);
        }
        files.iter().filter_map(|f| parse_desktop(f)).collect()
    }

    fn collect_desktop_files(dir: &Path, depth: u8, out: &mut Vec<PathBuf>) {
        let Ok(read) = std::fs::read_dir(dir) else {
            return;
        };
        let mut paths: Vec<PathBuf> = read
            .filter_map(Result::ok)
            .map(|entry| entry.path())
            .collect();
        paths.sort();
        for path in paths {
            if path.extension().is_some_and(|ext| ext == "desktop") {
                out.push(path);
            } else if depth > 0 && path.is_dir() {
                collect_desktop_files(&path, depth - 1, out);
            }
        }
    }

    pub(super) fn parse_desktop(file: &Path) -> Option<DesktopEntry> {
        let bytes = read_capped(file, MAX_DESKTOP_BYTES)?;
        let text = String::from_utf8_lossy(&bytes);
        let (mut exec, mut try_exec, mut icon, mut wm_class) = (None, None, None, None);
        let mut in_main = false;
        for line in text.lines().map(str::trim) {
            if line.starts_with('[') {
                in_main = line == "[Desktop Entry]";
                continue;
            }
            if !in_main {
                continue;
            }
            let Some((key, raw_value)) = line.split_once('=') else {
                continue;
            };
            let value = raw_value.trim();
            match key.trim() {
                "Exec" => exec = Some(value),
                "TryExec" => try_exec = Some(value),
                "Icon" => icon = Some(value),
                "StartupWMClass" => wm_class = Some(value),
                "Hidden" if value.eq_ignore_ascii_case("true") => return None,
                "Type" if value != "Application" => return None,
                _ => {}
            }
        }
        let icon_name = icon.filter(|i| !i.is_empty())?.to_owned();
        let program_owned = try_exec
            .map(str::to_owned)
            .or_else(|| exec.and_then(exec_program));
        let program_name = program_owned
            .as_deref()
            .and_then(file_name_of)
            .map(str::to_ascii_lowercase)
            .filter(|name| !name.is_empty() && !is_launcher(name));
        let mut ids: Vec<String> = Vec::new();
        for name in [wm_class, file.file_stem().and_then(OsStr::to_str)]
            .into_iter()
            .flatten()
        {
            let lower = name.to_ascii_lowercase();
            if !lower.is_empty() && !ids.contains(&lower) {
                ids.push(lower);
            }
        }
        Some(DesktopEntry {
            exec: program_name
                .as_ref()
                .and(program_owned.as_deref())
                .and_then(resolve_program),
            ids,
            program: program_name,
            icon: icon_name,
        })
    }

    /// The program of an `Exec=` line, skipping `env` and `VAR=value` prefixes.
    pub(super) fn exec_program(exec: &str) -> Option<String> {
        exec_tokens(exec)
            .into_iter()
            .find(|token| token != "env" && !token.contains('=') && !token.is_empty())
    }

    /// Splits an `Exec=` value into arguments, honouring double quotes.
    fn exec_tokens(exec: &str) -> Vec<String> {
        let mut tokens = Vec::new();
        let mut current = String::new();
        let mut quoted = false;
        let mut escaped = false;
        for ch in exec.chars() {
            if escaped {
                current.push(ch);
                escaped = false;
            } else if ch == '\\' && quoted {
                escaped = true;
            } else if ch == '"' {
                quoted = !quoted;
            } else if ch.is_whitespace() && !quoted {
                if !current.is_empty() {
                    tokens.push(std::mem::take(&mut current));
                }
            } else {
                current.push(ch);
            }
        }
        if !current.is_empty() {
            tokens.push(current);
        }
        tokens
    }

    /// `java`, `python3.12`, `node` …: a shared interpreter or launcher.
    fn is_launcher(name: &str) -> bool {
        let stem = name.trim_end_matches(|c: char| c.is_ascii_digit() || c == '.');
        LAUNCHERS.contains(&name) || LAUNCHERS.contains(&stem)
    }

    fn file_name_of(program: &str) -> Option<&str> {
        Path::new(program).file_name().and_then(OsStr::to_str)
    }

    fn resolve_program(program: &str) -> Option<PathBuf> {
        let path = Path::new(program);
        let found = if path.is_absolute() {
            path.to_path_buf()
        } else {
            let search = std::env::var_os("PATH")?;
            std::env::split_paths(&search)
                .map(|dir| dir.join(program))
                .find(|candidate| candidate.is_file())?
        };
        std::fs::canonicalize(&found).ok().or(Some(found))
    }

    pub(super) fn resolve_icon(name: &str, bases: &[PathBuf]) -> Option<String> {
        if name.starts_with('/') {
            return icon_file_url(Path::new(name));
        }
        if name.contains('/') || name.contains("..") {
            return None;
        }
        let stem = name
            .strip_suffix(".png")
            .or_else(|| name.strip_suffix(".svg"))
            .unwrap_or(name);
        for base in bases {
            let theme = base.join("hicolor");
            for size in ICON_SIZES {
                let apps = theme.join(size).join("apps");
                let exts: &[&str] = if size == "scalable" {
                    &["svg"]
                } else {
                    &["png", "svg"]
                };
                for ext in exts {
                    if let Some(url) = icon_file_url(&apps.join(format!("{stem}.{ext}"))) {
                        return Some(url);
                    }
                }
            }
        }
        let mut loose: Vec<PathBuf> = bases.to_vec();
        loose.push(PathBuf::from("/usr/share/pixmaps"));
        loose.iter().find_map(|dir| {
            ["png", "svg"]
                .iter()
                .find_map(|ext| icon_file_url(&dir.join(format!("{stem}.{ext}"))))
        })
    }

    fn icon_file_url(path: &Path) -> Option<String> {
        let mime = match path.extension().and_then(OsStr::to_str)? {
            "png" => "image/png",
            "svg" => "image/svg+xml",
            _ => return None,
        };
        Some(data_url(mime, &read_capped(path, MAX_ICON_BYTES)?))
    }
}

#[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
mod platform {
    pub(super) const fn icon_for(_exe: &std::path::Path) -> Option<String> {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_relative_network_and_malformed_paths() {
        assert!(!is_acceptable_path(""));
        assert!(!is_acceptable_path("chrome.exe"));
        assert!(!is_acceptable_path("\\\\server\\share\\app.exe"));
        assert!(!is_acceptable_path("//server/share/app"));
        assert!(!is_acceptable_path("/usr/bin/a\0b"));
        assert!(!is_acceptable_path(&format!(
            "/{}",
            "a".repeat(MAX_PATH_LEN)
        )));
        #[cfg(unix)]
        assert!(is_acceptable_path("/usr/bin/curl"));
    }

    #[test]
    fn crc32_matches_png_reference() {
        // CRC of the bare IEND chunk type, as found at the end of every PNG.
        assert_eq!(crc32(b"IEND".iter()), 0xAE42_6082);
    }

    #[test]
    fn encodes_a_valid_rgba_png() {
        use std::io::Read as _;

        let pixels = [255, 0, 0, 255, 0, 0, 255, 128];
        let png = encode_png(2, 1, &pixels).unwrap();
        assert_eq!(png.get(..8).unwrap(), PNG_SIGNATURE);
        // IHDR: length 13, then width 2, height 1, depth 8, colour type 6.
        assert_eq!(
            png.get(8..16).unwrap(),
            [0, 0, 0, 13, b'I', b'H', b'D', b'R']
        );
        assert_eq!(png.get(16..24).unwrap(), [0, 0, 0, 2, 0, 0, 0, 1]);
        assert_eq!(png.get(24..26).unwrap(), [8, 6]);
        let ihdr_crc = u32::from_be_bytes(png.get(29..33).unwrap().try_into().unwrap());
        assert_eq!(ihdr_crc, crc32(png.get(12..29).unwrap().iter()));
        // IDAT inflates back to one filtered row.
        let idat_len = u32::from_be_bytes(png.get(33..37).unwrap().try_into().unwrap()) as usize;
        assert_eq!(png.get(37..41).unwrap(), b"IDAT");
        let mut raw = Vec::new();
        flate2::read::ZlibDecoder::new(png.get(41..41 + idat_len).unwrap())
            .read_to_end(&mut raw)
            .unwrap();
        assert_eq!(raw, [0, 255, 0, 0, 255, 0, 0, 255, 128]);
        assert!(png.ends_with(&[0, 0, 0, 0, b'I', b'E', b'N', b'D', 0xAE, 0x42, 0x60, 0x82]));
    }

    #[test]
    fn rejects_mismatched_pixel_buffers() {
        assert!(encode_png(2, 2, &[0; 4]).is_none());
        assert!(encode_png(0, 1, &[]).is_none());
    }

    fn icns_entry(kind: [u8; 4], body: &[u8]) -> Vec<u8> {
        let mut out = kind.to_vec();
        out.extend_from_slice(&u32::try_from(body.len() + 8).unwrap().to_be_bytes());
        out.extend_from_slice(body);
        out
    }

    #[test]
    fn picks_the_64px_png_from_icns() {
        let png_small = [PNG_SIGNATURE.as_slice(), b"small"].concat();
        let png_64 = [PNG_SIGNATURE.as_slice(), b"sixty-four"].concat();
        let mut body = icns_entry(*b"is32", b"legacy-rle");
        body.extend(icns_entry(*b"ic11", &png_small));
        body.extend(icns_entry(*b"ic12", &png_64));
        body.extend(icns_entry(*b"ic08", b"\0\0\0\x0cjP  jpeg2000"));
        let mut file = b"icns".to_vec();
        file.extend_from_slice(&u32::try_from(body.len() + 8).unwrap().to_be_bytes());
        file.extend(body);
        assert_eq!(best_png_in_icns(&file), Some(png_64.as_slice()));
        assert_eq!(best_png_in_icns(b"notanicns"), None);
        // A truncated entry stops the scan instead of reading past the end.
        let mut truncated = b"icns\0\0\0\x20".to_vec();
        truncated.extend_from_slice(b"ic07\0\0\xff\xff");
        assert_eq!(best_png_in_icns(&truncated), None);
    }

    #[test]
    fn reads_icon_names_from_xml_and_binary_plists() {
        let tmp = tempfile::tempdir().unwrap();
        let mut dict = plist::Dictionary::new();
        dict.insert("CFBundleIconFile".to_owned(), "Electron.icns".into());
        dict.insert("CFBundleIconName".to_owned(), "AppIcon".into());
        let value = plist::Value::Dictionary(dict);
        let xml = tmp.path().join("xml.plist");
        value.to_file_xml(&xml).unwrap();
        let binary = tmp.path().join("binary.plist");
        value.to_file_binary(&binary).unwrap();
        assert!(std::fs::read(&binary).unwrap().starts_with(b"bplist"));
        for file in [&xml, &binary] {
            assert_eq!(icon_names_from_plist(file), ["Electron.icns", "AppIcon"]);
        }
        let mut evil = plist::Dictionary::new();
        evil.insert("CFBundleIconFile".to_owned(), "../../../etc/x".into());
        let evil_path = tmp.path().join("evil.plist");
        plist::Value::Dictionary(evil)
            .to_file_binary(&evil_path)
            .unwrap();
        assert!(icon_names_from_plist(&evil_path).is_empty());
        std::fs::write(tmp.path().join("junk.plist"), b"bplist00garbage").unwrap();
        assert!(icon_names_from_plist(&tmp.path().join("junk.plist")).is_empty());
    }

    #[test]
    fn misses_expire_but_found_icons_stay() {
        cache_put(
            "/test/found".to_owned(),
            Some("data:image/png;base64,AA==".to_owned()),
        );
        cache_put("/test/missing".to_owned(), None);
        assert_eq!(
            cache_get("/test/found"),
            Some(Some("data:image/png;base64,AA==".to_owned()))
        );
        assert_eq!(cache_get("/test/missing"), Some(None));
        // Age both entries past the miss lifetime.
        let past = Instant::now()
            .checked_sub(MISS_TTL + Duration::from_secs(1))
            .unwrap();
        if let Some(map) = CACHE.lock().unwrap().as_mut() {
            for key in ["/test/found", "/test/missing"] {
                if let Some(entry) = map.get_mut(key) {
                    entry.1 = past;
                }
            }
        }
        assert!(cache_get("/test/found").is_some());
        assert_eq!(cache_get("/test/missing"), None);
    }

    #[cfg(target_os = "linux")]
    mod linux {
        use super::super::platform::{
            build_index, exec_program, icon_names_for, match_desktop_entry, parse_desktop,
            resolve_icon,
        };
        use std::path::Path;

        #[test]
        fn exec_program_skips_env_prefixes() {
            assert_eq!(
                exec_program("env FOO=1 BAR=2 /opt/app/app %U").as_deref(),
                Some("/opt/app/app")
            );
            assert_eq!(
                exec_program("\"/opt/My App/app\" --x").as_deref(),
                Some("/opt/My App/app")
            );
            assert_eq!(
                exec_program("telegram-desktop -- %u").as_deref(),
                Some("telegram-desktop")
            );
        }

        #[test]
        fn matches_desktop_entries_and_resolves_hicolor_icons() {
            let tmp = tempfile::tempdir().unwrap();
            let apps = tmp.path().join("applications");
            std::fs::create_dir_all(&apps).unwrap();
            let app_dir = tmp.path().join("opt/editor");
            std::fs::create_dir_all(&app_dir).unwrap();
            let exe = app_dir.join("editor-bin");
            std::fs::write(&exe, b"").unwrap();
            std::fs::write(
                apps.join("editor.desktop"),
                format!(
                    "[Desktop Entry]\nType=Application\nName=Editor\nExec=env X=1 {} %F\nIcon=editor-icon\n\n[Desktop Action new]\nIcon=wrong\n",
                    exe.display()
                ),
            )
            .unwrap();
            std::fs::write(
                apps.join("chat.desktop"),
                "[Desktop Entry]\nType=Application\nExec=chat-launcher\nStartupWMClass=ChatApp\nIcon=chat\n",
            )
            .unwrap();
            std::fs::write(
                apps.join("gone.desktop"),
                "[Desktop Entry]\nHidden=true\nExec=gone\nIcon=gone\n",
            )
            .unwrap();
            std::fs::write(
                apps.join("link.desktop"),
                "[Desktop Entry]\nType=Link\nIcon=link\n",
            )
            .unwrap();

            let entries = build_index(std::slice::from_ref(&apps));
            assert_eq!(entries.len(), 2);
            assert_eq!(
                match_desktop_entry(&entries, &exe, None),
                Some("editor-icon".to_owned())
            );
            // A sibling binary in the same application directory still matches.
            let helper = app_dir.join("helper");
            std::fs::write(&helper, b"").unwrap();
            assert_eq!(
                match_desktop_entry(&entries, &helper, None),
                Some("editor-icon".to_owned())
            );
            assert_eq!(
                match_desktop_entry(&entries, Path::new("/usr/lib/chatapp"), None),
                Some("chat".to_owned())
            );
            assert_eq!(
                match_desktop_entry(&entries, Path::new("/usr/bin/unknown"), None),
                None
            );
            assert!(parse_desktop(&apps.join("gone.desktop")).is_none());

            let icons = tmp.path().join("icons");
            let sized = icons.join("hicolor/48x48/apps");
            std::fs::create_dir_all(&sized).unwrap();
            std::fs::write(sized.join("editor-icon.png"), b"\x89PNG-ish").unwrap();
            let url = resolve_icon("editor-icon", std::slice::from_ref(&icons)).unwrap();
            assert!(url.starts_with("data:image/png;base64,"));
            let scalable = icons.join("hicolor/scalable/apps");
            std::fs::create_dir_all(&scalable).unwrap();
            std::fs::write(scalable.join("chat.svg"), b"<svg/>").unwrap();
            assert!(resolve_icon("chat", std::slice::from_ref(&icons))
                .unwrap()
                .starts_with("data:image/svg+xml;base64,"));
            assert!(resolve_icon("../etc/passwd", std::slice::from_ref(&icons)).is_none());
            assert!(resolve_icon("missing", &[icons]).is_none());

            let names = icon_names_for(
                Path::new("/var/lib/flatpak/app/org.example.Chat/x86_64/stable/abc/files/bin/chat"),
                &entries,
            );
            assert_eq!(names.first().map(String::as_str), Some("org.example.Chat"));
        }

        #[test]
        fn shared_launchers_do_not_lend_their_icon() {
            let tmp = tempfile::tempdir().unwrap();
            let apps = tmp.path().join("applications");
            std::fs::create_dir_all(&apps).unwrap();
            std::fs::write(
                apps.join("ide.desktop"),
                "[Desktop Entry]\nType=Application\nExec=java -jar /opt/ide/ide.jar\nIcon=ide\n",
            )
            .unwrap();
            std::fs::write(
                apps.join("tool.desktop"),
                "[Desktop Entry]\nType=Application\nExec=python3.12 -m tool\nIcon=tool\n",
            )
            .unwrap();
            let entries = build_index(std::slice::from_ref(&apps));
            assert_eq!(entries.len(), 2);
            assert!(entries
                .iter()
                .all(|e| e.exec.is_none() && e.program.is_none()));
            // Any Java / Python process is not "the IDE" or "the tool".
            assert_eq!(
                match_desktop_entry(&entries, Path::new("/usr/bin/java"), None),
                None
            );
            assert_eq!(
                match_desktop_entry(&entries, Path::new("/usr/bin/python3.12"), None),
                None
            );
            // The desktop file id still identifies the app itself.
            assert_eq!(
                match_desktop_entry(&entries, Path::new("/opt/ide/bin/ide"), None),
                Some("ide".to_owned())
            );
        }

        #[test]
        fn shared_and_ambiguous_dirs_do_not_match_by_directory() {
            let tmp = tempfile::tempdir().unwrap();
            let home = tmp.path().join("home");
            let user_bin = home.join(".local/bin");
            std::fs::create_dir_all(&user_bin).unwrap();
            let apps = tmp.path().join("applications");
            std::fs::create_dir_all(&apps).unwrap();
            let appimage = user_bin.join("Notes.AppImage");
            std::fs::write(&appimage, b"").unwrap();
            let cli = user_bin.join("ripgrep");
            std::fs::write(&cli, b"").unwrap();
            std::fs::write(
                apps.join("notes.desktop"),
                format!(
                    "[Desktop Entry]\nType=Application\nExec={}\nIcon=notes\n",
                    appimage.display()
                ),
            )
            .unwrap();
            // Two apps in one plain directory: a third binary there is ambiguous.
            let opt = tmp.path().join("opt/suite");
            std::fs::create_dir_all(&opt).unwrap();
            for (name, icon) in [("writer", "suite-writer"), ("calc", "suite-calc")] {
                let exe = opt.join(name);
                std::fs::write(&exe, b"").unwrap();
                std::fs::write(
                    apps.join(format!("{name}.desktop")),
                    format!(
                        "[Desktop Entry]\nType=Application\nExec={}\nIcon={icon}\n",
                        exe.display()
                    ),
                )
                .unwrap();
            }
            let helper = opt.join("updater");
            std::fs::write(&helper, b"").unwrap();
            // A browser launched by a wrapper script, with web-app shortcuts beside it.
            let browser_dir = tmp.path().join("opt/browser");
            std::fs::create_dir_all(&browser_dir).unwrap();
            let wrapper = browser_dir.join("acme-browser");
            std::fs::write(&wrapper, b"").unwrap();
            let browser = browser_dir.join("browser");
            std::fs::write(&browser, b"").unwrap();
            for (file, icon) in [
                ("acme-browser", "acme-browser"),
                ("browser-app1-Default", "app1"),
                ("browser-app2-Default", "app2"),
            ] {
                std::fs::write(
                    apps.join(format!("{file}.desktop")),
                    format!(
                        "[Desktop Entry]\nType=Application\nExec={} --app-id={file}\nIcon={icon}\n",
                        wrapper.display()
                    ),
                )
                .unwrap();
            }

            let entries = build_index(std::slice::from_ref(&apps));
            assert_eq!(
                match_desktop_entry(&entries, &appimage, Some(&home)),
                Some("notes".to_owned())
            );
            assert_eq!(match_desktop_entry(&entries, &cli, Some(&home)), None);
            assert_eq!(
                match_desktop_entry(&entries, &opt.join("calc"), Some(&home)),
                Some("suite-calc".to_owned())
            );
            assert_eq!(match_desktop_entry(&entries, &helper, Some(&home)), None);
            assert_eq!(
                match_desktop_entry(&entries, &browser, Some(&home)),
                Some("acme-browser".to_owned())
            );
        }
    }
}
