//! How much memory this process holds, for the counters line of Sextant's log (#342, ADR-0170). Cheap enough to be
//! read every few minutes: one system call on Windows, one small file of `/proc` on Linux. Elsewhere (macOS) nothing
//! is read and the line says the memory is unknown.

/// The process's memory as the system counts it: `(name, bytes)` pairs, in the order they are written. Empty where
/// it is not read (or the read failed).
///
/// - Windows: `workingSet` (the pages in RAM, what Task Manager shows) and `private` (the commit charge: private
///   bytes, what an allocation failure is measured against).
/// - Linux: `rss` (`VmRSS`) and `data` (`VmData`: the heap and other private mappings) from `/proc/self/status`.
pub fn sample() -> Vec<(&'static str, u64)> {
    imp::sample()
}

#[cfg(windows)]
mod imp {
    use windows_sys::Win32::System::ProcessStatus::{
        GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS, PROCESS_MEMORY_COUNTERS_EX,
    };
    use windows_sys::Win32::System::Threading::GetCurrentProcess;

    pub fn sample() -> Vec<(&'static str, u64)> {
        // SAFETY: `counters` is a properly sized, zeroed PROCESS_MEMORY_COUNTERS_EX whose size is passed as `cb`,
        // which GetProcessMemoryInfo accepts in place of PROCESS_MEMORY_COUNTERS; the pseudo handle of the current
        // process needs no closing.
        let mut counters: PROCESS_MEMORY_COUNTERS_EX = unsafe { std::mem::zeroed() };
        let size = std::mem::size_of::<PROCESS_MEMORY_COUNTERS_EX>() as u32;
        counters.cb = size;
        let ok = unsafe {
            GetProcessMemoryInfo(
                GetCurrentProcess(),
                (&raw mut counters).cast::<PROCESS_MEMORY_COUNTERS>(),
                size,
            )
        };
        if ok == 0 {
            return Vec::new();
        }
        vec![
            ("workingSet", counters.WorkingSetSize as u64),
            ("private", counters.PrivateUsage as u64),
        ]
    }
}

#[cfg(target_os = "linux")]
mod imp {
    pub fn sample() -> Vec<(&'static str, u64)> {
        std::fs::read_to_string("/proc/self/status")
            .map(|status| super::from_status(&status))
            .unwrap_or_default()
    }
}

#[cfg(not(any(windows, target_os = "linux")))]
mod imp {
    pub fn sample() -> Vec<(&'static str, u64)> {
        Vec::new()
    }
}

/// `VmRSS` and `VmData` of a `/proc/<pid>/status` text (kB there), in bytes.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn from_status(status: &str) -> Vec<(&'static str, u64)> {
    let field = |name: &str| {
        status.lines().find_map(|line| {
            let rest = line.strip_prefix(name)?.strip_prefix(':')?;
            let kb: u64 = rest.trim().strip_suffix("kB")?.trim().parse().ok()?;
            Some(kb.saturating_mul(1024))
        })
    };
    [("rss", field("VmRSS")), ("data", field("VmData"))]
        .into_iter()
        .filter_map(|(name, bytes)| Some((name, bytes?)))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_rss_and_data_from_a_status_file() {
        let status = "Name:\tsextant\nVmPeak:\t 900000 kB\nVmData:\t  204800 kB\nVmRSS:\t  102400 kB\nThreads:\t42\n";
        assert_eq!(
            from_status(status),
            [("rss", 100 * 1024 * 1024), ("data", 200 * 1024 * 1024)]
        );
        assert!(from_status("Name:\tx\n").is_empty());
    }

    #[cfg(any(windows, target_os = "linux"))]
    #[test]
    fn this_process_has_some_memory() {
        let sample = sample();
        assert_eq!(sample.len(), 2, "{sample:?}");
        assert!(sample.iter().all(|(_, bytes)| *bytes > 0), "{sample:?}");
    }
}
