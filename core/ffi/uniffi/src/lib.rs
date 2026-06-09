// UniFFI cdylib for mobile platforms (Android/iOS).
//
// This crate builds as cdylib/staticlib and provides the FFI bridge.
// All business logic and UniFFI scaffolding live in `zephyr-core`
// (with `uniffi` feature enabled). This crate just links them into
// a shared library that uniffi-bindgen can consume.
//
// Adding a new platform? Create a new crate under core/ffi/ that depends
// on zephyr-core and uses the appropriate FFI framework.

// Re-export everything from zephyr-core so the linker includes
// the FFI scaffolding symbols in the final shared library.
pub use zephyr_core::*;
