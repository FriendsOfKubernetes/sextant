//! glibc's allocator gives each thread that allocates its own arena, up to eight per CPU core, and an arena keeps the
//! memory it once grew to. With Tokio's worker and blocking threads that is a lot of arenas: after a large batch (a
//! watch of hundreds of objects, a list of big CRDs) the freed memory stays spread over them. Measured on 500 extra
//! pods and 150 CRDs: +35 MB with the default, +19 MB with two arenas (#170). Two arenas are enough for a desktop
//! client; allocation is not its bottleneck.

/// Arenas when the user has not chosen a number (`MALLOC_ARENA_MAX`).
#[cfg(all(target_os = "linux", target_env = "gnu"))]
const ARENAS: libc::c_int = 2;

/// Caps glibc's malloc arenas, unless `MALLOC_ARENA_MAX` is set. Call first thing in `main`, before any thread
/// starts. Returns whether the cap was applied; a no-op (false) elsewhere than glibc on Linux.
pub fn limit_arenas() -> bool {
    #[cfg(all(target_os = "linux", target_env = "gnu"))]
    {
        if std::env::var_os("MALLOC_ARENA_MAX").is_some() {
            return false;
        }
        // SAFETY: mallopt only sets an allocator parameter; it returns 1 on success.
        unsafe { libc::mallopt(libc::M_ARENA_MAX, ARENAS) == 1 }
    }
    #[cfg(not(all(target_os = "linux", target_env = "gnu")))]
    {
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_arena_cap_applies_on_glibc_and_is_a_no_op_elsewhere() {
        let applied = limit_arenas();
        if cfg!(all(target_os = "linux", target_env = "gnu"))
            && std::env::var_os("MALLOC_ARENA_MAX").is_none()
        {
            assert!(applied);
        } else {
            assert!(!applied);
        }
    }
}
