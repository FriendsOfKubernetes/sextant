// "Composite Resources" (the manifest's page `composites` in the section `crossplane`), as the built-in page drew it:
// every claim and composite of the kinds the XRDs define (at most `MAX_XRDS` XRDs, by name), with Synced, Ready and
// the first failing condition, problems first; "Only problems" leaves the rest out. While the page shows, the XRDs
// are watched where the cluster serves them, then the composite and claim kinds of each that discovery says the
// cluster serves, in every namespace, each kept to `MAX_ROWS` objects by the core (a capped list counts as cut). A kind
// an XRD defines that discovery does not list yet is looked up again a second after the XRDs change (a new XRD's
// kinds are served once it is established), and so is every kind when the cluster's kinds change (the context's
// `kindsVersion`), as the built-in page followed discovery. Read-only.
import { trackObjects, ui, type KubeObject, type ResourceKind, type Sextant, type Watch } from "@sextant/extension-sdk";
import { conditionText, element, link, remark } from "./dom";
import { t } from "./i18n";
import { byState, HEALTH_TONE, MAX_ROWS, MAX_SHOWN, MAX_XRDS, parseXrd, toRow, XRD, type KindRef, type Role, type Row, type XrdInfo } from "./model";

/** How long after the XRDs change a kind they define that discovery does not list is looked up again. */
export const KINDS_REFRESH_MS = 1000;

/** A list watched while the page shows. */
interface Listed {
  kind: KindRef;
  role: Role;
  watch: Watch;
  items: KubeObject[];
  loading: boolean;
  /** How many match in all, when the core kept fewer. */
  total: number | null;
}

/** What the page shows. */
export interface PageState {
  /** Discovery or a list has not come yet. */
  loading: boolean;
  /** The cluster serves XRDs. */
  served: boolean;
  xrds: XrdInfo[];
  /** More XRDs than `MAX_XRDS`: the kinds of the others are not watched. */
  xrdsTruncated: boolean;
  rows: Row[];
  rowsTruncated: boolean;
}

/** The page drawn from its state; `onlyProblems` leaves out what is not failed. */
export function pageView(sextant: Sextant, state: PageState, onlyProblems: boolean, setOnlyProblems: (on: boolean) => void): HTMLElement {
  const rows = state.rows.filter((r) => !onlyProblems || r.health === "failed").sort(byState);
  const shown = rows.slice(0, MAX_SHOWN);
  const checkbox = ui.checkbox(t("page.onlyProblems"), setOnlyProblems, { checked: onlyProblems });
  const total = element("span", { className: "xp-muted", textContent: t("page.total", { count: rows.length }) });
  total.setAttribute("role", "status");
  const table =
    shown.length > 0
      ? ui.table(
          ["kind", "name", "namespace", "state", "synced", "ready", "reason", "composition"].map((h) => t(`page.columns.${h}`)),
          shown.map((row) => [
            t(`page.kindWithRole.${row.role}`, { kind: row.ref.kind.kind }),
            link(sextant, row.ref.kind, row.ref.name, row.ref.namespace),
            row.ref.namespace ?? "",
            ui.status(t(`health.${row.health}`), HEALTH_TONE[row.health]),
            conditionText(row.synced),
            conditionText(row.ready),
            element("span", { className: "xp-table__names" }, row.failing?.reason ?? "", row.failing?.message ? element("div", { className: "xp-message", textContent: row.failing.message }) : null),
            row.composition ?? "",
          ]),
          // Columns the user resizes, kept by Sextant as the built-in page kept them (by position).
          { label: t("page.title"), id: "composites", sextant },
        )
      : null;
  return element(
    "div",
    { className: "xp-page" },
    element("h2", { className: "xp-page__title", textContent: t("page.title") }),
    remark(t("page.hint")),
    element("div", { className: "xp-page__toolbar" }, checkbox, !state.loading && total),
    state.loading && state.served && ui.loading(t("page.loading")),
    state.xrdsTruncated && remark(t("page.xrdsTruncated", { count: MAX_XRDS })),
    (state.rowsTruncated || rows.length > shown.length) && remark(t("page.rowsTruncated", { count: shown.length })),
    !state.loading && rows.length === 0 && remark(t(state.xrds.length === 0 ? "page.noXrds" : "page.none")),
    table,
  );
}

const kindKey = (kind: Pick<KindRef, "group" | "kind">) => `${kind.group}/${kind.kind}`;

/** Starts the page on the context's cluster; returns the function that stops its watches. */
export function startPage(sextant: Sextant, root: HTMLElement): () => void {
  let stopped = false;
  let onlyProblems = false;
  /** The kinds discovery lists, by group and kind; `undefined` until it answers, `null` when it cannot. */
  let served: Map<string, KindRef> | null | undefined;
  let xrdWatch: Watch | null = null;
  let xrdItems: KubeObject[] = [];
  let xrdsLoading = true;
  const lists = new Map<string, Listed>();
  let refresh: ReturnType<typeof setTimeout> | undefined;
  let scheduled = false;

  const xrdsOf = (): { xrds: XrdInfo[]; truncated: boolean } => {
    const all = xrdItems
      .map(parseXrd)
      .filter((x): x is XrdInfo => x !== undefined)
      .sort((a, b) => a.name.localeCompare(b.name));
    return { xrds: all, truncated: all.length > MAX_XRDS };
  };

  const stateOf = (): PageState => {
    const xrdKind = served ? served.get(kindKey(XRD)) : undefined;
    const { xrds, truncated } = xrdsOf();
    const watched = [...lists.values()];
    const loading = served === undefined || (xrdKind !== undefined && xrdsLoading) || watched.some((l) => l.loading);
    const rows: Row[] = [];
    let rowsTruncated = watched.some((l) => l.total !== null && l.total > l.items.length);
    for (const list of watched) {
      for (const obj of list.items) {
        if (rows.length >= MAX_ROWS) {
          rowsTruncated = true;
          break;
        }
        rows.push(toRow(obj, list.kind, list.role));
      }
    }
    return { loading, served: xrdKind !== undefined, xrds, xrdsTruncated: truncated, rows, rowsTruncated };
  };

  const render = () => {
    if (stopped) return;
    root.replaceChildren(
      pageView(sextant, stateOf(), onlyProblems, (on) => {
        onlyProblems = on;
        render();
        root.querySelector<HTMLInputElement>('input[type="checkbox"]')?.focus();
      }),
    );
  };
  const schedule = () => {
    if (scheduled || stopped) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      render();
    });
  };

  const askKinds = () => {
    void sextant
      .kinds()
      .then((kinds: ResourceKind[]) => new Map(kinds.map((k) => [kindKey(k.kindRef), k.kindRef] as const)))
      .catch(() => null)
      .then((known) => {
        if (stopped) return;
        served = known;
        sync(false);
        schedule();
      });
  };

  /**
   * Watches the XRDs and the served kinds of the first `MAX_XRDS` of them; lets go of the others. After the XRDs
   * changed (`xrdsChanged`), a kind they define that discovery does not list makes it look again.
   */
  const sync = (xrdsChanged: boolean) => {
    if (stopped || served === undefined) return;
    const xrdKind = served?.get(kindKey(XRD));
    if (!xrdKind) {
      // Not served (any more): nothing is watched.
      xrdsLoading = false;
      void xrdWatch?.unwatch().catch(() => undefined);
      xrdWatch = null;
      xrdItems = [];
      for (const list of lists.values()) void list.watch.unwatch().catch(() => undefined);
      lists.clear();
      return;
    }
    if (!xrdWatch) {
      xrdWatch = sextant.resources.watch(
        { kind: xrdKind },
        {
          onUpdate: trackObjects(
            (items) => {
              xrdItems = items;
              xrdsLoading = false;
              sync(true);
              schedule();
            },
            (other) => {
              if (other.type !== "error" && other.type !== "forbidden") return;
              xrdsLoading = false;
              schedule();
            },
          ),
          onError: () => {
            xrdsLoading = false;
            schedule();
          },
        },
      );
      xrdWatch.started.catch(() => undefined);
    }
    const wanted = new Map<string, { kind: KindRef; role: Role }>();
    let unlisted = false;
    for (const x of xrdsOf().xrds.slice(0, MAX_XRDS)) {
      for (const [kind, role] of [
        [x.composite, "composite"],
        [x.claim, "claim"],
      ] as const) {
        if (!kind) continue;
        const kindRef = served?.get(kindKey(kind));
        if (!kindRef) {
          unlisted = true;
          continue;
        }
        wanted.set(kindKey(kindRef), { kind: kindRef, role });
      }
    }
    for (const [key, list] of [...lists]) {
      if (wanted.has(key) && wanted.get(key)!.role === list.role) continue;
      void list.watch.unwatch().catch(() => undefined);
      lists.delete(key);
    }
    for (const [key, { kind, role }] of wanted) {
      if (lists.has(key)) continue;
      const settle = () => {
        listed.loading = false;
        schedule();
      };
      const watch = sextant.resources.watch(
        { kind, maxObjects: MAX_ROWS },
        {
          onUpdate: trackObjects(
            (items) => {
              listed.items = items;
              settle();
            },
            (other) => {
              if (other.type === "error" || other.type === "forbidden") settle();
            },
          ),
          onCapped: (count) => {
            listed.total = count;
            schedule();
          },
          onError: settle,
        },
      );
      watch.started.catch(() => undefined);
      const listed: Listed = { kind, role, watch, items: [], loading: true, total: null };
      lists.set(key, listed);
    }
    if (xrdsChanged && unlisted && refresh === undefined) {
      refresh = setTimeout(() => {
        refresh = undefined;
        askKinds();
      }, KINDS_REFRESH_MS);
    }
  };

  render();
  askKinds();
  // The kinds the cluster serves changed (a CRD installed or removed): discovery is asked again.
  let kindsVersion = sextant.context.kindsVersion;
  const stopFollow = sextant.onContextChange((context) => {
    if (context.kindsVersion === kindsVersion) return;
    kindsVersion = context.kindsVersion;
    askKinds();
  });
  return () => {
    stopped = true;
    stopFollow();
    if (refresh !== undefined) clearTimeout(refresh);
    void xrdWatch?.unwatch().catch(() => undefined);
    for (const list of lists.values()) void list.watch.unwatch().catch(() => undefined);
    lists.clear();
  };
}

