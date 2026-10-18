// One function per backend command (interfaces.md, "Commands"). Argument names are the camelCase names the
// Rust commands expect. Every function rejects with `ApiError`.
import type { AboutInfo } from "./generated/AboutInfo";
import type { AccessAnswer } from "./generated/AccessAnswer";
import type { AccessPreset } from "./generated/AccessPreset";
import type { AccessQuery } from "./generated/AccessQuery";
import type { RulesReview } from "./generated/RulesReview";
import type { SecretCertificates } from "./generated/SecretCertificates";
import type { TlsExpiryScan } from "./generated/TlsExpiryScan";
import type { ScanApi } from "./generated/ScanApi";
import type { UpgradeScan } from "./generated/UpgradeScan";
import type { KindRef } from "./generated/KindRef";
import type { ObjectManagers } from "./generated/ObjectManagers";
import type { PartialHistory } from "./generated/PartialHistory";
import type { AccessRule } from "./generated/AccessRule";
import type { AppSettings } from "./generated/AppSettings";
import type { ArgoLogin } from "./generated/ArgoLogin";
import type { ArgoStatus } from "./generated/ArgoStatus";
import type { AuditEntry } from "./generated/AuditEntry";
import type { ChartHit } from "./generated/ChartHit";
import type { DryRunMode } from "./generated/DryRunMode";
import type { DeletePreconditions } from "./generated/DeletePreconditions";
import type { KindSample } from "./generated/KindSample";
import type { ClusterCheck } from "./generated/ClusterCheck";
import type { NamedObject } from "./generated/NamedObject";
import type { DryRunResult } from "./generated/DryRunResult";
import type { HelmManifestDiff } from "./generated/HelmManifestDiff";
import type { ChartTarget } from "./generated/ChartTarget";
import type { CloudAccounts } from "./generated/CloudAccounts";
import type { CloudCliStatus } from "./generated/CloudCliStatus";
import type { CloudCluster } from "./generated/CloudCluster";
import type { CloudImport } from "./generated/CloudImport";
import type { CloudProblem } from "./generated/CloudProblem";
import type { CloudProvider } from "./generated/CloudProvider";
import type { CloudQuery } from "./generated/CloudQuery";
import type { CloudSearch } from "./generated/CloudSearch";
import type { ClusterId } from "./generated/ClusterId";
import type { ClusterInfo } from "./generated/ClusterInfo";
import type { ConnectionState } from "./generated/ConnectionState";
import type { DebugSpec } from "./generated/DebugSpec";
import type { DrainOptions } from "./generated/DrainOptions";
import type { DrainPreview } from "./generated/DrainPreview";
import type { ExtensionInfo } from "./generated/ExtensionInfo";
import type { ForwardInfo } from "./generated/ForwardInfo";
import type { ForwardTarget } from "./generated/ForwardTarget";
import type { GitopsStatus } from "./generated/GitopsStatus";
import type { GitopsTool } from "./generated/GitopsTool";
import type { GitopsVersions } from "./generated/GitopsVersions";
import type { HelmRelease } from "./generated/HelmRelease";
import type { HelmReleaseDetail } from "./generated/HelmReleaseDetail";
import type { HelmRepo } from "./generated/HelmRepo";
import type { HelmStatus } from "./generated/HelmStatus";
import type { InstallEvent } from "./generated/InstallEvent";
import type { InstallPreview } from "./generated/InstallPreview";
import type { KubeconfigSource } from "./generated/KubeconfigSource";
import type { LogOptions } from "./generated/LogOptions";
import type { LogUpdate } from "./generated/LogUpdate";
import type { ManagedResource } from "./generated/ManagedResource";
import type { McpStatus } from "./generated/McpStatus";
import type { MetricsStatus } from "./generated/MetricsStatus";
import type { NodeUsage } from "./generated/NodeUsage";
import type { ObjectRef } from "./generated/ObjectRef";
import type { PatchType } from "./generated/PatchType";
import type { PendingInstall } from "./generated/PendingInstall";
import type { PodUsage } from "./generated/PodUsage";
import type { RemoteEntry } from "./generated/RemoteEntry";
import type { RemoteKind } from "./generated/RemoteKind";
import type { ResourceKind } from "./generated/ResourceKind";
import type { Series } from "./generated/Series";
import type { HistoryScope } from "./generated/HistoryScope";
import type { HistoryWindow } from "./generated/HistoryWindow";
import type { UsageHistory } from "./generated/UsageHistory";
import type { SettingsStatus } from "./generated/SettingsStatus";
import type { TermPayload } from "./generated/TermPayload";
import type { TransferEvent } from "./generated/TransferEvent";
import type { TrayStatus } from "./generated/TrayStatus";
import type { TrayTexts } from "./generated/TrayTexts";
import type { WatchSpec } from "./generated/WatchSpec";
import type { WatchUpdate } from "./generated/WatchUpdate";
import { call, type StreamChannel } from "./transport";

/** A Kubernetes object as JSON (`managedFields` already stripped by the backend). */
export type KubeObject = {
  apiVersion?: string;
  kind?: string;
  metadata?: {
    name?: string;
    namespace?: string;
    uid?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
};

export const clusters = {
  list: () => call<ClusterInfo[]>("clusters_list"),
  sources: () => call<KubeconfigSource[]>("kubeconfig_sources"),
  addFile: (path: string) => call<KubeconfigSource>("kubeconfig_add_file", { path }),
  addPasted: (text: string) => call<KubeconfigSource>("kubeconfig_add_pasted", { text }),
  removeSource: (sourceId: string) => call<void>("kubeconfig_remove", { sourceId }),
  connect: (clusterId: ClusterId) => call<void>("cluster_connect", { clusterId }),
  disconnect: (clusterId: ClusterId) => call<void>("cluster_disconnect", { clusterId }),
  state: (clusterId: ClusterId) => call<ConnectionState>("cluster_state", { clusterId }),
  kinds: (clusterId: ClusterId) => call<ResourceKind[]>("cluster_kinds", { clusterId }),
  /** Forgets the backend's discovery of the cluster (a CRD was created or deleted); the next `kinds` asks again. */
  refreshKinds: (clusterId: ClusterId) => call<void>("cluster_kinds_refresh", { clusterId }),
};

/**
 * Cloud clusters (EKS, GKE, AKS) through the user's own `aws`, `gcloud` and `az`. Sextant never signs in: a problem
 * carries the command the user runs (`aws sso login --profile …`, `gcloud auth login`, `az login`).
 */
export const cloud = {
  /** The three CLIs: installed or not, version, credential plugin. */
  status: () => call<CloudCliStatus[]>("cloud_status"),
  /** AWS profiles (and regions), GCP projects or Azure subscriptions; `problem` when the CLI is missing or signed out. */
  accounts: (provider: CloudProvider) => call<CloudAccounts>("cloud_accounts", { provider }),
  /** Clusters of an account (in the chosen regions for AWS). */
  find: (query: CloudQuery) => call<CloudSearch>("cloud_find", { query }),
  /** Writes the clusters to Sextant's own `cloud-<provider>.yaml` and saves the sources; refresh the cluster list after. */
  importClusters: (clusters: CloudCluster[]) => call<CloudImport>("cloud_import", { clusters }),
  /** How to sign in again (or what to install) for a cluster whose sign-in failed; `null` if not a cloud cluster. */
  loginHint: (clusterId: ClusterId) => call<CloudProblem | null>("cloud_login_hint", { clusterId }),
};

/**
 * Every stream (watch, logs, terminal) gets its id from the frontend, which also creates the channel its payloads come
 * through (`onEvent`) before it starts the stream (`openStream`).
 */
export const streams = {
  /** Stops every watch, log stream and terminal session (not connections or port forwards); on page load. */
  reset: () => call<void>("streams_reset"),
};

export const resources = {
  /** Starts a watch under `streamId`; updates arrive through `onEvent`. */
  watchStart: (clusterId: ClusterId, spec: WatchSpec, streamId: string, onEvent: StreamChannel<WatchUpdate>) =>
    call<void>("watch_start", { clusterId, spec, streamId, onEvent }),
  watchStop: (subscriptionId: string) => call<void>("watch_stop", { subscriptionId }),
  get: (clusterId: ClusterId, ref: ObjectRef) => call<KubeObject>("resource_get", { clusterId, ref }),
  /** The whole object, Secret values included (only for editing a Secret). */
  getFull: (clusterId: ClusterId, ref: ObjectRef) => call<KubeObject>("resource_get_full", { clusterId, ref }),
  /** One value of a Secret, decoded as text. */
  secretValue: (clusterId: ClusterId, namespace: string, name: string, key: string) =>
    call<string>("secret_value", { clusterId, namespace, name, key }),
  replace: (clusterId: ClusterId, yaml: string) => call<KubeObject>("resource_replace", { clusterId, yaml }),
  apply: (clusterId: ClusterId, yaml: string) => call<ObjectRef[]>("resource_apply", { clusterId, yaml }),
  /**
   * What `replace` (`mode` "replace") or `apply` ("apply") of `yaml` would do, sent with `dryRun=All`: the live object
   * and what the server would store, Secrets without their values. Changes nothing.
   */
  dryRun: (clusterId: ClusterId, yaml: string, mode: DryRunMode) =>
    call<DryRunResult>("resource_dry_run", { clusterId, yaml, mode }),
  /**
   * Deletes one object. With `preconditions` the API server deletes it only while its uid and resourceVersion are
   * still those (otherwise a `conflict` error): the cleanup page names the object it checked.
   */
  delete: (clusterId: ClusterId, ref: ObjectRef, preconditions?: DeletePreconditions) =>
    call<void>("resource_delete", preconditions ? { clusterId, ref, preconditions } : { clusterId, ref }),
  /**
   * Merge patch (an object) or JSON patch (a list of operations) of one object, signed by `sextant`; resolves to the
   * object as saved (a Secret without its values).
   */
  patch: (clusterId: ClusterId, ref: ObjectRef, patch: unknown, patchType: PatchType) =>
    call<KubeObject>("resource_patch", { clusterId, ref, patch, patchType }),
};

export const actions = {
  scale: (clusterId: ClusterId, ref: ObjectRef, replicas: number) =>
    call<void>("workload_scale", { clusterId, ref, replicas }),
  restart: (clusterId: ClusterId, ref: ObjectRef) => call<void>("workload_restart", { clusterId, ref }),
  cordon: (clusterId: ClusterId, name: string, unschedulable: boolean) =>
    call<void>("node_cordon", { clusterId, name, unschedulable }),
  drainPreview: (clusterId: ClusterId, name: string) => call<DrainPreview>("node_drain_preview", { clusterId, name }),
  drain: (clusterId: ClusterId, name: string, options: DrainOptions) =>
    call<void>("node_drain", { clusterId, name, options }),
  triggerCronJob: (clusterId: ClusterId, ref: ObjectRef) => call<ObjectRef>("cronjob_trigger", { clusterId, ref }),
  suspendCronJob: (clusterId: ClusterId, ref: ObjectRef, suspend: boolean) =>
    call<void>("cronjob_suspend", { clusterId, ref, suspend }),
};

export const logs = {
  /** Starts a log stream under `streamId`; batches arrive through `onEvent`. */
  start: (
    clusterId: ClusterId,
    pod: ObjectRef,
    opts: LogOptions,
    streamId: string,
    onEvent: StreamChannel<LogUpdate>,
  ) => call<void>("logs_start", { clusterId, pod, opts, streamId, onEvent }),
  stop: (streamId: string) => call<void>("logs_stop", { streamId }),
};

export const terminal = {
  /** Shell in a container, session `streamId` (output through `onEvent`, as for every session below). */
  exec: (
    clusterId: ClusterId,
    pod: ObjectRef,
    container: string,
    cols: number,
    rows: number,
    streamId: string,
    onEvent: StreamChannel<TermPayload>,
  ) => call<void>("exec_start", { clusterId, pod, container, cols, rows, streamId, onEvent }),
  /**
   * Local shell, session `streamId`: with `KUBECONFIG` set to the cluster, or — `clusterId` null — without any
   * `KUBECONFIG` from Sextant (e.g. to sign in to a cloud CLI).
   */
  local: (
    clusterId: ClusterId | null,
    cols: number,
    rows: number,
    streamId: string,
    onEvent: StreamChannel<TermPayload>,
  ) => call<void>("terminal_start", { clusterId, cols, rows, streamId, onEvent }),
  /**
   * Shell on `node` through a temporary privileged pod in `kube-system` (deleted when the session ends), session
   * `streamId`. Never offered to AI agents.
   */
  nodeShell: (
    clusterId: ClusterId,
    node: string,
    cols: number,
    rows: number,
    streamId: string,
    onEvent: StreamChannel<TermPayload>,
  ) => call<void>("node_shell_start", { clusterId, node, cols, rows, streamId, onEvent }),
  /**
   * Debug container for `pod` (`kubectl debug`), session `streamId`: an ephemeral container in the pod, or — with
   * `spec.copy` — a copy of the pod (deleted when the session ends), with a terminal attached. Never offered to AI
   * agents or extensions.
   */
  debug: (
    clusterId: ClusterId,
    pod: ObjectRef,
    spec: DebugSpec,
    cols: number,
    rows: number,
    streamId: string,
    onEvent: StreamChannel<TermPayload>,
  ) => call<void>("debug_start", { clusterId, pod, spec, cols, rows, streamId, onEvent }),
  input: (sessionId: string, data: string) => call<void>("term_input", { sessionId, data }),
  resize: (sessionId: string, cols: number, rows: number) => call<void>("term_resize", { sessionId, cols, rows }),
  stop: (sessionId: string) => call<void>("term_stop", { sessionId }),
  /**
   * The terminal has written `bytes` more bytes of the session's output. A session with too much output
   * unacknowledged stops reading its shell until acknowledgements come (flow control, #122).
   */
  ack: (sessionId: string, bytes: number) => call<void>("term_ack", { sessionId, bytes }),
};

export const portForward = {
  start: (clusterId: ClusterId, target: ForwardTarget, remotePort: number, localPort: number | null = null) =>
    call<ForwardInfo>("portforward_start", { clusterId, target, remotePort, localPort }),
  list: () => call<ForwardInfo[]>("portforward_list"),
  stop: (id: string) => call<void>("portforward_stop", { id }),
};

export const metrics = {
  pods: (clusterId: ClusterId, namespaces: string[] | null = null) =>
    call<PodUsage[]>("metrics_pods", { clusterId, namespaces }),
  nodes: (clusterId: ClusterId) => call<NodeUsage[]>("metrics_nodes", { clusterId }),
  status: (clusterId: ClusterId) => call<MetricsStatus>("metrics_status", { clusterId }),
  charts: (clusterId: ClusterId, chart: ChartTarget, rangeSecs: number) =>
    call<Series[]>("metrics_charts", { clusterId, chart, rangeSecs }),
  usageHistory: (clusterId: ClusterId, scope: HistoryScope, window: HistoryWindow) =>
    call<UsageHistory>("metrics_usage_history", { clusterId, scope, window }),
};

export const helm = {
  status: () => call<HelmStatus>("helm_status"),
  releases: (clusterId: ClusterId, namespaces: string[] | null = null) =>
    call<HelmRelease[]>("helm_releases", { clusterId, namespaces }),
  releaseDetail: (clusterId: ClusterId, namespace: string, name: string, revision: number | null = null) =>
    call<HelmReleaseDetail>("helm_release_detail", { clusterId, namespace, name, revision }),
  releaseHistory: (clusterId: ClusterId, namespace: string, name: string) =>
    call<HelmRelease[]>("helm_release_history", { clusterId, namespace, name }),
  upgrade: (clusterId: ClusterId, namespace: string, release: string, chartRef: string, valuesYaml: string) =>
    call<void>("helm_upgrade", { clusterId, namespace, release, chartRef, valuesYaml }),
  rollback: (clusterId: ClusterId, namespace: string, release: string, revision: number) =>
    call<void>("helm_rollback", { clusterId, namespace, release, revision }),
  uninstall: (clusterId: ClusterId, namespace: string, release: string) =>
    call<void>("helm_uninstall", { clusterId, namespace, release }),
  install: (
    clusterId: ClusterId,
    namespace: string,
    release: string,
    chart: string,
    version: string | null,
    valuesYaml: string,
  ) => call<void>("helm_install", { clusterId, namespace, release, chart, version, valuesYaml }),
  /**
   * What `upgrade` with the same arguments would change (Helm's `--dry-run=server`); Secrets without their values.
   * Runs under `previewId` (a stream-like id) until it ends, `previewStop`, the cluster closes or 120 s pass.
   */
  upgradePreview: (
    clusterId: ClusterId,
    namespace: string,
    release: string,
    chartRef: string,
    valuesYaml: string,
    previewId: string,
  ) =>
    call<HelmManifestDiff>("helm_upgrade_preview", { clusterId, namespace, release, chartRef, valuesYaml, previewId }),
  /** What `install` with the same arguments would apply, against a release of that name already there. */
  installPreview: (
    clusterId: ClusterId,
    namespace: string,
    release: string,
    chart: string,
    version: string | null,
    valuesYaml: string,
    previewId: string,
  ) =>
    call<HelmManifestDiff>("helm_install_preview", {
      clusterId,
      namespace,
      release,
      chart,
      version,
      valuesYaml,
      previewId,
    }),
  /** Stops a running preview (its `helm` is killed); an unknown id is fine. */
  previewStop: (previewId: string) => call<void>("helm_preview_stop", { previewId }),
  repos: () => call<HelmRepo[]>("helm_repos"),
  repoAdd: (name: string, url: string, username?: string, password?: string) =>
    call<void>("helm_repo_add", { name, url, username, password }),
  repoRemove: (name: string) => call<void>("helm_repo_remove", { name }),
  repoUpdate: () => call<void>("helm_repo_update"),
  search: (query: string) => call<ChartHit[]>("helm_search", { query }),
  showValues: (chart: string, version: string | null = null) => call<string>("helm_show_values", { chart, version }),
};

export const settings = {
  get: () => call<AppSettings>("settings_get"),
  /** Replaces the settings; resolves to what was stored. Prefer `updateSettings` / `useSettings().update`. */
  update: (value: AppSettings) => call<AppSettings>("settings_update", { settings: value }),
  /** Whether the settings file was readable and is being saved. */
  status: () => call<SettingsStatus>("settings_status"),
  /** Whether the tray icon exists; without it "Closing the window keeps Sextant in the tray" cannot be turned on. */
  trayStatus: () => call<TrayStatus>("tray_status"),
  /** The tray menu's texts in the UI language (the keys of `tray.json`); the menu is relabelled at once. */
  traySetTexts: (texts: TrayTexts) => call<void>("tray_set_texts", { texts }),
};

/** What "About Sextant" shows about the machine (no paths, no user names). */
export const about = {
  info: () => call<AboutInfo>("about_info"),
};

export const files = {
  save: (path: string, contents: string) => call<void>("file_save", { path, contents }),
  /** What `path` in a container is (file, folder, link) and how big. `container` null: the default one. */
  stat: (clusterId: ClusterId, pod: ObjectRef, container: string | null, path: string) =>
    call<RemoteEntry>("files_stat", { clusterId, pod, container, path }),
  /**
   * Downloads `path` from the container to `destination` (from the save dialog) under `streamId`: a file's content, a
   * folder as `.tar.gz`. `kind` is what `stat` saw; a path that changed since is refused. Progress and the result
   * arrive through `onEvent`.
   */
  downloadStart: (
    clusterId: ClusterId,
    pod: ObjectRef,
    container: string | null,
    path: string,
    kind: RemoteKind,
    destination: string,
    streamId: string,
    onEvent: StreamChannel<TransferEvent>,
  ) => call<void>("files_download_start", { clusterId, pod, container, path, kind, destination, streamId, onEvent }),
  /** Uploads the local file `source` into the container as `path` (its full path there) under `streamId`. */
  uploadStart: (
    clusterId: ClusterId,
    pod: ObjectRef,
    container: string | null,
    source: string,
    path: string,
    streamId: string,
    onEvent: StreamChannel<TransferEvent>,
  ) => call<void>("files_upload_start", { clusterId, pod, container, source, path, streamId, onEvent }),
  /** Cancels a transfer (a download leaves no partial file). */
  transferStop: (streamId: string) => call<void>("files_transfer_stop", { streamId }),
};

/**
 * Argo CD API through a port forward to `argocd-server`. Passwords and tokens only go in (`login`); nothing the
 * backend answers carries one.
 */
export const argocd = {
  /** Whether Argo CD is signed in for the cluster (does not sign in). */
  status: (clusterId: ClusterId) => call<ArgoStatus>("argocd_status", { clusterId }),
  /** Signs in with a user name and password or an API token; `remember` saves it in the OS credential store. */
  login: (clusterId: ClusterId, login: ArgoLogin) => call<ArgoStatus>("argocd_login", { clusterId, login }),
  /** Ends the session; `forget` also deletes the saved login. */
  logout: (clusterId: ClusterId, forget: boolean) =>
    call<ArgoStatus>("argocd_logout", { clusterId, options: { forget } }),
  /**
   * Desired (Git) and live states of an Application's resources; Secret values are `""`. Signs in by itself from the
   * saved login or the standard secrets; rejects with `unauthorized` when none works (show the sign-in window).
   */
  diff: (clusterId: ClusterId, app: ObjectRef) => call<ManagedResource[]>("argocd_diff", { clusterId, app }),
};

/**
 * Installing Flux or Argo CD from their official manifests (only from the window: agents and extensions cannot).
 * `prepare` downloads and checks the manifest and answers the preview with a token that `start` spends once, within
 * ten minutes; the install runs as a stream whose events (`InstallEvent`) come through `onEvent` (open it with
 * `openStream`).
 */
export const gitopsInstall = {
  /** Stable releases, newest first; only the bundled version (and `error`) when GitHub cannot be asked. */
  versions: (tool: GitopsTool) => call<GitopsVersions>("gitops_install_versions", { tool }),
  prepare: (clusterId: ClusterId, tool: GitopsTool, version: string) =>
    call<InstallPreview>("gitops_install_prepare", { clusterId, tool, version }),
  start: (clusterId: ClusterId, token: string, streamId: string, onEvent: StreamChannel<InstallEvent>) =>
    call<void>("gitops_install_start", { clusterId, token, streamId, onEvent }),
  /** Stops after the object being applied (or the wait for readiness); an ended install is not an error. */
  stop: (streamId: string) => call<void>("gitops_install_stop", { streamId }),
  /** Whether Flux and Argo CD are in the cluster (their CRDs). */
  status: (clusterId: ClusterId) => call<GitopsStatus>("gitops_install_status", { clusterId }),
};

/**
 * Upgrade readiness (#142): the API versions of `apis` the cluster serves and where they are still used (live objects'
 * last applied configuration and field managers, Helm release manifests, Argo CD and Flux inventories), the server
 * version, kubelet and control-plane versions. Read-only and bounded; a source that cannot be read is in `sources`.
 * Window only: agents and extensions have no such call.
 */
export const upgrade = {
  scan: (clusterId: ClusterId, apis: ScanApi[]) => call<UpgradeScan>("upgrade_scan", { clusterId, apis }),
};

/**
 * Cleanup (#147): what `namespace` holds of each of `kinds` (at most 300), at most `limit` (1–5) names per kind from
 * metadata-only lists; a kind that cannot be read carries its error. Read-only; window only.
 */
export const cleanup = {
  sample: (clusterId: ClusterId, namespace: string, kinds: KindRef[], limit: number) =>
    call<KindSample[]>("cleanup_sample", { clusterId, namespace, kinds, limit }),
  /**
   * API group versions that do not answer, and which of `targets` (ConfigMaps and Secrets, at most 20000) an object of
   * the cluster-scoped `kinds` (at most 300, 500 objects each) names; only targets come back.
   */
  clusterCheck: (clusterId: ClusterId, kinds: KindRef[], targets: NamedObject[]) =>
    call<ClusterCheck>("cleanup_cluster_check", { clusterId, kinds, targets }),
};

/**
 * Change timeline (#145): what watches cannot carry. `managers` reads the field managers of up to 50 objects (metadata
 * only); `history` the partial history of up to 10 namespaces (managers' last changes, rollout revisions, Helm release
 * revisions); `objectHistory` the same for one object. `save`/`load` keep a recorded timeline between runs (only while
 * `settings.timeline.persist`; `save(id, null)` removes it). Read-only; window only.
 */
export const timeline = {
  managers: (clusterId: ClusterId, refs: ObjectRef[]) => call<ObjectManagers[]>("timeline_managers", { clusterId, refs }),
  history: (clusterId: ClusterId, namespaces: string[], kinds: KindRef[], helm: boolean) =>
    call<PartialHistory>("timeline_history", { clusterId, namespaces, kinds, helm }),
  objectHistory: (clusterId: ClusterId, object: ObjectRef) =>
    call<PartialHistory>("timeline_object_history", { clusterId, object }),
  save: (clusterId: ClusterId, text: string | null) => call<void>("timeline_save", { clusterId, text }),
  load: (clusterId: ClusterId) => call<string | null>("timeline_load", { clusterId }),
  /** Removes the saved timelines of every cluster (persistence turned off). */
  removeAll: () => call<void>("timeline_remove_all"),
};

/**
 * "Can I …" for the current user, answered by the API server (all its authorizers, not only RBAC): nothing in the
 * cluster changes. Window only: agents and extensions have no such call.
 */
export const rbac = {
  /** One SelfSubjectAccessReview per question (at most 64), answers in order. */
  canI: (clusterId: ClusterId, queries: AccessQuery[]) => call<AccessAnswer[]>("rbac_can_i", { clusterId, queries }),
  /** What the current user may do in `namespace` (SelfSubjectRulesReview; `incomplete` when an authorizer cannot list). */
  rulesReview: (clusterId: ClusterId, namespace: string) => call<RulesReview>("rbac_rules_review", { clusterId, namespace }),
};

/**
 * Certificates of TLS Secrets, parsed by the backend from `tls.crt` / `ca.crt`: only their fields come back, never a
 * Secret value. Read with the user's credentials. Window only: agents and extensions have no such call.
 */
export const tls = {
  /** One Secret's chain and CA (`notFound` without `tls.crt`, `invalid` when it does not parse, `forbidden`). */
  certificateInfo: (clusterId: ClusterId, namespace: string, name: string) =>
    call<SecretCertificates>("tls_certificate_info", { clusterId, namespace, name }),
  /** `kubernetes.io/tls` Secrets of `namespaces` (`null`: all) with when each expires; capped (`truncated`). */
  expiryScan: (clusterId: ClusterId, namespaces: string[] | null) =>
    call<TlsExpiryScan>("tls_expiry_scan", { clusterId, namespaces }),
};

/** AI agent access rules of a cluster (`ClusterSettings.agentAccess`). */
export const access = {
  /** The rules a preset stands for (empty for `off` and `custom`); the only source of preset rules. */
  presetRules: (preset: AccessPreset) => call<AccessRule[]>("access_preset_rules", { preset }),
};

/**
 * The built-in MCP server for AI agents: status, token, the journal of calls and the answers to confirmation requests
 * (`mcp-confirm`). The server starts and stops with `settings.mcp`.
 */
export const mcp = {
  status: () => call<McpStatus>("mcp_status"),
  /** The real token (created on first use); ask only when the user shows or copies it. */
  token: () => call<string>("mcp_token"),
  /** A new token: the old one stops working at once and agent sessions end. Resolves to the new token. */
  regenerateToken: () => call<string>("mcp_regenerate_token"),
  /** Calls of agents, newest first; one cluster's only when `clusterId` is given. */
  auditList: (clusterId: ClusterId | null = null) => call<AuditEntry[]>("mcp_audit_list", { clusterId }),
  auditClear: () => call<void>("mcp_audit_clear"),
  /** Answers an `mcp-confirm` request; rejects with `notFound` when it no longer waits. */
  confirmAnswer: (id: string, approved: boolean) => call<void>("mcp_confirm_answer", { id, approved }),
  /** Path of the running Sextant executable, for the Claude Desktop snippet. */
  binaryPath: () => call<string>("mcp_binary_path"),
};

/**
 * Installed extensions (`ExtensionInfo`), installing one after the user's consent, and the API their frames call.
 * Installing is two steps: `inspect*` checks a package and keeps it for 10 minutes under a token; `install(token)` is
 * the consent click. Changes of the list come as `events.onExtensionsChanged`.
 */
export const extensions = {
  list: () => call<ExtensionInfo[]>("extensions_list"),
  /** Checks a `.sextant-ext` / `.zip` file; installs nothing. */
  inspectFile: (path: string) => call<PendingInstall>("extension_inspect_file", { path }),
  /** Downloads a GitHub release asset (`https://github.com/…/releases/download/…`) and checks it. */
  inspectUrl: (url: string) => call<PendingInstall>("extension_inspect_url", { url }),
  /** Checks an unpacked folder (development mode: it runs from there and reloads when its files change). */
  inspectFolder: (path: string) => call<PendingInstall>("extension_inspect_folder", { path }),
  /**
   * The user's consent to what `PendingInstall.manifest` asks for: installs it and grants its permissions. The token
   * is spent only on success; an error with the code `notFound` (and only that) means it is gone (expired, used, or
   * the package changed since its check) and the package has to be chosen again — any other error can be retried.
   */
  install: (token: string) => call<ExtensionInfo>("extension_install", { token }),
  /** The user declined: the checked package is dropped at once. An unknown or used token is not an error. */
  installCancel: (token: string) => call<void>("extension_install_cancel", { token }),
  setEnabled: (id: string, enabled: boolean) => call<ExtensionInfo>("extension_set_enabled", { id, enabled }),
  /** Removes the extension, its files and its `storage` data. */
  remove: (id: string) => call<void>("extension_remove", { id }),
  /** Reads the manifest and the files again (development mode). */
  reload: (id: string) => call<ExtensionInfo>("extension_reload", { id }),
  /**
   * One API method for an extension's frame (src/extensions/protocol.ts), checked in the backend against what the
   * user granted. `streamId` and `onEvent` are needed by `resources.watch` (its updates come through `onEvent`) and
   * left out by the other methods.
   */
  call: (
    extensionId: string,
    method: string,
    params?: unknown,
    streamId?: string,
    onEvent?: StreamChannel<WatchUpdate>,
  ) => call<unknown>("extension_call", { extensionId, method, params, streamId, onEvent }),
  /** Stops a `resources.watch` stream of the extension; an ended one is not an error. */
  watchStop: (extensionId: string, streamId: string) => call<void>("extension_watch_stop", { extensionId, streamId }),
  /** Calls of extensions, newest first; one extension's only when `extensionId` is given. */
  auditList: (extensionId: string | null = null) => call<AuditEntry[]>("extension_audit_list", { extensionId }),
  auditClear: () => call<void>("extension_audit_clear"),
};
