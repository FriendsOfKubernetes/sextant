// The app's icon set: SVG icons of `lucide-react` under the app's own names. Features use only these names
// (`IconName`) and never import `lucide-react` themselves, so the set can be swapped here in one place.
//
//   <Icon name="logs" />                    // 16 px (`--icon-size`), drawn in the text color, hidden from screen readers
//   renderIcon(action.icon)                 // an `IconName` → SVG, `undefined` → nothing
//
// An icon is decoration: the button it is in keeps its name as visible text or `aria-label`, so the SVG is
// `aria-hidden` and has no <title>. No trademark logos (Flux, Argo CD get icons close in meaning).
import type { ReactNode } from "react";
import { Funnel } from "lucide-react";
// Cluster API (#243): the section and its kinds.
import {
  Boxes as CapiBoxes,
  CloudCog as CapiCloudCog,
  HeartPulse as CapiHeartPulse,
  Layers2 as CapiLayers2,
  Layers3 as CapiLayers3,
  LayoutTemplate as CapiLayoutTemplate,
  PackagePlus as CapiPackagePlus,
  Server as CapiServer,
  ServerCog as CapiServerCog,
} from "lucide-react";
import {
  Anchor,
  AppWindow,
  Archive,
  ArrowDown,
  ArrowDownToLine,
  ArrowLeftRight,
  ArrowRightToLine,
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
  FolderLock as SealedFolderLock,
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
// k3s and RKE2 (#270).
import {
  BadgeInfo as K3sBadgeInfo,
  DatabaseZap as K3sDatabaseZap,
  FileInput as K3sFileInput,
  FileSliders as K3sFileSliders,
  PackageCheck as K3sPackageCheck,
  ShipWheel as K3sShipWheel,
  Tractor as K3sTractor,
} from "lucide-react";
// Dynamic Resource Allocation (#244) and NVIDIA GPU Operator (#245).
import {
  CircuitBoard as DraCircuitBoard,
  FileCog as GpuFileCog,
  Gpu as GpuGpu,
  LayoutGrid as DraLayoutGrid,
  MemoryStick as GpuMemoryStick,
  Microchip as DraMicrochip,
  PcCase as GpuPcCase,
  Shapes as DraShapes,
  TicketCheck as DraTicketCheck,
  Tickets as DraTickets,
} from "lucide-react";
// Kueue (#246) and JobSet (#247).
import {
  ArrowUpWideNarrow as KueueArrowUpWideNarrow,
  Group as KueueGroup,
  Hourglass as KueueHourglass,
  ListOrdered as KueueListOrdered,
  ListTodo as KueueListTodo,
  Rows3 as KueueRows3,
  ShieldCheck as KueueShieldCheck,
  SquareStack as JobSetSquareStack,
  Tags as KueueTags,
} from "lucide-react";
// Vertical Pod Autoscaler (#242).
import { ChevronsUpDown as VpaChevronsUpDown, HardDriveDownload as VpaCheckpoint, UnfoldVertical as VpaUnfoldVertical } from "lucide-react";
// KubeRay (#248) and KServe (#249).
import { Orbit as RayOrbit, Rocket as RayRocket, SatelliteDish as RaySatelliteDish, Sun as RaySun } from "lucide-react";
import {
  Brain as KServeBrain,
  BrainCircuit as KServeBrainCircuit,
  Cpu as KServeCpu,
  GraduationCap as KServeGraduationCap,
  MemoryStick as KServeMemoryStick,
  Workflow as KServeWorkflow,
} from "lucide-react";
// Operator Lifecycle Manager (#268).
import {
  BadgeCheck as OlmBadgeCheck,
  Blocks as OlmBlocks,
  BookMarked as OlmBookMarked,
  ClipboardList as OlmClipboardList,
  Library as OlmLibrary,
  LibraryBig as OlmLibraryBig,
  PackageCheck as OlmPackageCheck,
  Puzzle as OlmPuzzle,
  UsersRound as OlmUsersRound,
} from "lucide-react";
// OpenShift (#267).
import {
  Construction as OsConstruction,
  FolderKanban as OsFolderKanban,
  Hammer as OsHammer,
  Hexagon as OsHexagon,
  Images as OsImages,
  RefreshCcwDot as OsRefreshCcwDot,
  Signpost as OsSignpost,
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
  portForward: ArrowRightToLine, // →|
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
  filter: Funnel,
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
  portForwarding: ArrowRightToLine,
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
  // Sealed Secrets (#240): the section and its kind.
  sealedSecrets: SealedFolderLock,
  sealedSecret: FileLock,
  cnpg: CnpgDatabase,
  postgresCluster: CnpgCylinder,
  postgresBackup: CnpgDatabaseBackup,
  postgresScheduledBackup: CnpgCalendarClock,
  postgresPooler: CnpgCombine,
  // Cluster API (#243): the section and its kinds.
  clusterApi: CapiCloudCog,
  capiCluster: CapiBoxes,
  capiClusterClass: CapiLayoutTemplate,
  capiControlPlane: CapiServerCog,
  capiMachineDeployment: CapiLayers3,
  capiMachineSet: CapiLayers2,
  capiMachine: CapiServer,
  capiHealthCheck: CapiHeartPulse,
  capiResourceSet: CapiPackagePlus,
  // Kueue (#246): the section and its kinds.
  kueue: KueueListTodo,
  kueueClusterQueue: KueueRows3,
  kueueLocalQueue: KueueListOrdered,
  kueueWorkload: KueueHourglass,
  kueueResourceFlavor: KueueTags,
  kueueCohort: KueueGroup,
  kueueAdmissionCheck: KueueShieldCheck,
  kueuePriorityClass: KueueArrowUpWideNarrow,
  // JobSet (#247): the section and its kind.
  jobset: JobSetSquareStack,
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
  // Vertical Pod Autoscaler (#242): the section and its kinds.
  vpa: VpaUnfoldVertical,
  verticalPodAutoscaler: VpaChevronsUpDown,
  vpaCheckpoint: VpaCheckpoint,
  // KubeRay (#248): the section and its kinds.
  kuberay: RaySun,
  rayCluster: RayOrbit,
  rayJob: RayRocket,
  rayService: RaySatelliteDish,
  // KServe (#249): the section and its kinds.
  kserve: KServeBrainCircuit,
  inferenceService: KServeBrain,
  servingRuntime: KServeCpu,
  clusterServingRuntime: KServeMemoryStick,
  inferenceGraph: KServeWorkflow,
  trainedModel: KServeGraduationCap,
  // Dynamic Resource Allocation (#244): the section, its kinds and the devices page.
  dra: DraMicrochip,
  resourceClaim: DraTicketCheck,
  resourceClaimTemplate: DraTickets,
  deviceClass: DraShapes,
  resourceSlice: DraCircuitBoard,
  draDevices: DraLayoutGrid,
  // NVIDIA GPU Operator (#245): the section, its kinds and the GPU nodes page.
  gpuOperator: GpuGpu,
  clusterPolicy: GpuFileCog,
  nvidiaDriver: GpuPcCase,
  gpuNodes: GpuMemoryStick,
  // k3s and RKE2 (#270): the two sections, the Distribution page and the kinds.
  k3s: K3sTractor,
  k3sDistribution: K3sBadgeInfo,
  k3sAddon: K3sFileInput,
  etcdSnapshot: K3sDatabaseZap,
  helmController: K3sShipWheel,
  helmControllerChart: K3sPackageCheck,
  helmChartConfig: K3sFileSliders,
  // Operator Lifecycle Manager (#268): the section and its kinds.
  olm: OlmBlocks,
  olmSubscription: OlmBookMarked,
  olmCsv: OlmPackageCheck,
  olmInstallPlan: OlmClipboardList,
  olmCatalogSource: OlmLibraryBig,
  olmOperatorGroup: OlmUsersRound,
  olmOperator: OlmPuzzle,
  olmClusterExtension: OlmBadgeCheck,
  olmClusterCatalog: OlmLibrary,
  // OpenShift (#267): the section and its kinds.
  openshift: OsHexagon,
  openshiftRoute: OsSignpost,
  openshiftDeploymentConfig: OsRefreshCcwDot,
  openshiftBuildConfig: OsHammer,
  openshiftBuild: OsConstruction,
  openshiftImageStream: OsImages,
  openshiftProject: OsFolderKanban,
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
