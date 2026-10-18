// "Find by name" in every selected cluster, with the command palette's search: its shared metadata-only watches
// (`useObjectIndex`, kept a little after the last user) and its matching (`parseKindQuery`, `objectGroups`). Bounded per
// cluster: nothing is watched before something is typed, at most `FIND_KINDS` (six kinds) or the one kind the query
// names (`cm web`), and at most the palette's `MAX_OBJECT_RESULTS` hits.
import { useDeferredValue, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { LoadingIndicator } from "../../components";
import { formatList } from "../../i18n/format";
import { kindKey, useClusterKinds } from "../../resources";
import { objectGroups } from "../palette/items";
import { parseKindQuery, searchKinds, useObjectIndex, type SearchKind } from "../palette/objectIndex";
import { FIND_KINDS } from "./constants";
import { openInCluster } from "./store";
import type { FleetCluster } from "./tables";

export function FindTab({ clusters }: { clusters: FleetCluster[] }) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const deferred = useDeferredValue(query);
  const kinds = formatList(FIND_KINDS.map((k) => k.slice(k.indexOf("/") + 1)));

  return (
    <div className="fleet-find">
      <label className="fleet-find__label">
        <span>{t("fleet:find.label")}</span>
        <input
          className="fleet-find__input"
          type="search"
          value={query}
          placeholder={t("fleet:find.placeholder")}
          onChange={(e) => setQuery(e.target.value)}
          spellCheck={false}
          autoComplete="off"
        />
      </label>
      <p className="fleet-note">{t("fleet:find.hint", { kinds })}</p>
      {deferred.trim() !== "" &&
        clusters.map((cluster) => <FindIn key={cluster.id} cluster={cluster} query={deferred} />)}
    </div>
  );
}

function FindIn({ cluster, query }: { cluster: FleetCluster; query: string }) {
  const { t } = useTranslation();
  const discovery = useClusterKinds(cluster.id);
  const all = useMemo(() => (discovery.kinds ? searchKinds(discovery.kinds) : null), [discovery.kinds]);
  const defaults = useMemo<SearchKind[] | null>(() => {
    if (!all) return null;
    const byKey = new Map(all.map((k) => [kindKey(k.kind), k]));
    return FIND_KINDS.map((key) => byKey.get(key)).filter((k): k is SearchKind => k !== undefined);
  }, [all]);
  const parsed = useMemo(() => (all ? parseKindQuery(query, all) : null), [all, query]);
  // The kind the query names alone, else the default kinds; the same array while it does not change.
  const named = parsed?.kind ?? null;
  const watched = useMemo(() => (named ? [named] : defaults), [named, defaults]);
  const index = useObjectIndex(cluster.id, parsed ? watched : null);
  const groups = useMemo(
    () => (parsed ? objectGroups(t, cluster.id, index.kinds, parsed) : []),
    [t, cluster.id, index.kinds, parsed],
  );

  const searching = !all || index.pending > 0;
  return (
    <section className="fleet-find__cluster" aria-label={cluster.name}>
      <h4 className="fleet-find__heading">{cluster.name}</h4>
      {discovery.error ? (
        <p className="fleet-note">{t("fleet:find.noKinds")}</p>
      ) : groups.length === 0 ? (
        searching ? (
          <LoadingIndicator className="fleet-note" text={t("fleet:find.searching")} />
        ) : (
          <p className="fleet-note">{t("fleet:find.none")}</p>
        )
      ) : (
        <ul className="fleet-find__results">
          {groups.flatMap((group) =>
            group.items.map((item) => {
              const target = item.object!;
              return (
                <li key={item.key}>
                  <button
                    type="button"
                    className="fleet-link"
                    aria-label={t("fleet:openIn", { kind: target.kind.kind, name: target.name, cluster: cluster.name })}
                    onClick={() =>
                      openInCluster(cluster.id, { kind: target.kind, namespace: target.namespace, name: target.name })
                    }
                  >
                    {target.name}
                  </button>
                  <span className="fleet-find__kind">{group.label}</span>
                  {target.namespace && <span className="fleet-find__ns">{target.namespace}</span>}
                </li>
              );
            }),
          )}
        </ul>
      )}
    </section>
  );
}
