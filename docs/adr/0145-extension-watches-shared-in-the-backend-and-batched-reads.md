# ADR-0145: Extension watches shared in the backend, and batched reads

## Context

Built-in views read at scale through shared machinery:
- one watch per list for every view (ADR-0091);
- row taps of the problems store;
- bounded chains of named reads, as the Cluster API and Crossplane views make with `resource_get`.

An extension's `resources.watch` opened a core watch of its own for every call, and `resources.get` read one object
per call. Views like Kueue (5000 Workloads), Crossplane or Cluster API moved into extensions (#320) would therefore
double the watches when several frames show the same list, and pay one round trip per object of a chain. #334 asks
for both to be shared or batched.

The issue proposed to hand extension frames the window's own shared streams. Those carry what the window may see,
which for inline secret fields (ADR-0120) and anything else the core leaves to the window is more than an extension
may get. Filtering them again in JavaScript would make a second copy of the rules ADR-0131 keeps in Rust.

## Decision

- **Extension watches are shared in the backend, not with the window.** `src-tauri/src/extensions/watch_hub.rs` keeps
  one core `resources::watch` per list: the cluster and the `WatchSpec` (kind, namespaces, selectors, metadata only).
  It is shared by every extension frame that watches that list, of one extension or of several.
  - **Each call is still checked first.** It is checked against its own grant, and the namespaces it may read are
    worked out before it joins (`ExtCall::watch`, unchanged). Two calls share only when the checks gave the same spec.
  - **The shared data is what any extension watch gets.** The core strips Secret values, and
    `hide_in_watch_update` empties inline secret material once, before the hub.
  - **The first update is still a snapshot.** A frame joining a running list gets the list as it stands as its first
    `snapshot`, then what the stream last said (reconnecting, forbidden namespaces, an error), then every update as
    the others do. An old frame sees exactly what it saw before (ADR-0142).
  - **The list lives with its frames.** It closes when its last frame stops: stopped, its extension disabled,
    re-granted or removed, the page reloaded. When the core watch ends, the frames' watches end with it, and the next
    call opens a new one.
  - The window's own watches are not affected, and the window does not share with extensions.
- **`resources.getMany`** reads 1 to 50 named objects (`MAX_GET_MANY`), 4 at a time (`GET_MANY_AT_ONCE`).
  - The answer is `{ items: [...] }`, each item in its place: `{object}`, or `{error: {code, message}}` for one that
    could not be read (a missing object is `notFound`, a kind not served the error `resources.get` gives).
  - The objects that resolve are checked for Read in one decision before any is read. A batch with one object the
    extension may not read is refused as a whole, as that `resources.get` would be. It is journaled once, naming the
    objects.
  - Objects come back as `resources.get` gives them: no Secret values, no inline secret material.
  - It is in both protocol files and the SDK (`sextant.resources.getMany`, `host.resources.getMany` for backends).
    Being a new method, it needs no API version: an older Sextant answers `invalid`.
- The per-document limit of 32 watches, the confirmations and the journal are unchanged.

## Consequences

- Ten frames of the same list cost one watch and one copy of its objects in the core. The hub keeps the objects
  (shared `Arc`s, not copies) so that a frame joining late can get its snapshot.
- A chain of named reads costs one call per 50 objects instead of one per object.
- Frames and the window still watch a list each for themselves; sharing between them would need the window's watches
  to carry only what extensions may get, which a later decision can take.
- The memory of a shared list was not measured with `scripts/memory.sh` on the kind cluster; the hub's tests show
  that two frames open one watch and that it closes with the last one.
