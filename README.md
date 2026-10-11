# Sextant

Sextant is a desktop application for managing Kubernetes clusters — an alternative to Lens, written in Rust
on [Tauri 2](https://tauri.app). It reads your kubeconfig, shows the resources of every cluster in live tables,
and lets you inspect, edit and operate them: logs, shells in containers, a local terminal bound to the cluster,
port forwarding, CPU/memory metrics and Helm releases.

The window follows the familiar layout: clusters on the left, a section tree, the resource table in the center,
a details panel that slides in from the right and a dock with tabs at the bottom. Light, dark and system themes.
The interface is in English; every string comes from translation files, so more languages can be added.

> Status: under active development. Builds for Linux, macOS and Windows; installers are not signed.

## Repository layout

| Path | What |
|---|---|
| `crates/sextant-core` | Everything about clusters (kube-rs). No Tauri dependency, so it can back a mobile app later. |
| `src-tauri` | The desktop application (crate `sextant`): Tauri commands, events, local terminal. |
| `src` | The interface: React + TypeScript + Vite. `src/api` is the only bridge to the backend. |
| `src/locales/<lang>/<namespace>.json` | Translations. A new language is a new directory. |
| `scripts/test-cluster.sh` | A local kind cluster with test fixtures for development and integration tests. |

## Building from source

Requirements:

- Rust (stable, 1.90 or newer) — <https://rustup.rs>
- Node.js 22+ with npm
- The Tauri system dependencies for your OS — <https://tauri.app/start/prerequisites/>
  (on Debian/Ubuntu: `libwebkit2gtk-4.1-dev`, `libgtk-3-dev`, `libayatana-appindicator3-dev`, `librsvg2-dev`,
  `build-essential`, `curl`, `wget`, `file`, `libssl-dev`, `libxdo-dev`)

```sh
npm install
npm run tauri dev      # run in development mode
npm run tauri build    # build installers into target/release/bundle/
```

On Linux `npm run tauri build` produces `.deb`, `.rpm` and `.AppImage` packages; on macOS `.app`/`.dmg`;
on Windows `.msi` and an NSIS installer.

Optional tools used by some features: `kubectl` (in the local terminal) and `helm` (installing and changing
Helm releases; viewing releases works without it).

### Unsigned installers

Installers are not code-signed.

- **macOS:** after moving Sextant to Applications, right-click it and choose **Open** (once), or run
  `xattr -dr com.apple.quarantine /Applications/Sextant.app`.
- **Windows:** SmartScreen may warn about an unknown publisher — choose **More info → Run anyway**.

## Development

```sh
npm run check        # everything: rustfmt, clippy, cargo tests, TS bindings, tsc, eslint, vitest
npm run gen:types    # regenerate src/api/generated from the Rust types (ts-rs)
npx vitest run src/layout     # one group of frontend tests
cargo test -p sextant-core    # core unit tests
```

### Test cluster

Integration tests of the core run against a local [kind](https://kind.sigs.k8s.io) cluster and are skipped
when `SEXTANT_TEST_KUBECONFIG` is not set.

```sh
scripts/test-cluster.sh up                 # kind cluster "sextant-test" + metrics-server + fixtures
scripts/test-cluster.sh kubeconfig         # path to its admin kubeconfig
scripts/test-cluster.sh kubeconfig limited # kubeconfig of a ServiceAccount that cannot read Secrets
SEXTANT_TEST_KUBECONFIG=$(scripts/test-cluster.sh kubeconfig) \
  cargo test -p sextant-core --tests -- --test-threads=1
scripts/test-cluster.sh down
```

The script keeps your `~/.kube/config` untouched; its files live in `~/.cache/sextant-test`.

## License

Licensed under either of

- Apache License, Version 2.0 ([LICENSE-APACHE](LICENSE-APACHE))
- MIT license ([LICENSE-MIT](LICENSE-MIT))

at your option.
