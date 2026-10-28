// The page: asks the extension's backend for a summary and shows it. The backend (backend/main.ts) runs outside the
// frame; this page only calls it.
import { isSextantError, type Sextant } from "@sextant/extension-sdk";

/** What the backend's `summary` answers. */
export interface Summary {
  clusters: number;
  latest: { tag: string; published: string } | null;
  error?: string;
}

/** The text of a summary, line by line. */
export function summaryLines(summary: Summary): string[] {
  const lines = [`Clusters this extension may see: ${summary.clusters}`];
  if (summary.latest) lines.push(`Latest Sextant release: ${summary.latest.tag} (${summary.latest.published.slice(0, 10)})`);
  else lines.push(`The latest release could not be read: ${summary.error ?? "no answer"}`);
  return lines;
}

export function startReleasesPage(sextant: Sextant, app: HTMLElement): void {
  const header = document.createElement("header");
  const title = document.createElement("h1");
  title.textContent = "Sextant releases";
  const refresh = document.createElement("button");
  refresh.className = "btn";
  refresh.textContent = "Ask the backend again";
  header.append(title, refresh);
  const body = document.createElement("section");
  app.append(header, body);

  const show = async () => {
    refresh.disabled = true;
    body.textContent = "Asking the backend…";
    try {
      const summary = await sextant.backend.call<Summary>("summary");
      body.replaceChildren(
        ...summaryLines(summary).map((text) => {
          const p = document.createElement("p");
          p.textContent = text;
          return p;
        }),
      );
    } catch (err) {
      body.textContent = isSextantError(err) ? `The backend failed: ${err.message}` : String(err);
    } finally {
      refresh.disabled = false;
    }
  };
  refresh.addEventListener("click", () => void show());
  void show();
}
