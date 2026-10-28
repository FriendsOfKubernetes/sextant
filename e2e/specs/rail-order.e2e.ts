// Putting the clusters of the rail in order by dragging them, on the real WebKitGTK page: pointer events with pointer
// capture (the HTML drag and drop API is unreliable there), a drop line while dragging, Escape cancels, and the order
// is saved in settings.json (`clusterOrder`) and survives a reload. Two extra contexts (servers nobody listens on,
// never connected) are pasted as a kubeconfig source for the test and removed at the end.
import { readFileSync } from "node:fs";
import path from "node:path";
import { $, $$, browser, expect } from "@wdio/globals";
import { after, before, describe, it } from "mocha";
import { click, eventually } from "../app";
import { CONTEXT } from "../cluster";

const EXTRA = ["e2e-rail-one", "e2e-rail-two"];
const KUBECONFIG = `apiVersion: v1
kind: Config
clusters:
- name: e2e-rail
  cluster:
    server: https://127.0.0.1:9
contexts:
- name: ${EXTRA[0]}
  context:
    cluster: e2e-rail
    user: e2e-rail
- name: ${EXTRA[1]}
  context:
    cluster: e2e-rail
    user: e2e-rail
users:
- name: e2e-rail
  user: {}
`;

const rail = () => $('nav[aria-label="Clusters"]');
const railItem = (name: string) => rail().$(`ul[aria-label="Cluster list"] button[aria-label="${name}"]`);

/** The names of the clusters in the rail, top to bottom. */
async function railOrder(): Promise<string[]> {
  return browser.execute(() =>
    Array.from(document.querySelectorAll('nav[aria-label="Clusters"] ul[aria-label="Cluster list"] > li > button')).map(
      (b) => b.getAttribute("aria-label") ?? "",
    ),
  );
}

/** `clusterOrder` as the app wrote it to its settings file. */
function savedOrder(): string[] {
  const home = process.env.SEXTANT_E2E_HOME;
  if (!home) throw new Error("SEXTANT_E2E_HOME is not set");
  const file = path.join(home, "config", "dev.sextant.app", "settings.json");
  const settings = JSON.parse(readFileSync(file, "utf8")) as { clusterOrder?: string[] };
  return settings.clusterOrder ?? [];
}

/** Presses on `from`, moves past the drag threshold and on to the upper half of `to` (the button stays down). */
async function dragOnto(from: string, to: string): Promise<void> {
  const source = await railItem(from).getElement();
  const target = await railItem(to).getElement();
  await browser
    .action("pointer", { parameters: { pointerType: "mouse" } })
    .move({ origin: source })
    .down({ button: 0 })
    .pause(100)
    .move({ origin: source, x: 0, y: -10, duration: 150 })
    .move({ origin: target, x: 0, y: -14, duration: 300 })
    .pause(200)
    .perform(true);
}

async function release(): Promise<void> {
  await browser.action("pointer", { parameters: { pointerType: "mouse" } }).up({ button: 0 }).perform();
}

/** The value of a React-controlled text area, set as typing would (WebKitWebDriver mangles typed `:` and `/`). */
async function fill(selector: string, text: string): Promise<void> {
  const field = $(selector);
  await field.waitForDisplayed();
  await browser.execute(
    (el: HTMLElement, value: string) => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
      setter?.call(el, value);
      el.dispatchEvent(new Event("input", { bubbles: true }));
    },
    await field.getElement(),
    text,
  );
}

/** Closes every open dialog, the innermost first (each Escape closes the top one). */
async function closeDialogs(): Promise<void> {
  for (let i = 0; i < 3 && (await $('[role="dialog"]').isExisting()); i += 1) {
    await browser.keys("Escape");
    await browser.pause(200);
  }
  await $('[role="dialog"]').waitForExist({ reverse: true });
}

describe("Cluster order in the rail", () => {
  before(async () => {
    await browser.setWindowSize(1280, 800);
    await railItem(CONTEXT).waitForDisplayed({ timeout: 30_000 });
    await click("Add cluster", rail());
    await $("button=Paste kubeconfig").click();
    await fill('textarea[aria-label="Kubeconfig"]', KUBECONFIG);
    await $("button=Add").click();
    // Add checks the text first (asynchronously, slower under load): it either adds the source at once or warns about
    // the missing credentials, and the warning's "Add anyway" may appear only later — wait for whichever comes.
    const anyway = $("button=Add anyway");
    await browser.waitUntil(async () => (await anyway.isExisting()) || (await railItem(EXTRA[1]).isExisting()), {
      timeout: 20_000,
      timeoutMsg: "the pasted kubeconfig was neither added nor warned about",
    });
    if (await anyway.isExisting()) await anyway.click();
    await railItem(EXTRA[1]).waitForDisplayed({ timeout: 20_000 });
    await closeDialogs();
  });

  after(async () => {
    // The pasted source goes; the sandboxed settings go with the run. A dialog a failed step left open goes first.
    await closeDialogs();
    await click("Add cluster", rail());
    const remove = $('button[aria-label^="Remove "]');
    if (await remove.isExisting()) {
      await remove.click();
      const buttons = await $$("button=Remove").getElements();
      await buttons[buttons.length - 1]?.click();
      await railItem(EXTRA[0]).waitForExist({ reverse: true, timeout: 20_000 });
    }
    await browser.keys("Escape");
  });

  it("Escape cancels a drag: the line goes and nothing moves", async () => {
    // The test cluster's context, then the pasted ones (earlier scenarios of a run may have left nothing else).
    expect(await railOrder()).toEqual([CONTEXT, ...EXTRA]);
    await dragOnto(EXTRA[1], CONTEXT);
    await expect(rail().$('li[data-drop="before"]')).toExist();
    await browser.keys("Escape");
    await expect(rail().$("li[data-drop]")).not.toExist();
    await release();
    await browser.pause(300);
    expect(await railOrder()).toEqual([CONTEXT, ...EXTRA]);
    // The release of a cancelled drag does not open the cluster.
    expect(await railItem(EXTRA[1]).getAttribute("data-state")).toBe("disconnected");
  });

  it("drags the third cluster to the top, saves the order and keeps it after a reload", async () => {
    await dragOnto(EXTRA[1], CONTEXT);
    // While dragging: the dragged cluster fades and a line marks the place before the first one.
    await expect(railItem(EXTRA[1])).toHaveAttribute("data-dragging", "true");
    await expect(rail().$("ul > li:first-child")).toHaveAttribute("data-drop", "before");
    await release();

    await eventually(async () => (await railOrder())[0] === EXTRA[1], "the dragged cluster on top");
    expect(await railOrder()).toEqual([EXTRA[1], CONTEXT, EXTRA[0]]);
    await expect(rail().$("li[data-drop]")).not.toExist();
    // The release ended the drag: it did not open (connect) the cluster.
    expect(await railItem(EXTRA[1]).getAttribute("data-state")).toBe("disconnected");
    await eventually(() => savedOrder().length === 3, "clusterOrder in settings.json");

    await browser.refresh();
    await railItem(CONTEXT).waitForDisplayed({ timeout: 30_000 });
    await eventually(async () => (await railOrder()).length === 3, "the rail after the reload");
    expect(await railOrder()).toEqual([EXTRA[1], CONTEXT, EXTRA[0]]);
  });
});
