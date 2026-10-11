/// tauri-build's default Windows manifest: Common Controls v6, without which `TaskDialogIndirect`
/// is missing and the process dies at load time with `STATUS_ENTRYPOINT_NOT_FOUND`.
const WINDOWS_MANIFEST: &str = r#"<assembly xmlns="urn:schemas-microsoft-com:asm.v1" manifestVersion="1.0">
  <dependency>
    <dependentAssembly>
      <assemblyIdentity
        type="win32"
        name="Microsoft.Windows.Common-Controls"
        version="6.0.0.0"
        processorArchitecture="*"
        publicKeyToken="6595b64144ccf1df"
        language="*"
      />
    </dependentAssembly>
  </dependency>
</assembly>
"#;

fn main() {
    let target_os = std::env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
    let target_env = std::env::var("CARGO_CFG_TARGET_ENV").unwrap_or_default();
    if target_os != "windows" || target_env != "msvc" {
        tauri_build::build();
        return;
    }

    // tauri-build links the manifest into the app binary only (`rustc-link-arg-bins`), so the
    // unit/integration test executables start without it. Embed it through the linker for every
    // linked target instead — the same workaround tauri uses for its own tests (tauri/build.rs,
    // https://github.com/tauri-apps/tauri/pull/4383#issuecomment-1212221864) — and leave it out of
    // tauri-build's resource so the app does not get two manifests.
    let manifest = std::path::Path::new(&std::env::var("OUT_DIR").unwrap()).join("app.manifest");
    std::fs::write(&manifest, WINDOWS_MANIFEST).expect("write the Windows manifest");
    println!("cargo:rustc-link-arg=/MANIFEST:EMBED");
    println!("cargo:rustc-link-arg=/MANIFESTINPUT:{}", manifest.display());

    let windows = tauri_build::WindowsAttributes::new_without_app_manifest();
    tauri_build::try_build(tauri_build::Attributes::new().windows_attributes(windows))
        .expect("tauri-build failed");
}
