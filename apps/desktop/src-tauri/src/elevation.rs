//! Relaunching the app with administrator rights (Windows).
//!
//! TUN on Windows needs an elevated process: the core creates a Wintun adapter
//! and rewrites routes, and it inherits the app's token. macOS restarts only the
//! core as root and Linux grants the core binary capabilities; on Windows the
//! core cannot be elevated on its own without losing the pipes and job object
//! the app manages it through, so the whole app is relaunched through UAC
//! (`ShellExecuteExW` with the `runas` verb).
//!
//! The elevated instance is started while this one is still running, so it is
//! told this process's PID and waits for it to exit before going any further:
//! otherwise the single-instance plugin would hand it straight back to the
//! instance that is shutting down.
//!
//! Only a split administrator token (UAC's filtered admin, "Limited") is
//! relaunched. On a standard account UAC asks for another user's credentials,
//! and the elevated process would then run as that user, with that user's
//! settings directory — the user's profiles and subscriptions would be gone.

/// Command-line prefix carrying the PID of the instance being replaced.
#[cfg(target_os = "windows")]
const WAIT_PID_ARG: &str = "--zephyr-wait-pid=";

/// Upper bound on waiting for the previous instance (it stops the core first).
#[cfg(target_os = "windows")]
const WAIT_PID_TIMEOUT_MS: u32 = 15_000;

/// After terminating a previous instance that overran the wait, how long to
/// wait for it to be gone.
#[cfg(target_os = "windows")]
const TERMINATE_WAIT_MS: u32 = 5_000;

/// `SW_SHOWNORMAL` (the constant lives behind an unused `windows-sys` feature).
#[cfg(target_os = "windows")]
const SW_SHOWNORMAL: i32 = 1;

#[cfg(target_os = "windows")]
fn to_wide(value: &std::ffi::OsStr) -> Vec<u16> {
    use std::os::windows::ffi::OsStrExt as _;
    value.encode_wide().chain(std::iter::once(0)).collect()
}

/// Whether this process runs with an elevated (administrator) token.
#[cfg(target_os = "windows")]
#[must_use]
pub fn is_elevated() -> bool {
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::Security::{
        GetTokenInformation, TokenElevation, TOKEN_ELEVATION, TOKEN_QUERY,
    };
    use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

    // SAFETY: returns a pseudo-handle for the current process; it needs no closing.
    let process = unsafe { GetCurrentProcess() };
    let mut token: HANDLE = std::ptr::null_mut();
    // SAFETY: `process` is valid and `token` is a writable out-pointer.
    if unsafe { OpenProcessToken(process, TOKEN_QUERY, &mut token) } == 0 {
        return false;
    }

    let mut elevation = TOKEN_ELEVATION { TokenIsElevated: 0 };
    let size = u32::try_from(std::mem::size_of::<TOKEN_ELEVATION>()).unwrap_or(0);
    let mut returned: u32 = 0;
    // SAFETY: `token` was opened with TOKEN_QUERY, and the buffer is a
    // `TOKEN_ELEVATION` of exactly `size` bytes, as `TokenElevation` expects.
    let ok = unsafe {
        GetTokenInformation(
            token,
            TokenElevation,
            std::ptr::from_mut(&mut elevation).cast::<core::ffi::c_void>(),
            size,
            &mut returned,
        )
    };
    // SAFETY: `token` is a valid handle opened above and closed exactly once.
    unsafe { CloseHandle(token) };
    ok != 0 && elevation.TokenIsElevated != 0
}

/// Whether the token is UAC's filtered administrator token, i.e. elevating
/// keeps the same user (see the module docs).
#[cfg(target_os = "windows")]
fn has_linked_admin_token() -> bool {
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::Security::{
        GetTokenInformation, TokenElevationType, TokenElevationTypeLimited, TOKEN_ELEVATION_TYPE,
        TOKEN_QUERY,
    };
    use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

    // SAFETY: returns a pseudo-handle for the current process; it needs no closing.
    let process = unsafe { GetCurrentProcess() };
    let mut token: HANDLE = std::ptr::null_mut();
    // SAFETY: `process` is valid and `token` is a writable out-pointer.
    if unsafe { OpenProcessToken(process, TOKEN_QUERY, &mut token) } == 0 {
        return false;
    }

    let mut kind: TOKEN_ELEVATION_TYPE = 0;
    let size = u32::try_from(std::mem::size_of::<TOKEN_ELEVATION_TYPE>()).unwrap_or(0);
    let mut returned: u32 = 0;
    // SAFETY: `token` was opened with TOKEN_QUERY, and the buffer is a
    // `TOKEN_ELEVATION_TYPE` of exactly `size` bytes, as `TokenElevationType`
    // expects.
    let ok = unsafe {
        GetTokenInformation(
            token,
            TokenElevationType,
            std::ptr::from_mut(&mut kind).cast::<core::ffi::c_void>(),
            size,
            &mut returned,
        )
    };
    // SAFETY: `token` is a valid handle opened above and closed exactly once.
    unsafe { CloseHandle(token) };
    ok != 0 && kind == TokenElevationTypeLimited
}

/// PID of a previous instance that overran the wait and was terminated. The
/// wait runs before logging is set up, so `setup` logs it later
/// ([`log_forced_replacement`]).
#[cfg(target_os = "windows")]
static TERMINATED_PID: std::sync::OnceLock<u32> = std::sync::OnceLock::new();

/// Whether `handle` is a process running the same executable as this one.
/// Guards the wait and the termination against a reused or arbitrary PID.
#[cfg(target_os = "windows")]
fn is_same_executable(handle: windows_sys::Win32::Foundation::HANDLE) -> bool {
    use std::os::windows::ffi::OsStringExt as _;
    use windows_sys::Win32::System::Threading::{QueryFullProcessImageNameW, PROCESS_NAME_WIN32};

    let Ok(own) = std::env::current_exe() else {
        return false;
    };
    let mut buf = vec![0u16; 32_768];
    let mut len = u32::try_from(buf.len()).unwrap_or(0);
    // SAFETY: `handle` was opened with PROCESS_QUERY_LIMITED_INFORMATION, and
    // `buf` holds `len` u16 slots, which the call fills and shortens `len` to.
    let ok = unsafe {
        QueryFullProcessImageNameW(handle, PROCESS_NAME_WIN32, buf.as_mut_ptr(), &mut len)
    };
    if ok == 0 {
        return false;
    }
    buf.truncate(usize::try_from(len).unwrap_or(0));
    let other = std::path::PathBuf::from(std::ffi::OsString::from_wide(&buf));
    same_path_ignoring_case(&other, &own)
}

/// Windows paths compare case-insensitively.
#[cfg(any(target_os = "windows", test))]
fn same_path_ignoring_case(a: &std::path::Path, b: &std::path::Path) -> bool {
    a.to_string_lossy().to_lowercase() == b.to_string_lossy().to_lowercase()
}

/// Wait for the instance this one replaces (see the module docs).
///
/// Called first thing in `run()`. Without the argument it returns at once; a
/// PID that is already gone (`OpenProcess` fails) or that is not running this
/// executable also returns at once. If the old instance is still alive after
/// the wait, it is terminated: carrying on would hand this launch to it
/// through the single-instance plugin, and the user, having just accepted UAC,
/// would be left with no Zephyr at all.
#[cfg(target_os = "windows")]
pub fn wait_for_replaced_instance() {
    use windows_sys::Win32::Foundation::{CloseHandle, WAIT_TIMEOUT};
    use windows_sys::Win32::System::Threading::{
        OpenProcess, TerminateProcess, WaitForSingleObject, PROCESS_QUERY_LIMITED_INFORMATION,
        PROCESS_SYNCHRONIZE, PROCESS_TERMINATE,
    };

    // `args_os`: `args` panics on an argument that is not valid Unicode, and
    // this runs before the panic hook is installed.
    let Some(pid) = std::env::args_os().find_map(|arg| {
        arg.to_str()?
            .strip_prefix(WAIT_PID_ARG)
            .and_then(|pid| pid.parse::<u32>().ok())
    }) else {
        return;
    };
    // SAFETY: plain value arguments; a null handle is handled below.
    let handle = unsafe {
        OpenProcess(
            PROCESS_SYNCHRONIZE | PROCESS_TERMINATE | PROCESS_QUERY_LIMITED_INFORMATION,
            0,
            pid,
        )
    };
    if handle.is_null() {
        return;
    }
    // Only another copy of this executable is waited for, let alone killed.
    if is_same_executable(handle) {
        // SAFETY: `handle` is a process handle opened with SYNCHRONIZE.
        if unsafe { WaitForSingleObject(handle, WAIT_PID_TIMEOUT_MS) } == WAIT_TIMEOUT {
            // SAFETY: `handle` was opened with PROCESS_TERMINATE.
            unsafe { TerminateProcess(handle, 1) };
            // SAFETY: `handle` is a process handle opened with SYNCHRONIZE.
            unsafe { WaitForSingleObject(handle, TERMINATE_WAIT_MS) };
            let _ = TERMINATED_PID.set(pid);
        }
    }
    // SAFETY: `handle` is valid and closed exactly once.
    unsafe { CloseHandle(handle) };
}

/// Log a previous instance terminated by [`wait_for_replaced_instance`].
/// Called from `setup` once the app handle and the app log are ready.
#[cfg(target_os = "windows")]
pub fn log_forced_replacement() {
    if let Some(pid) = TERMINATED_PID.get() {
        emit_warn!(
            System,
            SYS_TUN_FAILED,
            "Previous instance (PID {pid}) did not exit within {WAIT_PID_TIMEOUT_MS} ms and was terminated"
        );
    }
}

/// Start this executable again through UAC. Returns once the elevated process
/// exists; `Err("canceled")` when the user declined the UAC prompt.
#[cfg(target_os = "windows")]
fn relaunch_elevated() -> Result<(), String> {
    use std::ffi::OsStr;
    use windows_sys::Win32::Foundation::{GetLastError, ERROR_CANCELLED};
    use windows_sys::Win32::UI::Shell::{ShellExecuteExW, SEE_MASK_NOASYNC, SHELLEXECUTEINFOW};

    let exe =
        std::env::current_exe().map_err(|e| format!("Failed to locate the app executable: {e}"))?;
    let cwd = std::env::current_dir().ok();
    let pid = std::process::id();

    let verb = to_wide(OsStr::new("runas"));
    let file = to_wide(exe.as_os_str());
    let params = to_wide(OsStr::new(&format!("{WAIT_PID_ARG}{pid}")));
    let dir = cwd.as_deref().map(|d| to_wide(d.as_os_str()));

    // SAFETY: SHELLEXECUTEINFOW is a plain C struct for which all-zero means
    // "not set" in every field (null pointers, no flags).
    let mut info: SHELLEXECUTEINFOW = unsafe { std::mem::zeroed() };
    info.cbSize = u32::try_from(std::mem::size_of::<SHELLEXECUTEINFOW>())
        .map_err(|e| format!("SHELLEXECUTEINFOW size: {e}"))?;
    // The caller exits right after this returns: let the launch finish first.
    info.fMask = SEE_MASK_NOASYNC;
    info.lpVerb = verb.as_ptr();
    info.lpFile = file.as_ptr();
    info.lpParameters = params.as_ptr();
    info.lpDirectory = dir.as_ref().map_or(std::ptr::null(), Vec::as_ptr);
    info.nShow = SW_SHOWNORMAL;

    // SAFETY: `info` is initialised and every string it points to outlives the call.
    if unsafe { ShellExecuteExW(&mut info) } != 0 {
        return Ok(());
    }
    // SAFETY: reads the calling thread's last-error value.
    let err = unsafe { GetLastError() };
    if err == ERROR_CANCELLED {
        Err("canceled".to_owned())
    } else {
        Err(format!("Elevated relaunch failed (error {err})"))
    }
}

/// Whether the app runs elevated. Only meaningful on Windows, where TUN needs it.
#[tauri::command]
#[cfg(target_os = "windows")]
#[must_use]
pub fn is_process_elevated() -> bool {
    is_elevated()
}

/// On non-Windows platforms TUN has its own privilege path; reports `false`.
#[tauri::command]
#[cfg(not(target_os = "windows"))]
#[must_use]
pub const fn is_process_elevated() -> bool {
    false
}

/// Relaunch Zephyr as administrator and quit this instance.
///
/// With `enable_tun`, TUN is recorded as on before the UAC prompt, so the
/// elevated instance (which waits for this one to exit before reading
/// settings) starts the core with TUN. A failed write stops here with
/// `pref_save_failed` rather than relaunching into a session without TUN; a
/// declined or failed prompt puts the previous preference back. The saved
/// preference stays on afterwards, and a later non-elevated launch does not
/// apply it (see `Settings::to_global_prefs`).
///
/// `not_admin_user` when the account cannot elevate as itself (module docs).
///
/// Runs on the main thread (a sync command): `ShellExecuteExW` wants COM, which
/// the WebView already initialised there.
#[tauri::command]
#[cfg(target_os = "windows")]
#[allow(clippy::needless_pass_by_value)]
pub fn restart_as_admin_cmd(app: tauri::AppHandle, enable_tun: bool) -> Result<(), String> {
    use tauri::Manager as _;

    if is_elevated() {
        return Err("already_elevated".to_owned());
    }
    if !has_linked_admin_token() {
        return Err("not_admin_user".to_owned());
    }

    let previous = enable_tun.then(|| {
        app.state::<crate::SettingsState>()
            .0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .tun_enabled
    });
    if enable_tun {
        crate::core_manager::core::tun_manager::sync_tun_settings(&app, true)
            .map_err(|e| format!("pref_save_failed: {e}"))?;
    }
    if let Err(err) = relaunch_elevated() {
        if let Some(previous) = previous {
            if let Err(e) = crate::commit_settings(&app, |s| s.tun_enabled = previous) {
                emit_warn!(
                    Config,
                    CONFIG_PERSIST_FAILED,
                    "Administrator relaunch did not happen, and restoring the TUN preference failed: {e}"
                );
            }
        }
        return Err(err);
    }

    // Same shutdown as the tray "Quit".
    if let Some(flag) = app.try_state::<crate::ExplicitExitFlag>() {
        flag.0.store(true, std::sync::atomic::Ordering::SeqCst);
    }
    let state = app.state::<crate::core_manager::MihomoState>();
    let _ = crate::core_manager::stop_core_inner(&app, &state);
    if let Err(e) = crate::sys_proxy::clear_sys_proxy(&app) {
        emit_warn!(
            System,
            SYS_PROXY_FAILED,
            "Failed to clear system proxy before relaunching: {e}"
        );
    }
    app.cleanup_before_exit();
    app.exit(0);
    Ok(())
}

/// Elevated relaunch exists only on Windows.
#[tauri::command]
#[cfg(not(target_os = "windows"))]
#[allow(clippy::needless_pass_by_value)]
pub fn restart_as_admin_cmd(_app: tauri::AppHandle, _enable_tun: bool) -> Result<(), String> {
    Err("unsupported".to_owned())
}

#[cfg(test)]
mod tests {
    use super::same_path_ignoring_case;
    use std::path::Path;

    #[test]
    fn same_executable_path_ignores_case_only() {
        assert!(same_path_ignoring_case(
            Path::new(r"C:\Program Files\Zephyr\Zephyr.exe"),
            Path::new(r"c:\program files\zephyr\zephyr.EXE"),
        ));
        assert!(!same_path_ignoring_case(
            Path::new(r"C:\Program Files\Zephyr\Zephyr.exe"),
            Path::new(r"C:\Windows\explorer.exe"),
        ));
    }
}
