# ADR-0065: Files are copied with tar in the container and written locally only when complete

## Context

Users need to take a heap dump, a log file or a config out of a container and to put a file into one (#133). Kubernetes has no file API: `kubectl cp` runs `tar` in the container over exec and unpacks the stream on the client, which has a history of path traversal bugs (an archive from a compromised container writing outside the destination). The data comes from a container Sextant does not trust, and it is written on the user's machine.

## Decision

- **`tar` over exec, as `kubectl cp`.** A download runs `tar cf - -C <parent> ./<name>` and reads stdout; an upload writes a tar stream Sextant builds itself (one regular file, its mode and mtime) into `tar xf - -C <parent>`. The member is always passed as `./<name>`, so a name starting with `-` is never an option. A container without `tar` gets a clear message pointing to a debug container (ADR-0064).
- **`files_stat` first.** The first tar header says what the path is (file, folder, link, other) and its size; a folder's size is `du -sk` when the container has `du`. The download is then checked against that kind, so a path that changed meanwhile is refused.
- **A file is unpacked only when the archive is exactly that file**: one regular entry with the asked name, no absolute path, no `..`, no link, no second entry; long-name and pax headers before it are capped at 2 MiB. **A folder is never unpacked**: the tar stream is gzip-compressed and saved as `.tar.gz`.
- **Written only when complete.** Data goes to a private temporary file `.sextant-download-*.part`, created exclusively next to the destination, and is renamed over the destination after `tar` exits successfully (a link at the destination is replaced, never followed). A failed or cancelled download removes the temporary file and leaves the destination as it was.
- **Uploads ask first**, naming the file, the path, the container and the pod, and saying that a file there is replaced and that a cancelled upload may leave a partly written file in the container.
- **A transfer is a stream.** It runs under a frontend-chosen id (`files:<streamId>`, progress at most every 100 ms, then `done` or `error`), is a subscription of its cluster in `AppState`, and stops on cancel, disconnect, `streams_reset` and exit.
- **The user's tool only**: no MCP tool, no extension method.

## Why

- Unpacking folders locally was rejected: it is where `kubectl cp` had its traversal and link bugs; a `.tar.gz` keeps every byte and lets the user unpack it with tools and options they choose.
- Writing straight to the destination was rejected: a cancelled or broken stream would leave a truncated file under the name the user asked for, indistinguishable from a good one, and a link planted at the destination would be followed.
- A helper binary copied into the container, or `cat`/`base64` over exec, were rejected: the first changes the container more than needed and needs a writable path, the second has no metadata or folders and still needs a shell.
- Offering it to agents was rejected: moving files across the boundary of a container is the user's decision and would bypass the output limits of `exec_command`.

## Consequences

- Images without `tar` (distroless) cannot be copied from directly; a debug copy with a shared process namespace or another image is the way.
- A folder arrives as an archive, not as a folder.
- The total of a folder download is an estimate and may be missing; progress then shows bytes only.
- An upload cannot be made atomic inside the container: `tar` writes in place.
