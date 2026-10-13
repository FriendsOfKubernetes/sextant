# ADR-0035: The cluster icon is a 96×96 PNG as a data URL in settings.json

## Context

The generated squares with initials in the cluster rail are indistinguishable; the user wants their own picture or a color with 1–2 characters (the briefing said "ok"). The app has no common file storage: the data directory holds only pasted kubeconfigs. The file-picker dialog returns a path, and there is no file-read command. The CSP allows `data:` and `blob:`, but not `file://` or the asset protocol. The `clusters[id]` fields in `settings.json` belong to the frontend.

## Decision

`ClusterSettings.icon` stores either text (up to 2 graphemes) or a picture as `data:image/png;base64,…`. A PNG, JPEG, SVG or WebP file up to 5 MB is chosen with an `<input type="file">` inside the dialog and read with `FileReader`, drawn on a canvas fitted proportionally into 96×96 with a transparent background, and saved as PNG. There are no new backend commands and no filesystem access. Only a `dataUrl` with the prefix `data:image/png;base64,` is drawn; anything else is ignored.

## Why

- Copying the chosen file into the app directory was rejected: it needs a new Rust command in three places (`generate_handler!`, `commands.ts`, command tests), its own storage, cleanup when a cluster is deleted, and divergence from `settings.json` when it is moved. The specification: simpler and safer.
- Storing the path to the file was rejected: the picture would load neither through `file://` nor through the asset protocol because of the CSP; there is nothing to read a file by path without a new command. That a file on disk can disappear or be replaced is not stated in the materials — this is my inference.
- Storing the whole original file was rejected: the record size would then be unbounded; normalization to 96×96 bounds it.
- Showing an arbitrary `data:` was rejected: only the PNG from the normalizer is drawn.

## Consequences

- Each icon lives in `settings.json`, which is read and written whole on any settings change; the file grows as icons appear. The record size is bounded by 96×96 but is not zero.
- The original is lost: an SVG is rasterized, and the size cannot be changed without choosing the file again.
- The icon moves together with `settings.json`, but is not tied to the kubeconfig and will not survive a settings reset (an unreadable file — a `.bak-…` copy and defaults).
- File selection and the canvas work in the WebView; in tests this is hidden behind `readIconImage` and the errors `type`, `size`, `read`. Checking on Windows and macOS is given only by CI.
- The field belongs to the frontend and is not part of `update_settings`: the `settings_update` mock does not emulate saving backend fields, so a test will not catch the loss of the icon if the field ever becomes backend-owned.
- Reset removes the picture and the text, but not the color.
