# Changes of OpenShift

## 1.0.0 — 2026-11-10

Needs Sextant 0.30 (`sextantApi` 4). The first release: Sextant's former built-in OpenShift view (ADR-0120) as an
extension.

- **A sidebar section "OpenShift"** where the built-in one was, with Routes, Deployment Configs, Build Configs, Builds,
  Image Streams and Projects in Sextant's table, the built-in columns in their widths, sorted and filtered as the
  built-in ones, and "Only problems" on Routes, DeploymentConfigs, Builds and ImageStreams.
- **Details** without a heading of their own, their blocks remembered in Sextant's memory of details sections: a
  Route's admission, TLS (inline certificate fields only as "set"), backends with their shares and pods, and routers; a
  DeploymentConfig's state, triggers and rollouts; a BuildConfig's source without credentials and its builds; a Build's
  failure, pod and "Build logs"; an ImageStream's tags and import errors; a Project's annotations and Namespace.
  The tables' columns resize and Sextant remembers their widths, as the built-in tables'.
- **Rollout latest** and **Start build**, each in a window that shows the one request it sends, through Sextant's
  `resources.instantiate`; "Rollout latest" waits while the latest rollout runs and refuses a paused DeploymentConfig,
  as `oc` does.
- **Problems:** Routes no router admitted, failed rollouts, failed Builds for a day (the highest-numbered of each BuildConfig) and
  failing imports (from the earliest failure), in the category "OpenShift", on by default, counted on the section; never given to agents, as the
  built-in category was not.
- Installing asks for consent to read the OpenShift kinds, ReplicationControllers, Services and Pods, to start rollouts
  and builds (Modify on DeploymentConfigs and BuildConfigs, asked in the action's own window), to open a build pod's
  logs, and to judge Routes, DeploymentConfigs, Builds and ImageStreams in problem rules.
