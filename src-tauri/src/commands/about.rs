//! What "About Sextant" shows about the machine, for "Copy version info" in a bug report: the operating system, its
//! version, the architecture, the WebView and Tauri versions. No paths and no user names: only what a maintainer needs
//! to reproduce a problem.

use serde::Serialize;
use sextant_core::CoreError;
use ts_rs::TS;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct AboutInfo {
    /// `Linux`, `macOS`, `Windows` (anything else as Rust names it).
    pub os: String,
    /// `x86_64`, `aarch64`, …
    pub arch: String,
    /// The release of the OS (a distribution and its version on Linux, `14.5` on macOS, `10.0.22631` on Windows);
    /// `None` when it cannot be read.
    pub os_version: Option<String>,
    /// The version of the system WebView that draws the window; `None` when it cannot be read.
    pub webview_version: Option<String>,
    pub tauri_version: String,
}

#[tauri::command]
pub async fn about_info() -> Result<AboutInfo, CoreError> {
    // The OS version may start a process (`sw_vers`, `cmd /C ver`): off the async runtime.
    let os_version = tauri::async_runtime::spawn_blocking(os_version)
        .await
        .ok()
        .flatten();
    Ok(AboutInfo {
        os: os_name(std::env::consts::OS),
        arch: std::env::consts::ARCH.to_string(),
        os_version,
        webview_version: tauri::webview_version()
            .ok()
            .map(|v| v.trim().to_string())
            .filter(|v| !v.is_empty()),
        tauri_version: tauri::VERSION.to_string(),
    })
}

/// The OS as people write it.
fn os_name(consts_os: &str) -> String {
    match consts_os {
        "linux" => "Linux",
        "macos" => "macOS",
        "windows" => "Windows",
        other => other,
    }
    .to_string()
}

#[cfg(target_os = "linux")]
fn os_version() -> Option<String> {
    let text = std::fs::read_to_string("/etc/os-release")
        .or_else(|_| std::fs::read_to_string("/usr/lib/os-release"))
        .ok()?;
    parse_os_release(&text)
}

#[cfg(target_os = "macos")]
fn os_version() -> Option<String> {
    // By absolute path: nothing is looked up through PATH.
    let out = std::process::Command::new("/usr/bin/sw_vers")
        .arg("-productVersion")
        .output()
        .ok()?;
    let text = String::from_utf8_lossy(&out.stdout).trim().to_string();
    (out.status.success() && !text.is_empty()).then_some(text)
}

#[cfg(target_os = "windows")]
fn os_version() -> Option<String> {
    use std::os::windows::process::CommandExt;
    /// `CREATE_NO_WINDOW`: the child must not flash a console window.
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    // By absolute path (`%SystemRoot%\System32\cmd.exe`): nothing is looked up through PATH. `ver` prints one line
    // and exits, so it cannot hang.
    let root = std::env::var_os("SystemRoot").unwrap_or_else(|| "C:\\Windows".into());
    let cmd = std::path::Path::new(&root).join("System32").join("cmd.exe");
    let out = std::process::Command::new(cmd)
        .args(["/C", "ver"])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .ok()?;
    parse_windows_ver(&String::from_utf8_lossy(&out.stdout))
}

#[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
fn os_version() -> Option<String> {
    None
}

/// `PRETTY_NAME` of an `os-release` file (`Ubuntu 24.04.1 LTS`), otherwise `NAME` + `VERSION_ID`.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn parse_os_release(text: &str) -> Option<String> {
    let value = |key: &str| {
        text.lines().find_map(|line| {
            let rest = line.trim().strip_prefix(key)?.strip_prefix('=')?;
            let rest = rest.trim().trim_matches(|c| c == '"' || c == '\'').trim();
            (!rest.is_empty()).then(|| rest.to_string())
        })
    };
    value("PRETTY_NAME").or_else(|| {
        let name = value("NAME")?;
        Some(match value("VERSION_ID") {
            Some(version) => format!("{name} {version}"),
            None => name,
        })
    })
}

/// `10.0.22631.3447` out of `Microsoft Windows [Version 10.0.22631.3447]` (the text is localized, the number is not).
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
fn parse_windows_ver(text: &str) -> Option<String> {
    let start = text.find(|c: char| c.is_ascii_digit())?;
    let number: String = text[start..]
        .chars()
        .take_while(|c| c.is_ascii_digit() || *c == '.')
        .collect();
    let number = number.trim_end_matches('.');
    number.contains('.').then(|| number.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_os_is_named_the_way_people_write_it() {
        assert_eq!(os_name("linux"), "Linux");
        assert_eq!(os_name("macos"), "macOS");
        assert_eq!(os_name("windows"), "Windows");
        assert_eq!(os_name("freebsd"), "freebsd");
    }

    #[test]
    fn os_release_gives_the_pretty_name() {
        let text = "NAME=\"Ubuntu\"\nVERSION_ID=\"24.04\"\nPRETTY_NAME=\"Ubuntu 24.04.1 LTS\"\nHOME_URL=\"https://x\"\n";
        assert_eq!(
            parse_os_release(text).as_deref(),
            Some("Ubuntu 24.04.1 LTS")
        );
    }

    #[test]
    fn os_release_without_a_pretty_name_falls_back_to_name_and_version() {
        assert_eq!(
            parse_os_release("NAME=Alpine\nVERSION_ID=3.20.1\n").as_deref(),
            Some("Alpine 3.20.1")
        );
        assert_eq!(
            parse_os_release("NAME='Arch Linux'\n").as_deref(),
            Some("Arch Linux")
        );
        assert_eq!(parse_os_release("ID=x\n"), None);
    }

    #[test]
    fn the_windows_version_is_the_number_out_of_ver() {
        assert_eq!(
            parse_windows_ver("\r\nMicrosoft Windows [Version 10.0.22631.3447]\r\n").as_deref(),
            Some("10.0.22631.3447")
        );
        assert_eq!(
            parse_windows_ver("Microsoft Windows [Версия 10.0.19045.4291]").as_deref(),
            Some("10.0.19045.4291")
        );
        assert_eq!(parse_windows_ver("nothing here"), None);
    }
}
