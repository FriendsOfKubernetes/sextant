# ADR-0131: Backend extensions are WebAssembly components run by wasmtime with no ambient access, reaching clusters through the extension guard and the network only at declared hosts

## Context

Issue #272. An extension today is a set of web pages in a sandboxed frame (ADR-0047). It has no network (ADR-0048) and reaches clusters only through Sextant's API, within the permissions the user granted (ADR-0050, ADR-0051). That is enough for views of a cluster's objects, but not for talking to the systems around a cluster: a vendor's API, an internal service, a cloud account, a ticket system. The issue asks for code that runs outside the window under the same permission model:
- declared capabilities;
- consent;
- the guard and the activity log;
- no secrets by default.

The ADR has to settle the process model (WebAssembly preferred), the sandbox, the resource limits and updates.

Things that make it hard:
- Whatever runs it is inside (or beside) the process that holds kubeconfigs, tokens, the MCP token and the keyring. An escape is the whole machine's Kubernetes access.
- Packages are third-party code, including from the catalog, which vouches for the publisher and not the code (ADR-0130).
- Sextant ships on Linux (x86_64, arm64), macOS and Windows from one build.

## Decision

### What a backend is

- An extension may have one **backend**: a WebAssembly component in its package, declared by the manifest's new `backend` object:
  - `module`: the package path of the `.wasm`;
  - `network.hosts`: a list of host names it may call over HTTPS, at most 20, no wildcards;
  - `credentials`: at most 10 named credentials, each with a label, which the user enters in Sextant.
- An extension without `backend` is exactly what it is today.
- The component implements a world that Sextant defines in WIT, `sextant:extension/backend@1.0.0`:
  - it exports `handle(method, params-json) -> result-json`;
  - it imports Sextant's interface `host`, whose `call(method, params)` reaches the extension API's methods as the frames call them (`clusters.list`, `kinds`, `resources.*` but `watch`, `logs.tail`, `secret.value`, `storage.*`) plus `credentials.get`, and whose `log` writes the backend's log;
  - it may import WASI 0.2, which Sextant links with nothing behind it: no environment, arguments or preopened directories, stdin closed, every socket address refused, stdout and stderr captured (capped) into the backend's log; clocks and random numbers work. A component built by `rustc` for `wasm32-wasip2` or by jco imports these whether or not it uses them;
  - `wasi:http/outgoing-handler` is linked too, but sends nothing itself: every request goes to Sextant's network policy below, so a TypeScript backend's `fetch()` and a Rust HTTP client work within it.
- A component that imports anything other than `wasi:*` and `sextant:extension/*` is refused at install, before consent, even when there would be nothing to link.
- The manifest's `sextantApi` stays 1. The world's version is the backend's contract: a newer major is an install refusal, as an unsupported `sextantApi` is.

### How it runs

- **Engine.** [wasmtime](https://wasmtime.dev), in a crate of its own: `crates/sextant-ext-runtime`, desktop only; the core does not depend on it.
  - The component is compiled once, at install, and the compiled form is cached under `<data>/extensions/<id>/<version>/`. A cache that this wasmtime cannot load is compiled again.
  - Each call instantiates the compiled component in a fresh store, so no memory or table survives between calls: what a backend keeps, it keeps in `storage`.
- **Who calls it.** Only the extension's own frames, through a new method `backend.call(method, params)` of the extension API (a `REMOTE_METHODS` entry). The host forwards it to Rust like every remote method (ADR-0051).
  - Neither agents nor other extensions can call a backend, and a backend is not an MCP tool.
  - A backend runs only while its extension is enabled and active, and only while a frame of it is open, plus 60 seconds after the last one closes. It has no timers or background work of its own.
- **Limits per call:**

  | What | Limit |
  |---|---|
  | Wall time, enforced by epoch interruption | 10 s |
  | Memory | 64 MiB linear memory |
  | Table elements | 10 000 |
  | Instances | 1 per call |
  | Parameters and result | 1 MiB of JSON each |
  | Concurrent calls per extension | 4; the next ones are refused, not queued |
  | Component size | 16 MiB |

  A call that traps, runs out of time or out of memory is an error to its frame. Three such failures in a row pause the backend until the user reloads the extension.

### What it may reach

- **Clusters.** Only through the `cluster` interface, which is the extension API's resource methods with the same checks. Rust decides each object by the extension's granted rules, right before the side effect (ADR-0051):
  - confirmations for its `confirm` rules, shown as "Extension <name>";
  - node-shell pods refused (ADR-0056);
  - Secret values only with `secretValues`;
  - inline secret fields hidden (ADR-0120 amendments);
  - `apply` checked on the parsed documents (ADR-0057).

  There is no second permission vocabulary. The frame and its backend share one grant.
- **The network.** Only `wasi:http` requests to a declared host:
  - HTTPS on port 443, no credentials in the URL, a redirect only to a declared host;
  - never a loopback, link-local, private, metadata or carrier-grade NAT address. This is checked on every resolved address by a filtering resolver, as for image registries (ADR-0103), so DNS cannot point a declared name inside;
  - at most 8 MiB per response and 30 s per request;
  - no cookies, and no proxy settings taken from the environment.

  An in-cluster Service is reached through the cluster interface, not the network; a Service proxy method is left for a later decision.
- **Credentials.** The user enters them in Settings → Extensions, in the extension's row, in a host form that is not a frame. They are kept in the OS keyring as `sextant-ext:<id>:<credential>`:
  - readable only by that extension's backend, through `credentials.get`;
  - never sent to a frame, a log, the activity log or an error;
  - removed with the extension.

  With no credentials declared there is nothing to read: "no secrets by default".
- **Nothing else.** No files, no kubeconfig, no other extension's data, no environment, no processes.

### Consent, guard, activity

- **The consent screen** shows a backend in its own block:
  - "Runs its own code outside the window";
  - each host it may call;
  - each credential it asks for.
- **Updates.** An update counts as asking for more when it adds a backend, a host or a credential. Then it brings consent back, as a wider grant does (ADR-0050). A development folder that does so is paused.
- **Activity log.** Every backend call and every cluster and HTTP request it makes are written to `extensions-audit.jsonl`, under the extension's principal:
  - for a request: host, method, status, size and duration;
  - never a body, a query string or a credential.
- **The catalog's entries** show "has a backend" and its hosts, copied by its workflow like the permissions.

### For authors

- Two languages are supported, each with an example that is also the template to copy, built and run in Sextant's runtime by `npm run sdk:check` (`cargo run -p sextant-ext-runtime --example run`, a stand-in host):
  - **TypeScript**, built with componentize-js (the StarlingMonkey engine pre-initialized into the component; an exact dev dependency of Sextant), so the author of a frame writes its backend in the same language. A component is about 12 MB, within the 16 MiB limit; `fetch` works within the network policy. `@sextant/extension-sdk/backend` gives `defineBackend` (JSON in and out, every error turned into the message a call fails with) and a typed `host`.
  - **Rust**, built by `cargo build --target wasm32-wasip2` with wit-bindgen (and wstd for HTTP), for a small (about 0.3 MB) and fast backend.
- `sdk:build` sees which one a project has and runs the right tool.
- The SDK ships the WIT (`sdk/wit/sextant-extension.wit`) and two examples: `sdk/examples/backend-ts` and `sdk/examples/backend-rust` count the clusters they may see through `host` and ask api.github.com (the one declared host) for Sextant's latest release, with an optional GitHub token as a credential.
- Go through TinyGo compiles to the same WIT and is documented as working without guarantees: TinyGo's standard library is partial, and HTTP goes through `wasi:http` (no `net/http` sockets). Other languages that build components (C and C++ through wasi-sdk) work through the WIT on the same terms.
- Python (componentize-py) is not supported. Its component bundles CPython at 20–40 MB, over the limits, and it starts slowly in a fresh store per call. Supporting it would need larger limits and long-lived instances, which is a separate decision.

## Why

- **WebAssembly with no ambient authority.** The component can do only what Sextant links in: extension-API calls, HTTP through Sextant's policy, and WASI with nothing behind it. Its memory is bounds-checked and separate from the process.
- **wasmtime.** It is written in Rust, fuzzed continuously and has a security process. It implements the component model and WIT, so the boundary is typed and every host call is one checked function. It has epoch interruption and a resource limiter for time and memory.

  The rejected engines:
  - wasmi (a small interpreter): it has no component model, so the boundary would be hand-written memory passing;
  - wasmer: it has a smaller component-model story and the same JIT;
  - an embedded JavaScript engine (QuickJS, rquickjs): the language authors already write, but a C engine whose bugs are escapes, with no component boundary.
- **No native sidecar process.** It would need a per-OS sandbox Sextant does not have:
  - seccomp/Landlock on Linux;
  - an App Sandbox profile on macOS, which needs signing;
  - AppContainer on Windows.

  Native code could also do anything the user can until those exist, and every package would carry one binary per platform.
- **Calls only from its own frames, and only while one is open.** The backend can be bounded and explained: it works when you use it. Background work (polling an API to notify, say) needs its own decision about what runs unseen and how the user stops it.
- **One grant for frame and backend.** The user reads one set of permissions. A backend never widens what the extension may do in a cluster, only adds the network and credentials, which the consent screen names one by one.
- **Declared hosts, checked on every resolved address.** A declared host is something a user can judge ("api.pagerduty.com"). Resolver checks close the DNS rebinding hole that a name check alone leaves, as ADR-0103 found for registries.
- **Credentials in the keyring, entered in host UI.** A token typed into a frame would pass through extension code that does not need to see it again. The keyring is where Sextant already keeps Argo CD logins.

## Consequences

- **Size and build.** wasmtime adds about 10 to 15 MB to the binary and noticeably to build times. The runtime is its own crate, so the core and its tests do not pay for it.
- **macOS JIT.** wasmtime's Cranelift JIT needs writable-then-executable memory. Sextant is not notarized with the hardened runtime today; if it ever is, it needs the `allow-jit` entitlement, or wasmtime's Pulley interpreter at a speed cost.
- **Compiled-code cache.** It is per wasmtime version: an app update recompiles installed backends on first use.
- **Two toolchains in CI.** TypeScript backends are large (the JS engine travels in every component), and their CI builds need jco. Rust backends need a Rust toolchain with the `wasm32-wasip2` target. Both are SDK checks; the app does not care which language a component came from.
- **Separate decisions later:** an in-cluster Service proxy for backends, background work, and streaming from a backend (beyond one call, one answer).
- **New pieces:** the `backend` manifest object and its schema, hosts and credentials in the consent and in "asks for more", the runtime crate, `backend.call` in both protocol files, the credentials form and keyring entries, the catalog's "has a backend", and the SDK's WIT, TypeScript types, templates and two examples. Window only, as all extension methods are, and a test keeps backends out of the MCP tools.
- ADR-0047's "no backend extensions" now means "no native backend code": that ADR gets an amendment.
