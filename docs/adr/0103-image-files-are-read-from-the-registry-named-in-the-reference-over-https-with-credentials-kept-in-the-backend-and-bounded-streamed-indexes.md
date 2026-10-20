# ADR-0103: Image files are read from the registry named in the reference, over HTTPS, with credentials kept in the backend and bounded, streamed indexes

## Context

#216 asks to browse the files of a container image straight from its registry: no `exec` into a running container, no pull on a node, no local `docker`. Until now every download Sextant made went through `src-tauri/src/download.rs` to an allow-list of exact GitHub URLs that Sextant itself built, and AGENTS.md said "never fetch a URL the user, an agent or an extension typed". An image reference is exactly that: its registry host comes from a pod's spec (written by whoever deployed it) or from what the user typed. Registries also hand out server-chosen URLs — the token realm of `WWW-Authenticate` and blob redirects to object storage (S3, GCS, a CDN). Images can be large and hostile (compression bombs, path tricks, millions of entries), and pulling one may need credentials that must never reach the window.

## Decision

This is a deliberate, bounded exception to the download rule; it applies to the image file viewer only (`image_files_*` commands) and nothing else may reuse it to fetch a typed URL.

**Where the code lives.** Parsing, limits and indexing are in the core, without HTTP: `crates/sextant-core/src/image_fs/` (references, challenges and Docker config parsing, pull secrets read through kube, manifests and platform choice, the streaming layer indexer over `std::io::Read`, the merged tree, file extraction, the disk cache). The HTTP client is in `src-tauri/src/image_files/` with the reqwest/rustls (ring, platform verifier) stack `download.rs` uses; the core stays without reqwest.

**Network rules.**
- **HTTPS only.** No plain-HTTP registry and no "insecure" switch, not even per registry: an in-cluster HTTP-only registry cannot be browsed. TLS is verified against the OS roots like every other download.
- **The host is the one in the reference** (`docker.io` → `registry-1.docker.io`, a port is kept). Refused always, as an IP literal and as any address a name resolves to (a filtering DNS resolver, so DNS rebinding does not get around it): loopback, link-local (`169.254.0.0/16` — cloud metadata — and `fe80::/10`), unspecified, multicast, broadcast and the IPv4-mapped forms of these; the name `localhost` and `*.localhost`. Private ranges (`10/8`, `172.16/12`, `192.168/16`, `fc00::/7`, CGNAT) are allowed: in-cluster and corporate registries live there. The same filter applies to the token realm and to every blob redirect. Proxies from the environment (`HTTPS_PROXY`) are honoured as for other downloads; through a proxy the proxy resolves names, so only the URL check applies there.
- **Token flow** per the distribution spec: an anonymous or Basic request first; on `401` with `WWW-Authenticate: Bearer realm=…,service=…` Sextant asks the realm — which must be HTTPS and pass the host filter — for a token with the scope it builds itself, `repository:<repo>:pull` (never the server's wider scope), with the credentials as Basic auth when there are any; the token request follows no redirect; the answer is ≤ 64 KiB. A `Basic` challenge gets the credentials only on the registry host. Tokens live in memory for the open image only.
- **Redirects.** Manifests: none, except to the same origin (scheme, host and port). Blobs: at most 5 hops, each HTTPS and passing the host filter, to any host (registries keep blobs on S3/GCS/CDN); a hop never carries `Authorization` or any credential (signed URLs carry their own).
- **Digests are verified.** Every blob (config, layer) is hashed while streamed and refused on a mismatch (its index is not cached); a manifest fetched by digest is checked against it. Only `sha256` digests are accepted.
- Errors never carry a full URL, a token or a credential.

**Credentials** (first match wins, per registry host; anonymous otherwise):
1. From a pod: the pod's `imagePullSecrets`, then its ServiceAccount's — `kubernetes.io/dockerconfigjson` and `kubernetes.io/dockercfg` Secrets read in the core for this only. Matching follows the kubelet's keyring in its simple form: `host[:port]` of the key (an `https://` prefix and a path are ignored), Docker Hub aliases (`docker.io`, `index.docker.io`, `registry-1.docker.io`, `https://index.docker.io/v1/`), and `*.domain` wildcards for one label.
2. Only with the opt-in setting `imageFiles.dockerCredentials` (off by default; a checkbox on the "Image files" page): the user's `~/.docker/config.json` (`$DOCKER_CONFIG/config.json`) — `credHelpers[host]`, then `auths[host]` (`auth`, `identitytoken`), then `credsStore`. A credential helper is a program the user configured for exactly this, like a kubeconfig exec plugin, so the opt-in covers running it: `docker-credential-<name>` with a name of `[A-Za-z0-9._-]{1,64}`, found in `PATH`, run without a shell, with the cloud CLIs' cleaned environment (`CloudCli::child_env`), the server URL on stdin, 10 s timeout, ≤ 64 KiB of output, stderr dropped; behind the core's `desktop` feature.

Credentials are never sent to the window, logged, put in an error or the cache; `Debug` prints `<hidden>`. The window only learns which source answered ("anonymous", "pull secret `<name>`", "Docker config").

**Content.**
- Manifests: OCI image index and Docker manifest list → the window gets the platforms (attestation entries `unknown/unknown` skipped) and picks one; the default is `linux/amd64`, else the first. OCI and Docker v2 schema 2 manifests; schema 1, encrypted and foreign (non-distributable) layers are refused.
- Layers are streamed (`tar`, `tar+gzip`, `tar+zstd`; gzip by flate2, zstd by the pure-Rust `ruzstd`), never stored whole. The indexer reads ustar, GNU long names and pax records (≤ 2 MiB of header records per entry) and keeps path, kind, size, mode, uid/gid, user/group names, mtime and link target. Paths are normalised (`./` and a leading `/` dropped); an entry with a `..` component, an empty or over-long path is skipped and counted.
- The merged tree follows the OCI layer spec: layers are applied bottom to top; in each layer whiteouts (`.wh.<name>`) and opaque markers (`.wh..wh..opq`) remove what lower layers had, then the layer's own entries go in; whiteouts are not shown. Every node remembers which layer provides it.
- Symbolic links are shown with their target and resolved only inside the merged tree (`..` stops at the root, ≤ 40 hops) — never on disk, never outside the image; viewing or downloading a link reads nothing. A hard link's data is the entry it names in the hard link's own layer (as tar writes it).
- Reading a file streams its layer again from the registry. Text view: the first 1 MiB, reading stops at the entry; binary when the first 8 KiB holds a NUL or the text is not UTF-8 (then not shown). A download goes to a path picked in the backend's own save dialog, through a `.sextant-download-*.part` file created exclusively next to it; the whole layer is read and its digest checked, and only then is the file renamed over the destination.
- Nothing from an image is ever executed, and nothing is extracted to disk except the one file the user downloads.

**Limits** (constants in `image_fs::limits`): manifest, index and config ≤ 4 MiB each; ≤ 128 layers; a layer ≤ 4 GiB compressed (by its descriptor and by the bytes read) and ≤ 16 GiB uncompressed; ≤ 8 GiB downloaded per open; decompressed bytes ≤ 64 MiB + 200 × compressed bytes read (gzip/zstd bombs); ≤ 300 000 entries over all layers and ≤ 64 MiB of their path bytes (the merged tree ≤ 300 000 nodes and 128 MiB of path bytes, implied parent folders included); paths and link targets ≤ 4096 bytes; zstd windows ≤ 128 MiB; a folder lists ≤ 10 000 children, a search ≤ 500 results (query ≤ 256 characters); a downloaded file ≤ 4 GiB; no data for 60 s or 30 min for one open → timeout. At most 4 images are open at once.

**Cache.** The index of each verified layer (not its content) is kept in `<app cache>/image-files/<sha256>.json` (a format version inside; a file that does not read is deleted), ≤ 64 MiB each, ≤ 256 MiB in all, least recently used removed first. Manifests are not cached (tags move).

**Streams and state.** Opening is a stream through `openStream` (progress per layer, then the summary); reading a file and a download are streams too. All are subscriptions in `AppState` (stopped by `image_files_stop`, `close_cluster` for pod sources, `streams_reset` and exit), and the open images are `AppState.image_files`, dropped on reset and exit. Cancelling drops the HTTP stream; the indexing thread then ends on its closed input.

**Window only.** No `image_files_*` command is an MCP tool or an extension method (a test asserts it).

## Why

- The value of the feature is browsing what really runs, so the registry must be the one in the reference; a fixed allow-list is impossible. The host filter keeps the one class of targets that turns this into a request forgery tool — this machine and the cloud metadata service — out of reach, including through server-supplied realms and redirects, while private registries keep working.
- HTTPS only with no opt-out keeps credentials and pull secrets off the wire in clear; an "insecure registry" option would have been one more place for a pull secret to leak.
- Building the token scope and dropping credentials on redirects follow what container runtimes do and keep a registry from obtaining broader tokens or passing credentials to a storage host.
- Indexes, not layers, are cached: the cache stays small, and nothing from an image lands on disk unasked.

## Consequences

- Plain-HTTP and self-signed registries (without the CA in the OS store) cannot be browsed; registries behind `127.0.0.1` port forwards neither.
- Viewing a file downloads its layer again up to the entry; a file deep in a large layer takes as long as that.
- A typed reference uses anonymous access or, with the opt-in, the user's Docker credentials; pull secrets are used only when opening from a pod.
- `AGENTS.md`'s download rule names this exception.
