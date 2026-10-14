import type { Sextant } from "@sextant/extension-sdk";

/** Draws the page into `root` and keeps it up to date; returns the function that stops it. */
export function startHello(sextant: Sextant, root: HTMLElement): () => void {
  const title = document.createElement("h1");
  title.textContent = "Hello from an extension";
  const where = document.createElement("p");
  const button = document.createElement("button");
  button.className = "primary";
  button.textContent = "Say hello";
  button.addEventListener("click", () => void sextant.ui.notify("Hello from the Hello extension!"));
  root.replaceChildren(title, where, button);

  const show = () => {
    const { clusterId, theme } = sextant.context;
    where.textContent = clusterId ? `Cluster ${clusterId}, ${theme} theme.` : "No cluster is open.";
  };
  show();
  return sextant.onContextChange(show);
}
