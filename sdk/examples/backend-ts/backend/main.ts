// The backend: a WebAssembly component Sextant runs outside the window (ADR-0131). It reaches the clusters through
// `host` with the extension's grant, the network only at the hosts the manifest declares (here api.github.com), and
// the credentials the user entered in Sextant.
import { defineBackend, host } from "@sextant/extension-sdk/backend";

interface Release {
  tag_name: string;
  published_at: string;
}

const LATEST = "https://api.github.com/repos/FriendsOfKubernetes/sextant/releases/latest";

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
});
