// The details sections of the manifest's `contributes.detailsSections`:
//   crossplane          — XRDs, Compositions, Providers, Configurations and Functions (order 20, in place of the generic
//                         fields): one block titled with the kind;
//   crossplane-resource — every kind (order 21): claims and composites, told by the XRDs (their kinds), and managed
//                         resources, told by their shape (`spec.forProvider` or `spec.providerConfigRef`). The section
//                         starts hidden and shows only on such an object; on a kind that cannot be Crossplane's (no dot
//                         in its group, a Kubernetes group, Crossplane's own kinds) it reads nothing at all.
// Each frame reads the shown object again whenever its resourceVersion changes. The XRDs are watched (one shared
// watch, only where the cluster serves them) while the fields block is open, or the chain block is and the object is
// known to be a claim or composite, as the built-in probe did; the chain's objects are read once per change of the
// shown object (and of the claim's composite) while the chain block is open, at most `MAX_CHAIN` of them, each shown as
// it comes. The blocks
// open and close as Sextant remembers them (`context.blocks`, `ui.setBlockOpen`). Read-only (ADR-0101).
import { isSextantError, trackObjects, ui, type KubeObject, type ObjectRef, type Sextant, type Watch } from "@sextant/extension-sdk";
import { BlockMemory, errorText, redraw } from "./dom";
import { t } from "./i18n";
import { crossplaneKind, looksManaged, mayBeCrossplaneResource, objectRefOf, parseXrd, resourceRefOf, resourceRefsOf, roleOf, sameKind, str, XRD, type KindRef, type Role, type XrdInfo } from "./model";
import { CHAIN_BLOCK, claimOrCompositeView, FIELDS_BLOCK, kindSection, managedView, MAX_CHAIN, refKey, unknownView, type Chain, type Fetched } from "./views";

/** The section on Crossplane's own kinds. */
export const KINDS_SECTION = "crossplane";
/** The section on every kind: claims, composites and managed resources. */
export const RESOURCE_SECTION = "crossplane-resource";

/** What the XRD watch says: still coming, the cluster serves none, cannot tell, or the XRDs. */
type XrdAnswer = { state: "pending" } | { state: "absent" } | { state: "unknown"; error: string } | { state: "ready"; xrds: XrdInfo[] };

/** One reading of named objects, by a key of the refs and what they are read for. */
interface Reading {
  key: string;
  byKey: Map<string, Fetched>;
  done: boolean;
}

/** Objects read at a time, as the built-in chain read them. */
export const CONCURRENCY = 4;

/**
 * Reads named objects once per key, `CONCURRENCY` at a time with `resources.get` as the built-in chain did, each shown
 * as it comes; the last reading stays until the next one's first object lands.
 */
class Reader {
  private reading: Reading = { key: "", byKey: new Map(), done: true };

  constructor(
    private readonly sextant: Sextant,
    private readonly changed: () => void,
  ) {}

  want(refs: readonly ObjectRef[], stamp: string): { byKey: ReadonlyMap<string, Fetched>; loading: boolean } {
    const wanted = refs.slice(0, MAX_CHAIN);
    const key = JSON.stringify([wanted.map(refKey), stamp]);
    if (key !== this.reading.key) this.read(key, wanted);
    return { byKey: this.reading.byKey, loading: !this.reading.done };
  }

  private read(key: string, refs: ObjectRef[]): void {
    const previous = this.reading.byKey;
    this.reading = { key, byKey: previous, done: refs.length === 0 };
    if (refs.length === 0) {
      this.reading.byKey = new Map();
      return;
    }
    const reading = this.reading;
    const found = new Map<string, Fetched>();
    let next = 0;
    const worker = async () => {
      while (this.reading === reading && next < refs.length) {
        const ref = refs[next++]!;
        let fetched: Fetched;
        try {
          fetched = { obj: await this.sextant.resources.get({ ref }) };
        } catch (err) {
          fetched = { error: { code: isSextantError(err) ? err.code : "other", message: errorText(err) } };
        }
        if (this.reading !== reading) return;
        found.set(refKey(ref), fetched);
        reading.byKey = new Map(found);
        reading.done = found.size === refs.length;
        this.changed();
      }
    };
    for (let i = 0; i < Math.min(CONCURRENCY, refs.length); i++) void worker();
  }

  stop(): void {
    this.reading = { key: "", byKey: new Map(), done: true };
  }
}

/**
 * The XRDs, watched while wanted, only where the cluster serves them (discovery asked when first wanted and again when
 * the cluster's kinds change).
 */
class Xrds {
  private served: { state: "unasked" } | { state: "asking" } | { state: "known"; kind: KindRef | null } | { state: "unknown"; error: string } = { state: "unasked" };
  private watch: Watch | null = null;
  answer: XrdAnswer = { state: "pending" };

  constructor(
    private readonly sextant: Sextant,
    private readonly changed: () => void,
  ) {}

  want(on: boolean): XrdAnswer {
    if (!on) {
      this.unwatch();
      return this.answer;
    }
    if (this.served.state === "unasked") {
      this.served = { state: "asking" };
      void this.sextant
        .kinds()
        .then(
          (kinds) => ({ state: "known" as const, kind: kinds.find((k) => sameKind(k.kindRef, XRD))?.kindRef ?? null }),
          (err: unknown) => ({ state: "unknown" as const, error: errorText(err) }),
        )
        .then((served) => {
          this.served = served;
          if (served.state === "unknown") this.answer = { state: "unknown", error: served.error };
          else if (served.kind === null) this.answer = { state: "absent" };
          this.changed();
        });
      return this.answer;
    }
    if (this.served.state !== "known" || this.served.kind === null || this.watch) return this.answer;
    const settle = (answer: XrdAnswer) => {
      this.answer = answer;
      this.changed();
    };
    this.watch = this.sextant.resources.watch(
      { kind: this.served.kind },
      {
        onUpdate: trackObjects(
          (items) => settle({ state: "ready", xrds: items.map(parseXrd).filter((x): x is XrdInfo => x !== undefined) }),
          (other) => {
            if (other.type === "error") settle({ state: "unknown", error: other.message });
            if (other.type === "forbidden") settle({ state: "unknown", error: t("chain.unreadable") });
          },
        ),
        onError: (err) => settle({ state: "unknown", error: errorText(err) }),
      },
    );
    this.watch.started.catch(() => undefined);
    return this.answer;
  }

  /** The kinds the cluster serves changed: discovery is asked again; what the XRDs said stands meanwhile. */
  rediscover(): void {
    this.unwatch();
    this.served = { state: "unasked" };
  }

  private unwatch(): void {
    if (!this.watch) return;
    void this.watch.unwatch().catch(() => undefined);
    this.watch = null;
  }

  /** Another object: discovery and the XRDs are asked again. */
  stop(): void {
    this.unwatch();
    this.served = { state: "unasked" };
    this.answer = { state: "pending" };
  }
}

/**
 * Starts the details section `contribution` on the object in the context. Its blocks open and close as Sextant
 * remembers them: a toggle is written there and draws the section again (the focus stays on the toggle), and the
 * section follows the panel's "Expand all" and "Collapse all".
 */
export function startDetails(sextant: Sextant, root: HTMLElement, contribution: string): () => void {
  const resourceSection = contribution === RESOURCE_SECTION;
  let shownRef: string | null = null;
  let shownVersion: string | null | undefined;
  let reading = 0;
  let object: KubeObject | null = null;
  let objectRef: ObjectRef | null = null;
  let readError: string | null = null;
  /** The role last told by the XRDs, kept while they are not watched. */
  let knownRole: Role | undefined;
  let scheduled = false;
  let stopped = false;
  let hidden = resourceSection;

  const setHidden = (value: boolean) => {
    if (!resourceSection || value === hidden) return;
    hidden = value;
    void sextant.ui.setHidden(value).catch(() => undefined);
  };

  const schedule = () => {
    if (scheduled || stopped) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      render();
    });
  };
  const memory = new BlockMemory(sextant, schedule);
  const xrds = new Xrds(sextant, schedule);
  const upper = new Reader(sextant, schedule);
  const lower = new Reader(sextant, schedule);

  /** The chain of a claim or composite, read while its block is open. */
  const chainOf = (obj: KubeObject, role: Role): Chain => {
    const open = memory.peek(CHAIN_BLOCK);
    const stamp = str(obj.metadata.resourceVersion) ?? "";
    const target = role === "claim" ? resourceRefOf(obj) : undefined;
    const compositeRef = target ? objectRefOf(target, obj.metadata.namespace ?? null) : undefined;
    const up = upper.want(open && compositeRef ? [compositeRef] : [], stamp);
    const fetched = compositeRef ? up.byKey.get(refKey(compositeRef)) : undefined;
    const composite = role === "composite" ? obj : fetched && "obj" in fetched ? fetched.obj : undefined;
    const refs = composite ? resourceRefsOf(composite).map((r) => objectRefOf(r, composite.metadata.namespace ?? null)) : [];
    const down = lower.want(open ? refs : [], `${stamp}|${str(composite?.metadata.resourceVersion) ?? ""}`);
    return { compositeRef, refs, byKey: new Map([...up.byKey, ...down.byKey]), loading: up.loading || down.loading };
  };

  /** What the section on every kind shows for the object, or nothing. */
  const resourceNodes = (ref: ObjectRef, obj: KubeObject): Node[] | null => {
    const fieldsOpen = memory.peek(FIELDS_BLOCK);
    const chainOpen = memory.peek(CHAIN_BLOCK);
    const answer = xrds.want(fieldsOpen || (chainOpen && knownRole !== undefined));
    const watching = fieldsOpen || (chainOpen && knownRole !== undefined);
    if (watching && answer.state === "ready") knownRole = roleOf(ref.kind, answer.xrds);
    if (watching && answer.state === "absent") knownRole = undefined;
    const role = knownRole;
    if (role) return claimOrCompositeView(sextant, ref, obj, role, chainOf(obj, role), memory);
    if (looksManaged(obj)) return managedView(sextant, ref, obj, memory);
    if (watching && answer.state === "unknown") return unknownView(ref.kind.kind, answer.error, memory);
    return null;
  };

  const render = () => {
    if (stopped || !objectRef) return;
    if (readError !== null) {
      setHidden(false);
      redraw(root, [ui.errorState(readError)]);
      return;
    }
    if (!object) return;
    const nodes = resourceSection ? resourceNodes(objectRef, object) : kindSection(sextant, objectRef.kind, object, memory);
    if (!nodes) {
      setHidden(true);
      root.replaceChildren();
      return;
    }
    setHidden(false);
    redraw(root, nodes);
  };

  const read = async (ref: ObjectRef) => {
    const attempt = ++reading;
    try {
      const fresh = await sextant.resources.get({ ref });
      if (attempt !== reading || stopped) return;
      object = fresh;
      readError = null;
      render();
    } catch (err) {
      if (attempt !== reading || stopped) return;
      readError = errorText(err);
      render();
    }
  };

  let kindsVersion = sextant.context.kindsVersion;
  const follow = () => {
    const changedBlocks = memory.follow();
    // A CRD installed or removed: the XRDs' kind is looked up again, as the built-in section followed discovery.
    if (sextant.context.kindsVersion !== kindsVersion) {
      kindsVersion = sextant.context.kindsVersion;
      xrds.rediscover();
      schedule();
    }
    const ref = sextant.context.selection[0];
    if (!ref) {
      if (!resourceSection) root.replaceChildren(ui.empty(t("common.nothingSelected")));
      return;
    }
    // A kind that cannot be Crossplane's, or not the kinds of this section: nothing is read.
    if (resourceSection ? !mayBeCrossplaneResource(ref.kind) : !crossplaneKind(ref.kind)) {
      setHidden(true);
      return;
    }
    const key = JSON.stringify([ref.kind.group, ref.kind.kind, ref.namespace, ref.name]);
    if (key !== shownRef) {
      shownRef = key;
      shownVersion = undefined;
      object = null;
      objectRef = ref;
      readError = null;
      knownRole = undefined;
      memory.reset();
      xrds.stop();
      upper.stop();
      lower.stop();
      if (!resourceSection) root.replaceChildren(ui.loading(t("loading")));
    }
    const version = sextant.context.resourceVersion;
    if (version === shownVersion) {
      if (object && changedBlocks) schedule();
      return;
    }
    shownVersion = version;
    void read(ref);
  };
  follow();
  const stopFollow = sextant.onContextChange(follow);
  return () => {
    stopped = true;
    stopFollow();
    xrds.stop();
    upper.stop();
    lower.stop();
  };
}
