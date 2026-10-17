# ADR-0067: Desktop notifications are quiet at start, rate-limited, inert, and can be turned off at every level

## Context

A Kubernetes client that tells you when something starts failing is useful while you work elsewhere, also with the window hidden in the tray (ADR-0059) (#135). It is also an easy way to annoy: a cluster with 40 crash-looping pods at connect, a flapping readiness probe, or a noisy development cluster next to production. Some users do not want desktop notifications at all. And the text of a notification comes from the cluster: a condition message is written by whoever controls a controller or a CRD, and on Linux the notification server reads the body as markup.

## Decision

- **Off switches at every level, saved at once** in `AppSettings.notifications` (written by the frontend): the global switch (`enabled`, on by default), categories (`disabledCategories`: Nodes, Pods, Workloads, Jobs, Volume claims, Certificates, Flux, Argo CD, Gateway API; Warning events never notify), clusters (`mutedClusters`: a cluster turned off never notifies) and "Mute for 1 hour" (`mutedUntil`), from Settings → General → Notifications, from the history on the problems screen and from the notification's own button where the system shows it. Settings and the mute are read when a notification is due, not when it was found.
- **Only what the user already opened.** Notifications watch only clusters that are already connected and not muted, and only enabled categories; Sextant never connects a cluster for notifications.
- **Quiet start.** The first look at a source (a cluster connected, a category turned on, the app started) only records the problems already there; only problems that begin afterwards notify.
- **Once per state.** A `notifyKey` (ADR-0066) is told once while it lasts and again only after it has been gone for 30 minutes, so a flapping condition notifies once.
- **Grouped and rate-limited.** What starts within 3 s is shown one by one up to 3, else as one summary ("5 new problems in prod", or across clusters); at most 6 notifications a minute, the rest wait for the next minute and are grouped the same way; a notification whose problem went away while it waited is dropped. Every notification due, shown, summarised or muted, goes into an in-app history of the last 100 on the problems screen.
- **Inert text.** Cluster text is clipped (message 200, title 100 code points, surrogate pairs never split) and made inert: `&`, `<`, `>` become look-alike characters, which read the same everywhere (an entity would show literally on macOS and Windows).
- **Through the OS, nothing leaves the machine.** The Tauri notification plugin shows them; a click reveals the window (also from the tray) and opens the object or, for a summary, the problems screen.

## Why

- Notifying about everything found at connect was rejected: the user who just connected is looking at the cluster, and a burst of old problems teaches them to turn notifications off.
- Off by default was rejected: the feature is useful only if it is there when something breaks; the quiet start, the per-state cooldown and the rate limit keep the default bearable, and turning it off is one checkbox.
- Watching every cluster in the kubeconfig was rejected: connecting clusters the user did not open costs credentials prompts, cloud CLI calls and API load, and surprises.
- HTML escaping was rejected: macOS and Windows do not read markup and would show `&lt;` literally; look-alikes are harmless on all three.
- An own notification window was rejected: the OS service respects the user's do-not-disturb and works while the window is hidden.

## Consequences

- A problem that already existed at connect is never notified, only shown on the screen and in the badge.
- A state that comes back within 30 minutes is not told again.
- The notification's "Mute for 1 hour" button depends on the platform's notification service; the same mute is always available in Settings and on the problems screen.
- Notifications keep the problem watches of every connected, unmuted cluster open in the background.
