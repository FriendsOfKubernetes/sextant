// The schemas the editors of one cluster use (#151), shared by all of them (`schemaSourceFor`): fetched per
// apiVersion/kind on first need and kept (least recently used dropped), so a document checked once is still checked
// and completed when the cluster disconnects, and a second editor does not ask again.
// Only a kind the cluster's discovery serves is asked for, so a half-typed `kind: Deplo` is never fetched nor
// remembered. A kind with no schema is remembered until discovery changes (a CRD was created or changed); a kept
// schema is fetched again then too, and kept as it was if that fails. A failed fetch is not repeated for a while.
import { api, type ClusterId, type KindSchema, type ResourceKind } from "../../../api";
import { knownClusterKinds } from "../../../resources/useKinds";
import { splitApiVersion } from "./model";

/** Kinds kept per cluster (least recently used dropped first). */
export const MAX_KINDS = 16;
/** Clusters whose schemas are kept. */
export const MAX_CLUSTERS = 4;
/** A fetch that failed (not connected, forbidden) is tried again after this long. */
export const RETRY_AFTER_MS = 30_000;

export type FetchSchema = (clusterId: ClusterId, group: string, version: string, kind: string) => Promise<KindSchema | null>;
/** The kinds the cluster serves (discovery); `null` when unknown. */
export type ServedKinds = (clusterId: ClusterId) => ResourceKind[] | null | Promise<ResourceKind[] | null>;

const KIND = /^[A-Za-z][A-Za-z0-9]{0,252}$/;
/** A Kubernetes-style version (`v1`, `v2beta1`): another version than discovery's preferred one is asked for only so. */
const KUBE_VERSION = /^v\d+((alpha|beta)\d+)?$/;

interface Kept {
  schema: KindSchema | null;
  /** The discovery it was fetched under: when discovery changes, it is fetched again. */
  discovery: ResourceKind[] | null;
}

function servedFromStore(clusterId: ClusterId): ResourceKind[] | null | Promise<ResourceKind[] | null> {
  return knownClusterKinds(clusterId) ?? api.clusters.kinds(clusterId).catch(() => null);
}

export class SchemaSource {
  private readonly kept = new Map<string, Kept>();
  private readonly pending = new Map<string, Promise<KindSchema | null>>();
  private readonly failedAt = new Map<string, number>();

  constructor(
    readonly clusterId: ClusterId,
    private readonly fetchSchema: FetchSchema = (...args) => api.openapi.kindSchema(...args),
    private readonly servedKinds: ServedKinds = servedFromStore,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** The schema if it is here already: a schema, `null` (the cluster has none) or `undefined` (not fetched). */
  peek(apiVersion: string, kind: string): KindSchema | null | undefined {
    const key = `${apiVersion}/${kind}`;
    const kept = this.kept.get(key);
    if (!kept) return undefined;
    // Most recently used last.
    this.kept.delete(key);
    this.kept.set(key, kept);
    return kept.schema;
  }

  /** The schema of `apiVersion`/`kind`, fetched once; `null` when there is none or it cannot be had now. */
  load(apiVersion: string, kind: string): Promise<KindSchema | null> {
    const key = `${apiVersion}/${kind}`;
    const kept = this.kept.get(key);
    const discovery = knownClusterKinds(this.clusterId);
    if (kept && (discovery === null || discovery === kept.discovery)) return Promise.resolve(this.peek(apiVersion, kind) ?? null);
    const running = this.pending.get(key);
    if (running) return running;
    const failed = this.failedAt.get(key);
    if (failed !== undefined && this.now() - failed < RETRY_AFTER_MS) return Promise.resolve(kept?.schema ?? null);
    const fetching = this.fetch(key, apiVersion, kind, kept);
    this.pending.set(key, fetching);
    void fetching.finally(() => this.pending.delete(key));
    return fetching;
  }

  private async fetch(key: string, apiVersion: string, kind: string, kept: Kept | undefined): Promise<KindSchema | null> {
    const gv = splitApiVersion(apiVersion);
    if (!gv || !KIND.test(kind)) return null;
    const served = await this.servedKinds(this.clusterId);
    const preferred = served?.find((k) => k.kindRef.group === gv.group && k.kindRef.kind === kind);
    // Not served (or still being typed): nothing is asked and nothing is remembered.
    if (!preferred || (preferred.kindRef.version !== gv.version && !KUBE_VERSION.test(gv.version))) {
      return kept?.schema ?? null;
    }
    try {
      const schema = await this.fetchSchema(this.clusterId, gv.group, gv.version, kind);
      this.failedAt.delete(key);
      this.kept.delete(key);
      this.kept.set(key, { schema, discovery: knownClusterKinds(this.clusterId) ?? served });
      while (this.kept.size > MAX_KINDS) {
        const oldest = this.kept.keys().next().value;
        if (oldest === undefined) break;
        this.kept.delete(oldest);
      }
      return schema;
    } catch {
      this.failedAt.set(key, this.now());
      return kept?.schema ?? null;
    }
  }
}

const sources = new Map<ClusterId, SchemaSource>();

/** The schemas of `clusterId`, shared by every editor of that cluster. */
export function schemaSourceFor(clusterId: ClusterId): SchemaSource {
  let source = sources.get(clusterId);
  if (source) sources.delete(clusterId);
  else source = new SchemaSource(clusterId);
  sources.set(clusterId, source);
  while (sources.size > MAX_CLUSTERS) {
    const oldest = sources.keys().next().value;
    if (oldest === undefined) break;
    sources.delete(oldest);
  }
  return source;
}

/** Forgets every cluster's schemas (tests). */
export function resetSchemaSources(): void {
  sources.clear();
}
