//! Tauri implementation of `CoreEventCallback` — bridges core events to Tauri's event system.

use std::sync::Arc;
use zephyr_core::event::{CoreEvent, CoreEventCallback, EventLevel, EventModule};

/// Tauri-specific implementation of `CoreEventCallback`.
///
/// Converts `CoreEvent` from the core crate into `BackendEvent` used by
/// the existing Tauri event pipeline, then forwards through `emit_backend_event()`.
pub struct TauriEventCallback;

impl CoreEventCallback for TauriEventCallback {
    fn on_event(&self, event: CoreEvent) {
        let redacted_message = crate::backend_event::redact_error_message(&event.message);

        let backend_event = match &event.level {
            EventLevel::Fatal => crate::backend_event::BackendEvent::fatal(
                convert_module(&event.module),
                event.code,
                &redacted_message,
            ),
            EventLevel::Error => crate::backend_event::BackendEvent::error(
                convert_module(&event.module),
                event.code,
                &redacted_message,
            ),
            EventLevel::Warn => crate::backend_event::BackendEvent::warn(
                convert_module(&event.module),
                event.code,
                &redacted_message,
            ),
            EventLevel::Info => crate::backend_event::BackendEvent::info(
                convert_module(&event.module),
                event.code,
                &redacted_message,
            ),
        };

        crate::backend_event::emit_backend_event(&backend_event);
    }
}

/// Install the Tauri event callback as the global dispatcher for core events.
/// Call once during app setup, after `init_app_handle()`.
pub fn install_core_event_bridge() {
    zephyr_core::event::init_event_dispatcher(Arc::new(TauriEventCallback));
}

const fn convert_module(module: &EventModule) -> crate::backend_event::BackendModule {
    match module {
        EventModule::Core => crate::backend_event::BackendModule::Core,
        EventModule::Subscription => crate::backend_event::BackendModule::Subscription,
        EventModule::Prism => crate::backend_event::BackendModule::Prism,
        EventModule::Config => crate::backend_event::BackendModule::Config,
        EventModule::Plugin => crate::backend_event::BackendModule::Plugin,
        EventModule::System => crate::backend_event::BackendModule::System,
        EventModule::Updater => crate::backend_event::BackendModule::Updater,
        EventModule::Override => crate::backend_event::BackendModule::Override,
        EventModule::Rule => crate::backend_event::BackendModule::Rule,
        EventModule::Smart => crate::backend_event::BackendModule::Smart,
    }
}
