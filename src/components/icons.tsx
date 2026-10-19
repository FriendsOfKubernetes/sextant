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
  Clock,
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
