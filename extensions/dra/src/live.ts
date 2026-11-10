// The lists a view watches besides its object, all through Sextant's own watches (`resources.watch`), started when
// first wanted and stopped when no longer, or when the view closes. Each is capped as the built-in views capped theirs
// (`maxObjects`): at most 500 slices, 1000 claims of a namespace, 5000 claims in all and 500 Pending pods of a
// namespace; a list cut there is `truncated`.
import { trackObjects, type KubeObject, type Sextant, type Watch, type WatchParams } from "@sextant/extension-sdk";

/** The built-in views' caps (src/features/dra/hooks.ts). */
export const MAX_NAMESPACE_CLAIMS = 1000;
export const MAX_SLICES = 500;
export const MAX_ALL_CLAIMS = 5000;
export const MAX_NAMESPACE_PENDING = 500;

/**
 * A watched list: its objects, whether the first answer came, whether it failed (not served, forbidden, an error),
 * whether more objects match than it keeps.
 */
export interface Live {
  items: KubeObject[];
  ready: boolean;
  failed: boolean;
  truncated: boolean;
}

/** A list that tells everything: read, not failed, not cut. */
export const complete = (live: Live | undefined): live is Live => live !== undefined && live.ready && !live.failed && !live.truncated;

/** The lists a view watches, by name; `undefined` when it watches none of that name. */
export type Related = Record<string, Live | undefined>;

export type Spec = Omit<WatchParams, "clusterId">;

/** The watches a view holds, by what they watch. */
export class Watches {
  private readonly open = new Map<string, { watch: Watch; live: Live }>();
  constructor(
    private readonly sextant: Sextant,
    private readonly changed: () => void,
  ) {}

  /** The lists of `specs` (by name), each watched from now on; every other watch stops. */
  want(specs: Record<string, Spec | null>): Related {
    const keep = new Set<string>();
    const related: Related = {};
    for (const [name, spec] of Object.entries(specs)) {
      if (!spec) continue;
      const key = JSON.stringify(spec);
      keep.add(key);
      related[name] = (this.open.get(key) ?? this.start(key, spec)).live;
    }
    for (const [key, entry] of this.open) {
      if (keep.has(key)) continue;
      this.open.delete(key);
      void entry.watch.unwatch().catch(() => undefined);
    }
    return related;
  }

  private start(key: string, spec: Spec): { watch: Watch; live: Live } {
    const live: Live = { items: [], ready: false, failed: false, truncated: false };
    const settle = (failed: boolean) => {
      live.ready = true;
      live.failed = failed;
      this.changed();
    };
    const watch = this.sextant.resources.watch(spec, {
      onUpdate: trackObjects(
        (items) => {
          live.items = items;
          settle(false);
        },
        (other) => {
          if (other.type === "error" || other.type === "forbidden") settle(true);
        },
      ),
      onError: () => settle(true),
      onCapped: (total) => {
        live.truncated = total > (spec.maxObjects ?? Infinity);
        this.changed();
      },
    });
    watch.started.catch(() => settle(true));
    const entry = { watch, live };
    this.open.set(key, entry);
    return entry;
  }

  stop(): void {
    this.want({});
  }
}

/** Whether the cluster serves `kind` (of the kinds the extension may use); `undefined` when that cannot be read. */
export async function serves(sextant: Sextant, kind: { group: string; kind: string }): Promise<boolean | undefined> {
  try {
    const kinds = await sextant.kinds();
    return kinds.some((k) => k.kindRef.group === kind.group && k.kindRef.kind === kind.kind);
  } catch {
    return undefined;
  }
}
