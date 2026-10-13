// The app's icon set: SVG icons of `lucide-react` under the app's own names. Features use only these names
// (`IconName`) and never import `lucide-react` themselves, so the set can be swapped here in one place.
//
//   <Icon name="logs" />                    // 16 px (`--icon-size`), drawn in the text color, hidden from screen readers
//   renderIcon(action.icon)                 // an `IconName` → SVG, any other string → the glyph as text
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
  Ban,
  Bell,
  BellRing,
  Bot,
  Box,
  Boxes,
  BrickWall,
  Cable,
  ChartPie,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Clock,
  Container,
  Copy,
  Cylinder,
  Database,
  Diff,
  Disc,
  Download,
  EllipsisVertical,
  ExternalLink,
  Eye,
  EyeOff,
  FileCheck,
  FileCode,
  FileStack,
  FileText,
  Folder,
  FolderKanban,
  FolderTree,
  Gauge,
  GitBranch,
  GitFork,
  Globe,
  HardDrive,
  History,
  ImagePlus,
  Images,
  KeyRound,
  Layers,
  Layers2,
  LayoutDashboard,
  LayoutGrid,
  Link,
  Link2,
  Menu,
  Network,
  Package,
  PanelLeftClose,
  PanelLeftOpen,
  Pause,
  Pencil,
  Play,
  Plus,
  Puzzle,
  RefreshCcw,
  RefreshCcwDot,
  RefreshCw,
  Rocket,
  RotateCcw,
  RotateCw,
  Ruler,
  ScrollText,
  Send,
  Server,
  Settings,
  Shield,
  ShieldAlert,
  ShieldCheck,
  ShieldHalf,
  Ship,
  Signpost,
  SlidersHorizontal,
  Square,
  SquareTerminal,
  Trash2,
  TrendingUp,
  TriangleAlert,
  UserCog,
  Waves,
  Waypoints,
  Webhook,
  X,
  type LucideIcon,
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
  storage: HardDrive,
  namespaces: FolderTree,
  events: Bell,
  helm: Ship,
  accessControl: ShieldCheck,
  flux: Waves,
  argocd: GitBranch,
  customResources: Puzzle,
  // Sidebar entries.
  overview: Gauge,
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
} satisfies Record<string, LucideIcon>;

/** Name of an icon of the set. */
export type IconName = keyof typeof ICONS;

/** An icon name, or (for compatibility) a short text glyph drawn as text. */
export type IconSpec = IconName | (string & {});

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

/** `spec` as an SVG icon if it names one, otherwise as a hidden text glyph; `undefined` → nothing. */
export function renderIcon(spec: IconSpec | undefined, size?: number): ReactNode {
  if (spec === undefined) return null;
  if (isIconName(spec)) return <Icon name={spec} size={size} />;
  return (
    <span aria-hidden="true" className="icon-glyph">
      {spec}
    </span>
  );
}
