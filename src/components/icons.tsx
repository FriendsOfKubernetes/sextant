// The app's icon set: SVG icons of `lucide-react` under the app's own names. Features use only these names
// (`IconName`) and never import `lucide-react` themselves, so the set can be swapped here in one place.
//
//   <Icon name="logs" />                    // 16 px (`--icon-size`), drawn in the text color, hidden from screen readers
//   renderIcon(action.icon)                 // an `IconName` → SVG, `undefined` → nothing
//
// An icon is decoration: the button it is in keeps its name as visible text or `aria-label`, so the SVG is
// `aria-hidden` and has no <title>. No trademark logos (Flux, Argo CD get icons close in meaning).
import type { ReactNode } from "react";
import {
  Anchor,
  AppWindow,
  Archive,
  ArrowDown,
  ArrowDownToLine,
  ArrowLeftRight,
  ArrowUp,
  ArrowUpDown,
  ArrowUpNarrowWide,
  Award,
  BadgeCheck,
  Ban,
  Bell,
  BellRing,
  Bot,
  Box,
  Boxes,
  BrushCleaning,
  BrickWall,
  Bug,
  CircleArrowUp,
  Cable,
  ChartNoAxesGantt,
  ChartPie,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  ClipboardCheck,
  ClipboardList,
  Clock,
  Coins,
  Container,
  Copy,
  Cpu,
  Crosshair,
  Cylinder,
  Database,
  Diff,
  Disc,
  DoorOpen,
  Download,
  EllipsisVertical,
  ExternalLink,
  Eye,
  EyeOff,
  FileBadge,
  FileCheck,
  FileCode,
  FileKey,
  FileLock,
  FileStack,
  FileText,
  Folder,
  FolderKanban,
  FolderTree,
  Gauge,
  GitBranch,
  GitFork,
  Globe,
  GlobeLock,
  Grid2x2,
  Hammer,
  Handshake,
  HardDrive,
  History,
  ImagePlus,
  Images,
  KeyRound,
  KeySquare,
  Landmark,
  Layers,
  Layers2,
  LayoutDashboard,
  LayoutGrid,
  Link,
  Link2,
  ListChecks,
  LockKeyhole,
  Menu,
  Network,
  Package,
  PackageSearch,
  PanelLeftClose,
  PanelLeftOpen,
  Pause,
  Pencil,
  Play,
  Plug,
  Plus,
  Puzzle,
  RadioTower,
  RefreshCcw,
  RefreshCcwDot,
  RefreshCw,
  Rocket,
  RotateCcw,
  RotateCw,
  Route,
  Rss,
  Scale,
  Ruler,
  ScanSearch,
  ScrollText,
  Send,
  Server,
  ServerCog,
  Settings,
  Shield,
  ShieldAlert,
  ShieldCheck,
  ShieldEllipsis,
  ShieldHalf,
  Ship,
  Signpost,
  SlidersHorizontal,
  Split,
  Square,
  SquareTerminal,
  Stamp,
  TicketCheck,
  Trash2,
  TrendingUp,
  TriangleAlert,
  UserCheck,
  UserCog,
  Waves,
  Waypoints,
  Webhook,
  X,
  Zap,
  type LucideIcon,
} from "lucide-react";
// Saved views, pins and workspaces (#149).
import {
  Bookmark as ViewsBookmark,
  BookmarkPlus as ViewsBookmarkPlus,
  Briefcase as ViewsBriefcase,
  Columns3 as ViewsColumns,
  Pin as ViewsPin,
  PinOff as ViewsPinOff,
  Upload as ViewsUpload,
} from "lucide-react";
// Storage insights: VolumeSnapshots and Velero (#152).
import {
  Aperture as StorageAperture,
  ArchiveRestore as StorageArchiveRestore,
  CalendarClock as StorageCalendarClock,
  Camera as StorageCamera,
  DatabaseBackup as StorageDatabaseBackup,
  HardDriveUpload as StorageHardDriveUpload,
  MapPinned as StorageMapPinned,
} from "lucide-react";
// Service mesh: Istio and Linkerd (#155).
import {
  Globe as MeshGlobe,
  KeyRound as MeshKeyRound,
  Link2 as MeshLink,
  LockKeyhole as MeshLock,
  Sailboat as MeshSailboat,
  ShieldCheck as MeshShieldCheck,
  Signpost as MeshSignpost,
} from "lucide-react";
// Knative Serving, Crossplane and Kyverno (#213).
import {
  Blocks as CrossplaneBlocks,
  ClipboardCheck as KyvernoClipboardCheck,
  CloudCog as KnativeCloudCog,
  FileCog as CrossplaneFileCog,
  Gavel as KyvernoGavel,
  GitCommitVertical as KnativeGitCommit,
  GitFork as CrossplaneGitFork,
  Globe as KnativeGlobe,
  Layers as CrossplaneLayers,
  Package as CrossplanePackage,
  Route as KnativeRoute,
  ShieldHalf as KyvernoShieldHalf,
  SquareFunction as CrossplaneFunction,
} from "lucide-react";
// Traefik (#232).
import {
  Combine as TraefikCombine,
  Shuffle as TraefikShuffle,
  SquareSplitHorizontal as TraefikSplit,
  TrafficCone as TraefikCone,
} from "lucide-react";
// Contour (#233).
import {
  KeySquare as ContourKeySquare,
  Milestone as ContourMilestone,
  MountainSnow as ContourMountainSnow,
  Plug as ContourPlug,
} from "lucide-react";
// Knative Eventing (#234).
import {
  Antenna as EventingAntenna,
  Cable as EventingCable,
  Inbox as EventingInbox,
  Link2 as EventingLink,
  ListFilter as EventingListFilter,
  ListOrdered as EventingListOrdered,
  RadioTower as EventingRadioTower,
  Split as EventingSplit,
  Timer as EventingTimer,
  Zap as EventingZap,
} from "lucide-react";

import {
  CalendarClock as ArgoCalendarClock,
  ChevronLast as ArgoChevronLast,
  ChevronsRight as ArgoChevronsRight,
  FileCode as ArgoFileCode,
  Files as ArgoFiles,
  FlaskConical as ArgoFlaskConical,
  Microscope as ArgoMicroscope,
  OctagonX as ArgoOctagonX,
  Rocket as ArgoRocket,
  RotateCcw as ArgoRotateCcw,
  TestTube as ArgoTestTube,
  TestTubes as ArgoTestTubes,
  Workflow as ArgoWorkflow,
} from "lucide-react";
// External Secrets, CloudNativePG, Strimzi and Prometheus Operator (#213).
import {
  BellRing as PromBellRing,
  Cable as KafkaCable,
  CalendarClock as CnpgCalendarClock,
  ChartLine as PromChartLine,
  CloudUpload as EsoCloudUpload,
  Combine as CnpgCombine,
  Cylinder as CnpgCylinder,
  Database as CnpgDatabase,
  DatabaseBackup as CnpgDatabaseBackup,
  FileKey as EsoFileKey,
  Flame as PromFlame,
  FolderKey as EsoFolderKey,
  MessagesSquare as KafkaMessagesSquare,
  RadioTower as KafkaRadioTower,
  Radar as PromRadar,
  Repeat2 as KafkaRepeat,
  ScanEye as PromScanEye,
  ScrollText as PromScrollText,
  ServerCog as KafkaServerCog,
  Telescope as PromTelescope,
  UsersRound as KafkaUsersRound,
  Vault as EsoVault,
  Waves as KafkaWaves,
} from "lucide-react";
import {
  File as ImageFile,
  FileSymlink as ImageFileSymlink,
  Folder as ImageFolder,
  FolderSearch as ImageFolderSearch,
} from "lucide-react";

const ICONS = {
  // Actions on resources and the glyphs they replace.
  logs: ScrollText, // ≡
  shell: SquareTerminal, // >_
  portForward: ArrowLeftRight, // ⇄
  edit: Pencil, // ✎
  delete: Trash2, // ×
  scale: ArrowUpDown, // ↕
  restart: RotateCw, // ↻
  cordon: Ban, // ⊘
  drain: ArrowDownToLine, // ⇣
  trigger: Play, // ▶
  suspend: Pause, // ⏸
  resume: Play, // ▶
  reconcile: RefreshCw, // ↻ (Flux)
  reconcileWithSource: RefreshCcwDot, // ⟳ (Flux)
  sync: RefreshCcw, // ⟳ (Argo CD)
  refresh: RefreshCw, // ↻
  hardRefresh: RotateCcw, // ↺
  terminate: Square, // ■
  external: ExternalLink, // ↗
  diff: Diff, // ±
  rollback: History,
  // Controls.
  more: EllipsisVertical, // ⋮
  close: X, // ×
  chevronDown: ChevronDown, // ▾
  chevronUp: ChevronUp, // ▴
  chevronRight: ChevronRight, // ▸
  sortAsc: ArrowUp, // ▲
  sortDesc: ArrowDown, // ▼
  settings: Settings, // ⚙ (also the Settings section)
  menu: Menu, // ☰
  add: Plus, // +
  warning: TriangleAlert, // !
  download: Download,
  eye: Eye,
  eyeOff: EyeOff,
  copy: Copy,
  agent: Bot, // AI agents (MCP)
  // Cluster rail.
  expandRail: PanelLeftOpen,
  collapseRail: PanelLeftClose,
  image: ImagePlus,
  reset: RotateCcw,
  // Sidebar sections.
  cluster: LayoutDashboard,
  nodes: Server,
  workloads: Boxes,
  config: SlidersHorizontal,
  network: Network,
  gatewayApi: Split,
  storage: HardDrive,
  namespaces: FolderTree,
  events: Bell,
  helm: Ship,
  accessControl: ShieldCheck,
  flux: Waves,
  argocd: GitBranch,
  customResources: Puzzle,
  certManager: BadgeCheck,
  // Sidebar entries.
  overview: Gauge,
  /** The overview of several clusters (the rail's "All clusters"). */
  fleet: Grid2x2,
  node: Server,
  namespace: Folder,
  pod: Box,
  deployment: Layers,
  daemonSet: Copy,
  statefulSet: Database,
  replicaSet: Layers2,
  job: Play,
  cronJob: Clock,
  configMap: FileText,
  secret: KeyRound,
  resourceQuota: ChartPie,
  limitRange: Ruler,
  horizontalPodAutoscaler: TrendingUp,
  podDisruptionBudget: ShieldAlert,
  priorityClass: ArrowUpNarrowWide,
  service: Waypoints,
  endpoints: Cable,
  ingress: Globe,
  ingressClass: Signpost,
  networkPolicy: BrickWall,
  connectivity: ArrowLeftRight,
  portForwarding: ArrowLeftRight,
  persistentVolumeClaim: HardDrive,
  persistentVolume: Disc,
  storageClass: Archive,
  serviceAccount: UserCog,
  clusterRole: Shield,
  role: ShieldHalf,
  clusterRoleBinding: Link,
  roleBinding: Link2,
  helmChart: Package,
  helmRelease: Rocket,
  customResource: Puzzle,
  customResourceDefinition: FileCode,
  gitRepository: GitFork,
  ociRepository: Container,
  helmRepository: Anchor,
  fluxHelmChart: Package,
  bucket: Cylinder,
  kustomization: FileStack,
  fluxHelmRelease: Rocket,
  imageRepository: Images,
  imagePolicy: FileCheck,
  imageUpdateAutomation: Bot,
  alert: BellRing,
  provider: Send,
  receiver: Webhook,
  argoApplication: AppWindow,
  argoApplicationSet: LayoutGrid,
  argoAppProject: FolderKanban,
  gatewayClass: Landmark,
  gateway: DoorOpen,
  httpRoute: Route,
  grpcRoute: RadioTower,
  tlsRoute: GlobeLock,
  tcpRoute: Plug,
  udpRoute: Rss,
  referenceGrant: Handshake,
  backendTlsPolicy: FileLock,
  gatewayPolicies: Scale,
  requestCheck: Crosshair,
  // cert-manager (src/features/cert-manager) and TLS certificates of Secrets.
  certificate: FileBadge,
  certificateRequest: FileKey,
  issuer: Stamp,
  clusterIssuer: Award,
  acmeOrder: ScrollText,
  acmeChallenge: TicketCheck,
  tlsCertificates: LockKeyhole,
  // Security posture (src/features/security): the page, the Trivy section and its report kinds (namespaced and
  // cluster-wide kinds of one report share an icon).
  securityPosture: ShieldEllipsis,
  trivy: ScanSearch,
  trivyVulnerabilities: Bug,
  trivyConfigAudit: ClipboardCheck,
  trivySecrets: KeySquare,
  trivyRbac: UserCheck,
  trivyInfra: ServerCog,
  trivyCompliance: ListChecks,
  trivySbom: PackageSearch,
  // Upgrade readiness (src/features/upgrade): the page of the Cluster section.
  upgradeReadiness: CircleArrowUp,
  // Change timeline (src/features/timeline): the page of the Cluster section.
  changeTimeline: ChartNoAxesGantt,
  // Cleanup (src/features/hygiene): the page of the Cluster section.
  cleanup: BrushCleaning,
  // Best practices (src/features/practices): the page of the Cluster section.
  bestPractices: ClipboardList,
  // Cost (src/features/cost): the page of the Cluster section.
  cost: Coins,
  // Autoscaling insights (src/features/autoscaling): the KEDA and Karpenter sections and their kinds.
  keda: Zap,
  karpenter: Hammer,
  scaledObject: TrendingUp,
  scaledJob: Play,
  triggerAuthentication: KeySquare,
  nodePool: ServerCog,
  nodeClaim: Server,
  nodeClass: Cpu,
  // Saved views, pins and workspaces (#149).
  savedView: ViewsBookmark,
  saveView: ViewsBookmarkPlus,
  workspace: ViewsBriefcase,
  columns: ViewsColumns,
  pin: ViewsPin,
  unpin: ViewsPinOff,
  upload: ViewsUpload,
  // Storage insights (src/features/storage): the VolumeSnapshots and Velero sections, their kinds and actions.
  volumeSnapshots: StorageCamera,
  volumeSnapshot: StorageCamera,
  volumeSnapshotClass: StorageAperture,
  volumeSnapshotContent: StorageHardDriveUpload,
  restoreSnapshot: StorageArchiveRestore,
  velero: StorageDatabaseBackup,
  veleroBackup: StorageDatabaseBackup,
  veleroSchedule: StorageCalendarClock,
  veleroRestore: StorageArchiveRestore,
  veleroLocation: StorageMapPinned,
  // Service mesh (#155).
  istio: MeshSailboat,
  linkerd: MeshLink,
  meshRoute: MeshSignpost,
  meshDestination: Waypoints,
  meshServiceEntry: MeshGlobe,
  meshMtls: MeshLock,
  meshJwt: MeshKeyRound,
  meshAuthz: MeshShieldCheck,
  // Knative Serving, Crossplane and Kyverno (#213).
  knative: KnativeCloudCog,
  knativeRevision: KnativeGitCommit,
  knativeRoute: KnativeRoute,
  knativeDomain: KnativeGlobe,
  // Traefik (#232).
  traefik: TraefikCone,
  traefikRoute: TraefikShuffle,
  traefikMiddleware: TraefikCombine,
  traefikService: TraefikSplit,
  // Contour (#233).
  contour: ContourMountainSnow,
  contourProxy: ContourMilestone,
  contourDelegation: ContourKeySquare,
  contourExtension: ContourPlug,
  // Knative Eventing (#234).
  knativeEventing: EventingZap,
  knativeBroker: EventingRadioTower,
  knativeTrigger: EventingListFilter,
  knativeChannel: EventingCable,
  knativeSubscription: EventingInbox,
  knativeSequence: EventingListOrdered,
  knativeParallel: EventingSplit,
  knativeSource: EventingAntenna,
  knativePingSource: EventingTimer,
  knativeSinkBinding: EventingLink,
  crossplane: CrossplaneLayers,
  crossplaneXrd: CrossplaneFileCog,
  crossplaneComposition: CrossplaneBlocks,
  crossplanePackage: CrossplanePackage,
  crossplaneFunction: CrossplaneFunction,
  crossplaneComposites: CrossplaneGitFork,
  kyverno: KyvernoShieldHalf,
  kyvernoPolicy: KyvernoGavel,
  kyvernoReport: KyvernoClipboardCheck,
  // Argo Rollouts and Argo Workflows (#213): their sections, kinds and the rollout actions.
  argoRollouts: ArgoRocket,
  argoRollout: ArgoRocket,
  argoAnalysisRun: ArgoFlaskConical,
  argoAnalysisTemplate: ArgoTestTube,
  argoClusterAnalysisTemplate: ArgoTestTubes,
  argoExperiment: ArgoMicroscope,
  rolloutPromote: ArgoChevronsRight,
  rolloutPromoteFull: ArgoChevronLast,
  rolloutAbort: ArgoOctagonX,
  rolloutRetry: ArgoRotateCcw,
  argoWorkflows: ArgoWorkflow,
  argoWorkflow: ArgoWorkflow,
  argoCronWorkflow: ArgoCalendarClock,
  argoWorkflowTemplate: ArgoFileCode,
  argoClusterWorkflowTemplate: ArgoFiles,
  // External Secrets, CloudNativePG, Strimzi and Prometheus Operator (#213): their sections and kinds.
  externalSecrets: EsoFolderKey,
  externalSecret: EsoFileKey,
  secretStore: EsoVault,
  pushSecret: EsoCloudUpload,
  cnpg: CnpgDatabase,
  postgresCluster: CnpgCylinder,
  postgresBackup: CnpgDatabaseBackup,
  postgresScheduledBackup: CnpgCalendarClock,
  postgresPooler: CnpgCombine,
  strimzi: KafkaWaves,
  kafka: KafkaRadioTower,
  kafkaNodePool: KafkaServerCog,
  kafkaTopic: KafkaMessagesSquare,
  kafkaUser: KafkaUsersRound,
  kafkaConnect: KafkaCable,
  kafkaMirror: KafkaRepeat,
  kafkaConnector: Plug,
  prometheusOperator: PromFlame,
  serviceMonitor: PromRadar,
  podMonitor: PromScanEye,
  probe: PromTelescope,
  prometheusRule: PromScrollText,
  prometheus: PromChartLine,
  alertmanager: PromBellRing,
  // Image file viewer (#216): the page and the entries of an image's tree.
  imageFiles: ImageFolderSearch,
  imageFolder: ImageFolder,
  imageFile: ImageFile,
  imageSymlink: ImageFileSymlink,
} satisfies Record<string, LucideIcon>;

/** Name of an icon of the set. */
export type IconName = keyof typeof ICONS;

export interface IconProps {
  name: IconName;
  /** Pixels; default `var(--icon-size)` (16 px). */
  size?: number;
  className?: string;
}

/** An SVG icon of the set, in `currentColor`, hidden from assistive technology. */
export function Icon({ name, size, className }: IconProps) {
  const Svg = ICONS[name];
  const side = size === undefined ? "var(--icon-size)" : `${size}px`;
  return (
    <Svg
      aria-hidden
      focusable={false}
      className={className ? `icon ${className}` : "icon"}
      style={{ width: side, height: side }}
    />
  );
}

export function isIconName(spec: string): spec is IconName {
  return Object.hasOwn(ICONS, spec);
}

/** `name` as an SVG icon; `undefined` → nothing. */
export function renderIcon(name: IconName | undefined, size?: number): ReactNode {
  if (name === undefined) return null;
  return <Icon name={name} size={size} />;
}
