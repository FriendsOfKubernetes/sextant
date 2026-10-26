//! WebKitGTK draws through its DMA-BUF renderer by default since 2.42, and that renderer needs GBM. NVIDIA's
//! proprietary driver has GBM only from 495 on, and older GPUs (Kepler and earlier) are stuck on the 470 legacy
//! branch, so there the window stays empty ("Failed to create GBM buffer", #278). On such a driver Sextant turns the
//! renderer off as `WEBKIT_DISABLE_DMABUF_RENDERER=1` would, unless the user has set the variable themselves.

/// The first NVIDIA driver with GBM support.
#[cfg(target_os = "linux")]
const FIRST_GBM_DRIVER: u32 = 495;

/// Where the loaded NVIDIA kernel module tells its version: the plain version, then the `NVRM version:` line.
#[cfg(target_os = "linux")]
const VERSION_FILES: [&str; 2] = ["/sys/module/nvidia/version", "/proc/driver/nvidia/version"];

/// Disables WebKitGTK's DMA-BUF renderer when the loaded NVIDIA driver is older than 495 and
/// `WEBKIT_DISABLE_DMABUF_RENDERER` is not set. Call in `main` before any thread starts. Returns whether it did;
/// a no-op (false) elsewhere than Linux.
pub fn disable_dmabuf_on_old_nvidia() -> bool {
    #[cfg(target_os = "linux")]
    {
        const VAR: &str = "WEBKIT_DISABLE_DMABUF_RENDERER";
        if std::env::var_os(VAR).is_some() {
            return false;
        }
        let major = VERSION_FILES.iter().find_map(|path| {
            std::fs::read_to_string(path)
                .ok()
                .and_then(|text| nvidia_major(&text))
        });
        if !major.is_some_and(|major| major < FIRST_GBM_DRIVER) {
            return false;
        }
        // SAFETY: called first thing in `main`, before any other thread exists to read the environment.
        unsafe { std::env::set_var(VAR, "1") };
        true
    }
    #[cfg(not(target_os = "linux"))]
    {
        false
    }
}

/// The driver's major version from either version file: `470.256.02`, or the first version after `Kernel Module`
/// in the `NVRM version:` line (`Kernel Module  470.256.02`, `Open Kernel Module for x86_64  560.35.03`).
#[cfg(target_os = "linux")]
fn nvidia_major(text: &str) -> Option<u32> {
    let rest = match text.find("Kernel Module") {
        Some(at) => &text[at + "Kernel Module".len()..],
        None => text,
    };
    let line = rest.lines().next()?;
    line.split_whitespace().find_map(|word| {
        word.split_once('.')
            .and_then(|(major, _)| major.parse().ok())
    })
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::*;

    #[test]
    fn the_major_version_is_read_from_both_files() {
        assert_eq!(nvidia_major("470.256.02\n"), Some(470));
        assert_eq!(nvidia_major("580.178.04"), Some(580));
        let proc = "NVRM version: NVIDIA UNIX x86_64 Kernel Module  470.256.02  Thu May 11 2024\n\
                    GCC version:  gcc version 13.2.0 (Ubuntu 13.2.0-23ubuntu4)\n";
        assert_eq!(nvidia_major(proc), Some(470));
        let open =
            "NVRM version: NVIDIA UNIX Open Kernel Module for x86_64  560.35.03  Release Build\n";
        assert_eq!(nvidia_major(open), Some(560));
    }

    #[test]
    fn anything_else_is_no_version() {
        assert_eq!(nvidia_major(""), None);
        assert_eq!(nvidia_major("unknown"), None);
        assert_eq!(nvidia_major("x.1"), None);
    }
}
