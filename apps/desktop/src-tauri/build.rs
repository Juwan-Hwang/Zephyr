use std::path::PathBuf;

fn main() {
    let windows_msvc = std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows")
        && std::env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("msvc");

    if !windows_msvc {
        tauri_build::build();
        return;
    }

    // tauri-build embeds its app manifest (Common Controls v6) as a resource
    // that is linked into binaries only, so the lib's unit-test binary gets
    // none and aborts at load time with STATUS_ENTRYPOINT_NOT_FOUND
    // (0xc0000139). Let the MSVC linker embed the same manifest into every
    // linked target instead: `rustc-link-arg-tests` would not reach the lib's
    // unit tests (it only covers `tests/` targets), and tauri-build's own
    // manifest is turned off so the app does not get it twice (CVT1100
    // duplicate resource).
    let manifest =
        PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap_or_else(|_| ".".to_owned()))
            .join("windows-app-manifest.xml");
    println!("cargo:rerun-if-changed={}", manifest.display());
    println!("cargo:rustc-link-arg=/MANIFEST:EMBED");
    println!("cargo:rustc-link-arg=/MANIFESTINPUT:{}", manifest.display());

    let windows = tauri_build::WindowsAttributes::new_without_app_manifest();
    if let Err(error) =
        tauri_build::try_build(tauri_build::Attributes::new().windows_attributes(windows))
    {
        println!("cargo:warning=tauri-build failed: {error:#}");
        std::process::exit(1);
    }
}
