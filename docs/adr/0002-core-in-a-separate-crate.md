# ADR-0002: Cluster work is moved into a crate without Tauri

## Context

A possible mobile version (G01) must reuse the logic, and we want to test the logic against a real cluster without a window.

## Decision

All cluster work lives in a separate crate, `sextant-core`, which does not depend on `tauri`. Anything that launches OS processes is hidden behind the `desktop` feature: the `helm` call lives in the core under this feature, the local PTY lives in the app. The app (`sextant`) consists of thin commands over the core and window state.

## Why

- The alternative was to keep everything in one app crate. It was rejected for two reasons: a mobile version would drag desktop dependencies along, and integration tests against kind would require a Tauri environment.
- The `desktop` feature is on by default because the main consumer is the desktop. A mobile build will turn it off explicitly.
- A verifiable condition: `cargo tree -p sextant-core --no-default-features` contains neither `tauri` nor `portable-pty`.

## Consequences

- Every operation exists twice: as a core function and as a thin app command. A new capability touches both places.
- Everything that has to know about window state (subscriptions, sessions) lives in the app's `AppState`, not in the core. The core cannot close by itself what it cannot see (ADR-0011).
- The specification places the PTY under the core's `desktop` feature, but the PTY actually ended up in the app. The G01 line is inaccurate on this point.
- "Readiness for a mobile version" is confirmed only by building the core without desktop dependencies. A mobile build was not tried.
