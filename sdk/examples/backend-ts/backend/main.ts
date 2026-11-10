// The backend: a WebAssembly component Sextant runs outside the window (ADR-0131). It reaches the clusters through
// `host` with the extension's grant, the network only at the hosts the manifest declares (here api.github.com), and
// the credentials the user entered in Sextant.
//
// It also answers the problem judge `same-selector` (ADR-0168): given the Services Sextant watches (only their
// `.spec.selector`), it says which select the same pods as another of their namespace. Sextant turns that into the
// rule's problem; while the judge runs, `host` and `fetch` are refused.
import { defineBackend, host, type JudgedFact, type JudgedObject } from "@sextant/extension-sdk/backend";

interface Release {
  tag_name: string;
  published_at: string;
}

const LATEST = "https://api.github.com/repos/FriendsOfKubernetes/sextant/releases/latest";

/** Services of one namespace with the same non-empty selector: each has the fact `shared`, naming the first other. */
function sameSelector(services: JudgedObject[]): JudgedFact[] {
  const groups = new Map<string, JudgedObject[]>();
  for (const service of services) {
    const selector = service.values[".spec.selector"];
    if (selector === null || typeof selector !== "object" || Object.keys(selector).length === 0) continue;
    const sorted = Object.entries(selector as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    const key = `${service.metadata.namespace ?? ""}|${JSON.stringify(sorted)}`;
    groups.set(key, [...(groups.get(key) ?? []), service]);
  }
  const facts: JudgedFact[] = [];
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    for (const service of group) {
      const other = group.find((s) => s !== service)!;
      facts.push({ uid: service.metadata.uid, fact: "shared", values: { other: other.metadata.name } });
    }
  }
  return facts;
}

export const handle = defineBackend({
  ping: () => "pong",

  async summary() {
    const clusters = host.clusters.list().length;
    const token = host.credentials.get("github-token");
    try {
      const answer = await fetch(LATEST, {
        headers: { accept: "application/vnd.github+json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      });
      if (!answer.ok) return { clusters, latest: null, error: `GitHub answered ${answer.status}` };
      const release = (await answer.json()) as Release;
      host.log.info(`latest release ${release.tag_name}`);
      return { clusters, latest: { tag: release.tag_name, published: release.published_at } };
    } catch (err) {
      return { clusters, latest: null, error: err instanceof Error ? err.message : String(err) };
    }
  },
}, {
  problemJudges: { "same-selector": sameSelector },
});
