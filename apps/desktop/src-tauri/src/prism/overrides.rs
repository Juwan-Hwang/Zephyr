//! Override System — Persistent override scripts that modify Mihomo config.
//!
//! Storage layout:
//! ```text
//! {app_data}/
//!   prism/           # already managed by prism.rs
//!     overrides/
//!       meta.json         # OverrideItem array (sorted by order)
//!       {id}.js           # JS override content
//!       {id}.prism.yaml  # Prism YAML override content
//!       {id}.log.json    # Last execution log
//! ```
//!
//! Design principles:
//! - Default global: new overrides apply to ALL subscriptions automatically
//! - JS overrides are executed via `execute_with_write` (`QuickJS` sandbox)
//! - Prism YAML overrides are handled by the existing `prism_apply` pipeline
//! - Fault-tolerant: a single override failure does NOT abort the pipeline

mod overrides_model;
mod overrides_store;

pub use overrides_model::*;
pub use overrides_store::*;

// Include commands directly to ensure #[tauri::command] macros are processed correctly
#[path = "overrides_commands.rs"]
mod commands_impl;
pub use commands_impl::*;
