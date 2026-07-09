//! `WebView2` crash detection and auto-recovery.
//!
//! ## Architecture
//!
//! This module implements **Layer 1** of the crash recovery strategy:
//! event-driven detection via `WebView2`'s native `ProcessFailed` callback.
//!
//! When the `WebView2` browser process or render process crashes, the Win32
//! window (HWND) stays alive but has no content to render. Combined with
//! `transparent: true`, this creates an invisible "zombie window" that the
//! user cannot see or interact with.
//!
//! ## How it works
//!
//! 1. After the webview is created (or recreated), `arm_crash_recovery` is
//!    called via `on_page_load` to register a `ProcessFailed` event handler.
//! 2. When a crash occurs, the handler inspects `ProcessFailedKind`:
//!    - `RenderProcessExited` → `reload()` (`WebView2` auto-spawns a new render
//!      process; this is near-instant and invisible to the user).
//!    - `RenderProcessUnresponsive` → count occurrences; after 3 consecutive
//!      unresponsive events, force a `reload()` to avoid spinning.
//!    - `BrowserProcessExited` → the controller is dead; destroy the window
//!      and recreate it from scratch via `recreate_main_window`.
//! 3. After recreation, `on_page_load` fires again and re-arms the handler.
//!
//! ## Platform scope
//!
//! This module is Windows-only (`#[cfg(target_os = "windows")]`).
//! On macOS/Linux, the heartbeat mechanism in `lib.rs` (Layer 2) provides
//! the equivalent fallback.
//!
//! ## Version pinning
//!
//! `webview2-com` and `webview2-com-sys` are transitive dependencies via
//! `tauri → wry → webview2-com`. They MUST be declared as direct dependencies
//! with the **exact same version** found in `Cargo.lock` to avoid COM type
//! incompatibility. When upgrading Tauri, re-check `Cargo.lock` for the new
//! `webview2-com` version and update the direct dependency accordingly.

#![cfg(target_os = "windows")]

use std::sync::atomic::{AtomicU32, Ordering};

use tauri::{AppHandle, Manager as _, WebviewWindow};
use webview2_com::Microsoft::Web::WebView2::Win32::{
    COREWEBVIEW2_PROCESS_FAILED_KIND, COREWEBVIEW2_PROCESS_FAILED_KIND_BROWSER_PROCESS_EXITED,
    COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_EXITED,
    COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_UNRESPONSIVE,
};
use webview2_com::ProcessFailedEventHandler;

/// Consecutive `RenderProcessUnresponsive` count.
/// Reset to 0 on any other event (exit or reload).
static UNRESPONSIVE_COUNT: AtomicU32 = AtomicU32::new(0);

/// Threshold: after this many consecutive unresponsive events, force reload.
const UNRESPONSIVE_THRESHOLD: u32 = 3;

/// Register the `ProcessFailed` callback on the webview's `CoreWebView2`.
///
/// Must be called after the webview controller is ready (i.e. inside
/// `on_page_load` with `PageLoadEvent::Finished`). Both initial creation
/// and `recreate_main_window` paths flow through `on_page_load`, so the
/// handler is always re-armed after a recreation.
///
/// # Errors
/// Returns an error if the controller or `CoreWebView2` cannot be obtained.
pub fn arm_crash_recovery(window: &WebviewWindow) -> tauri::Result<()> {
    let app = window.app_handle().clone();

    window.with_webview(move |wv| {
        let controller = wv.controller();
        // SAFETY: `CoreWebView2()` is a COM getter that returns a
        // reference-counted interface. The controller is valid for the
        // lifetime of the webview. No raw pointers are stored.
        let core = match unsafe { controller.CoreWebView2() } {
            Ok(c) => c,
            Err(e) => {
                eprintln!("[webview_recovery] Failed to get CoreWebView2: {e}");
                return;
            }
        };

        let handler = ProcessFailedEventHandler::create(Box::new(move |_, args| {
            handle_process_failed(&app, args.as_ref());
            Ok(())
        }));

        let mut token: i64 = 0;
        // SAFETY: `add_ProcessFailed` is a standard COM method that stores
        // the handler and returns an event token. The handler (a COM object
        // created by `ProcessFailedEventHandler::create`) is reference-counted
        // by the COM runtime and kept alive as long as it is registered.
        if let Err(e) = unsafe { core.add_ProcessFailed(&handler, &mut token) } {
            eprintln!("[webview_recovery] add_ProcessFailed failed: {e}");
        }
    })?;
    Ok(())
}

/// Dispatch recovery action based on the process failure kind.
fn handle_process_failed(
    app: &AppHandle,
    event_args: Option<
        &webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2ProcessFailedEventArgs,
    >,
) {
    let Some(a) = event_args else {
        eprintln!("[webview_recovery] ProcessFailed but no event args");
        return;
    };

    let mut raw_kind = COREWEBVIEW2_PROCESS_FAILED_KIND::default();
    // SAFETY: `ProcessFailedKind` is a simple getter that writes an i32
    // enum value into the output pointer. No lifetime concerns.
    if let Err(e) = unsafe { a.ProcessFailedKind(&mut raw_kind) } {
        eprintln!("[webview_recovery] ProcessFailed but could not read kind: {e}");
        return;
    }

    if raw_kind == COREWEBVIEW2_PROCESS_FAILED_KIND_BROWSER_PROCESS_EXITED {
        eprintln!("[webview_recovery] Browser process exited — recreating window");
        UNRESPONSIVE_COUNT.store(0, Ordering::Relaxed);
        recreate_window(app);
    } else if raw_kind == COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_EXITED {
        eprintln!("[webview_recovery] Render process exited — reloading");
        UNRESPONSIVE_COUNT.store(0, Ordering::Relaxed);
        reload_webview(app);
    } else if raw_kind == COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_UNRESPONSIVE {
        let count = UNRESPONSIVE_COUNT.fetch_add(1, Ordering::Relaxed) + 1;
        eprintln!(
            "[webview_recovery] Render process unresponsive ({count}/{UNRESPONSIVE_THRESHOLD})"
        );
        if count >= UNRESPONSIVE_THRESHOLD {
            eprintln!("[webview_recovery] Unresponsive threshold reached — force reloading");
            UNRESPONSIVE_COUNT.store(0, Ordering::Relaxed);
            reload_webview(app);
        }
    } else {
        eprintln!(
            "[webview_recovery] ProcessFailed kind: {raw_kind:?} — no action needed (auto-recovered)"
        );
        UNRESPONSIVE_COUNT.store(0, Ordering::Relaxed);
    }
}

/// Reload the webview content. `WebView2` will spawn a new render process.
fn reload_webview(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        // `eval` with `location.reload()` forces a full page reload.
        // The `WebView2` controller stays alive; only the render process is replaced.
        if let Err(e) = window.eval("location.reload()") {
            eprintln!("[webview_recovery] reload eval failed: {e}");
        }
    }
}

/// Destroy the zombie window and recreate it from scratch.
///
/// Deferred to the main event-loop thread via `run_on_main_thread` because
/// calling `window.destroy()` directly from within the `ProcessFailed` COM
/// callback would destroy the `WebView2` controller while its own callback
/// is still on the call stack — a use-after-free that crashes the process.
///
/// Uses the same reconstruction gate as `show_or_recreate_main_window`
/// to prevent double-recreation when both Layer 1 and Layer 2 fire
/// simultaneously.
fn recreate_window(app: &AppHandle) {
    let cloned = app.clone();
    let _ = app.run_on_main_thread(move || {
        if !crate::try_acquire_reconstruct_gate(&cloned) {
            eprintln!("[webview_recovery] Reconstruction already in progress — skipping");
            return;
        }
        if let Some(window) = cloned.get_webview_window("main") {
            // Destroy the old window (and its dead controller).
            let _ = window.destroy();
        }
        // Recreate. The `on_page_load` callback in `lib.rs` will re-arm
        // crash recovery once the new webview finishes loading.
        if let Err(e) = crate::recreate_main_window(&cloned) {
            eprintln!("[webview_recovery] recreate_main_window failed: {e}");
            crate::emit_error!(
                System,
                SYS_WINDOW_RECREATE_FAILED,
                "WebView2 crash recovery: failed to recreate window: {e}"
            );
        }
        crate::release_reconstruct_gate(&cloned);
    });
}
