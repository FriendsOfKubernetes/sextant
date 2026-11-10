// The details section and the two action windows, driven through the SDK's stand-in for Sextant's window, as the
// built-in view's tests drove them.
import { SextantError, type KubeObject, type WatchUpdate } from "@sextant/extension-sdk";
import { startTestHost, type TestHost } from "@sextant/extension-sdk/testing";
import { afterEach, describe, expect, it } from "vitest";
import fixtures from "../fixtures/objects.json";
import { BACKUP_ACTION, RESTORE_ACTION, startAction } from "./actions";
import { startDetails } from "./details";
import { setLanguage } from "./i18n";

const f = fixtures as unknown as Record<string, KubeObject>;
const fx = (name: string): KubeObject => structuredClone(f[name]!);

const kindOf = (o: KubeObject) => ({ group: o.apiVersion!.includes("/") ? o.apiVersion!.split("/")[0]! : "", version: "v1", kind: o.kind! });
const ref = (o: KubeObject) => ({ kind: kindOf(o), namespace: o.metadata.namespace ?? null, name: o.metadata.name });

let host: TestHost;
let root: HTMLElement;
let stop: () => void = () => undefined;

async function openDetails(obj: KubeObject, language = "en"): Promise<void> {
  host = await startTestHost({
    context: { view: "details", contribution: "velero", selection: [ref(obj)], resourceVersion: "1", language },
    handlers: { "resources.get": () => structuredClone(obj), "ui.setBlockOpen": () => null },
  });
  setLanguage(language);
  root = document.createElement("main");
  document.body.append(root);
  stop = startDetails(host.sextant, root, "velero");
  await expect.poll(() => root.querySelector(".sx-loading")).toBeNull();
}

const created: string[] = [];
async function openAction(contribution: string, obj: KubeObject, handlers: Record<string, (params: never) => unknown> = {}): Promise<void> {
  created.length = 0;
  host = await startTestHost({
    context: { view: "action", contribution, selection: [ref(obj)], language: "en" },
    handlers: {
      "resources.get": () => structuredClone(obj),
      "resources.create": ({ yaml }: { yaml: string }) => {
        created.push(yaml);
        return { kind: { group: "velero.io", version: "v1", kind: "Backup" }, namespace: "velero", name: "x" };
      },
      ...handlers,
    },
  });
  setLanguage("en");
  root = document.createElement("main");
  document.body.append(root);
  stop = startAction(host.sextant, root, contribution);
  await expect.poll(() => root.querySelector(".sx-loading")).toBeNull();
}

afterEach(() => {
  setLanguage("en");
  stop();
  root?.remove();
  host?.close();
});

const text = () => root.textContent ?? "";
/** The fields as label → text. */
const fieldsOf = () =>
  Object.fromEntries([...root.querySelectorAll(".sx-fields__label")].map((dt) => [dt.textContent, dt.nextElementSibling?.textContent ?? ""]));
const explained = () => [...root.querySelectorAll(".st-explain")].map((p) => [p.textContent, p.className.replace("st-explain st-explain--", "")]);
const button = (label: string) => [...root.querySelectorAll("button")].find((b) => b.textContent === label);
const labelled = (label: string) => {
  const forId = [...root.querySelectorAll("label")].find((l) => l.textContent === label)?.htmlFor;
  return forId ? (root.querySelector(`#${forId}`) as HTMLInputElement | HTMLSelectElement | null) : null;
};
function type(label: string, value: string): void {
  const input = labelled(label) as HTMLInputElement;
  input.value = value;
  input.dispatchEvent(new Event("input"));
}
const snapshot = (items: KubeObject[]): WatchUpdate => ({ type: "snapshot", items: items as never });

describe("the Velero details section", () => {
  it("a failed backup: why, how much, where the log is, and its fields with the location linked", async () => {
    await openDetails(fx("backupFailed"));
    expect(explained()).toEqual([
      ["It failed: error checking if backup already exists in object storage: rpc error: code = Unknown desc = AccessDenied", "danger"],
      ["The details are in the log: velero backup logs nightly-20261020020000", "neutral"],
    ]);
    const fields = fieldsOf();
    expect(fields["Phase"]).toBe("Failed");
    expect(root.querySelector(".sx-status--danger")?.textContent).toBe("Failed");
    expect(fields["Namespaces"]).toBe("shop, db");
    expect(fields["Kept for (TTL)"]).toBe("168h0m0s");
    expect(fields["Storage location"]).toBe("default");
    expect(fields["Started"]).toBeTruthy();
    expect(fields["Expires"]).toBeUndefined();
    button("default")!.click();
    await expect.poll(() => host.calls.find((c) => c.method === "ui.openDetails")?.params).toEqual({
      kind: { group: "velero.io", version: "v1", kind: "BackupStorageLocation" },
      namespace: "velero",
      name: "default",
    });
  });

  it("a backup of every namespace says so", async () => {
    await openDetails(fx("backupInProgress"));
    expect(fieldsOf()["Namespaces"]).toBe("Every namespace");
    expect(explained()).toEqual([["3 of 10 items done.", "neutral"]]);
    expect(root.querySelector(".sx-status--muted")?.textContent).toBe("InProgress");
  });

  it("a restore links its backup and schedule", async () => {
    await openDetails(fx("restorePartiallyFailed"));
    expect(explained().map(([t]) => t)).toEqual([
      "2 errors: some objects were not restored.",
      "1 warning.",
      "The details are in the log: velero restore logs nightly-restore",
    ]);
    expect(fieldsOf()).toMatchObject({ Phase: "PartiallyFailed", Backup: "nightly-20261019020000", Schedule: "nightly" });
    expect(root.querySelector(".sx-status--warning")?.textContent).toBe("PartiallyFailed");
    button("nightly")!.click();
    await expect.poll(() => host.calls.find((c) => c.method === "ui.openDetails")?.params).toMatchObject({ kind: { kind: "Schedule" }, name: "nightly" });
  });

  it("a schedule: its cron, namespaces, TTL and the age of its last backup; paused said in words", async () => {
    await openDetails(fx("scheduleEnabled"));
    const fields = fieldsOf();
    expect(fields).toMatchObject({ Phase: "Enabled", Schedule: "0 2 * * *", Namespaces: "shop, db", "Kept for (TTL)": "168h0m0s" });
    expect(root.querySelector("time")?.getAttribute("title")).toBe("2026-10-20T02:00:00Z");
    stop();
    root.remove();
    host.close();
    await openDetails(fx("schedulePaused"));
    expect(explained()).toEqual([["Paused: no new backups are made.", "warning"]]);
    expect(fieldsOf()["Namespaces"]).toBe("Every namespace");
  });

  it("a storage location: provider, bucket, prefix, access mode; an unreachable one says why", async () => {
    await openDetails(fx("locationUnavailable"));
    expect(explained()[0]![1]).toBe("danger");
    expect(fieldsOf()).toMatchObject({ Phase: "Unavailable", Provider: "aws", Bucket: "velero-archive", "Access mode": "ReadOnly" });
    stop();
    root.remove();
    host.close();
    await openDetails(fx("snapshotLocation"));
    expect(fieldsOf()).toEqual({ Phase: "Available", Provider: "aws" });
  });

  it("is one block titled Velero, open by default, closed and opened in Sextant's memory of details sections", async () => {
    await openDetails(fx("backupFailed"));
    const toggle = () => root.querySelector<HTMLButtonElement>(".sx-block__toggle")!;
    const body = () => root.querySelector<HTMLElement>(".sx-block__body")!;
    expect(root.querySelectorAll(".sx-block")).toHaveLength(1);
    expect(toggle().textContent).toBe("Velero");
    expect(toggle().getAttribute("aria-expanded")).toBe("true");
    expect(body().querySelector(".st-explain")).not.toBeNull();
    toggle().click();
    expect(body().hidden).toBe(true);
    await expect.poll(() => host.calls.find((c) => c.method === "ui.setBlockOpen")?.params).toEqual({ id: "velero", open: false });
    // Sextant's memory answers with the same choice: nothing is drawn again.
    const shown = root.querySelector(".sx-block");
    host.setContext({ blocks: { velero: false } });
    await new Promise((r) => setTimeout(r, 20));
    expect(root.querySelector(".sx-block")).toBe(shown);
    // "Expand all": drawn again, open.
    host.setContext({ blocks: { "*": true } });
    await expect.poll(() => toggle().getAttribute("aria-expanded")).toBe("true");
    expect(body().hidden).toBe(false);
  });

  it("starts closed when Sextant remembers it closed", async () => {
    host = await startTestHost({
      context: { view: "details", contribution: "velero", selection: [ref(fx("scheduleEnabled"))], resourceVersion: "1", language: "en", blocks: { velero: false } },
      handlers: { "resources.get": () => fx("scheduleEnabled"), "ui.setBlockOpen": () => null },
    });
    root = document.createElement("main");
    document.body.append(root);
    stop = startDetails(host.sextant, root, "velero");
    await expect.poll(() => root.querySelector(".sx-block__toggle")?.getAttribute("aria-expanded")).toBe("false");
    expect(root.querySelector<HTMLElement>(".sx-block__body")!.hidden).toBe(true);
  });

  it("in the UI language", async () => {
    await openDetails(fx("backupCompleted"), "ru");
    expect(explained()).toEqual([["2 предупреждения.", "warning"]]);
    expect(Object.keys(fieldsOf())).toContain("Срок хранения (TTL)");
  });
});

describe("Back up namespace…", () => {
  it("backs up a namespace in Velero's namespace, found by its storage locations", async () => {
    await openAction(BACKUP_ACTION, fx("namespaceShop"));
    expect(text()).toContain("Back up namespace shop");
    expect((labelled("Name") as HTMLInputElement).value).toMatch(/^shop-\d{8}-\d{4}$/);
    // Before the locations come: Velero's usual namespace, and a hint.
    expect((labelled("Velero namespace") as HTMLInputElement).value).toBe("velero");
    expect(text()).toContain("No BackupStorageLocation was found: Velero may not be set up.");
    await expect.poll(() => host.watches.length).toBe(1);
    expect(host.watches[0]!.params).toMatchObject({ kind: { group: "velero.io", kind: "BackupStorageLocation" } });
    const location = fx("locationOther");
    location.spec!.default = true;
    host.watches[0]!.emit(snapshot([location]));
    await expect.poll(() => (labelled("Velero namespace") as HTMLInputElement).value).toBe("backup-system");
    expect(text()).not.toContain("No BackupStorageLocation");
    expect([...(labelled("Storage location") as HTMLSelectElement).options].map((o) => o.textContent)).toEqual(["Velero's default location", "secondary"]);
    type("Name", "shop-now");
    button("Review")!.click();
    expect(root.querySelector('[aria-label="Objects to create"]')?.textContent).toBe("Backup backup-system/shop-now");
    expect(root.querySelector(".st-note")?.textContent).toBe(
      "Velero backs up every object of shop and, where it is set up for that, its volumes. The backup runs in Velero, not in Sextant.",
    );
    const yaml = ["apiVersion: velero.io/v1", "kind: Backup", "metadata:", "  name: shop-now", "  namespace: backup-system", "spec:", "  includedNamespaces:", "  - shop", "  ttl: 720h0m0s", ""].join("\n");
    expect(root.querySelector('[aria-label="YAML of the object"]')?.textContent).toBe(yaml);
    expect(created).toEqual([]);
    button("Create")!.click();
    await expect.poll(() => text()).toContain("Created Backup backup-system/shop-now.");
    expect(created).toEqual([yaml]);
    expect(host.calls.filter((c) => c.method === "resources.create")).toHaveLength(1);
    expect(host.calls.some((c) => c.method === "resources.apply")).toBe(false);
    button("Close")!.click();
    await expect.poll(() => host.closedByFrame).toBe(true);
    expect(host.watches[0]!.stopped).toBe(false);
    stop();
    await expect.poll(() => host.watches[0]!.stopped).toBe(true);
  });

  it("refuses names and TTLs Velero would not take, and goes back to the form", async () => {
    await openAction(BACKUP_ACTION, fx("namespaceShop"));
    type("Name", "Shop");
    expect(text()).toContain("Use lowercase letters, digits, dashes and dots, up to 63 characters.");
    expect(button("Review")!.disabled).toBe(true);
    type("Name", "shop-1");
    type("Keep for (TTL)", "3d");
    expect(text()).toContain("Enter a duration such as 720h or 72h30m.");
    expect(button("Review")!.disabled).toBe(true);
    type("Keep for (TTL)", "24h");
    expect(button("Review")!.disabled).toBe(false);
    button("Review")!.click();
    expect(root.querySelector('[aria-label="YAML of the object"]')?.textContent).toContain("ttl: 24h");
    button("Back")!.click();
    expect((labelled("Keep for (TTL)") as HTMLInputElement).value).toBe("24h");
  });

  it("a name already taken: nothing is changed, and it says so", async () => {
    await openAction(BACKUP_ACTION, fx("namespaceShop"), {
      "resources.create": () => {
        throw new SextantError("conflict", "backups.velero.io \"shop-now\" already exists");
      },
    });
    type("Name", "shop-now");
    button("Review")!.click();
    button("Create")!.click();
    await expect.poll(() => root.querySelector(".sx-error")?.textContent).toBe("Backup velero/shop-now already exists: nothing was changed.");
    expect(button("Create")!.disabled).toBe(false);
  });

  it("takes Velero's namespace and the locations in the order the watch delivered them, as the built-in dialog did", async () => {
    await openAction(BACKUP_ACTION, fx("namespaceShop"));
    // Offered only where Backups are served (`requiresKinds`): the window asks nothing about the cluster's kinds.
    expect(host.calls.some((c) => c.method === "kinds")).toBe(false);
    await expect.poll(() => host.watches.length).toBe(1);
    const at = (name: string, namespace: string, uid: string): KubeObject => {
      const l = fx("locationOther");
      l.metadata = { ...l.metadata, name, namespace, uid };
      l.spec!.default = false;
      return l;
    };
    // No default location: the first one delivered, not the first by namespace and name.
    host.watches[0]!.emit(snapshot([at("zeta-1", "zeta", "u1"), at("alpha-1", "alpha", "u2"), at("zeta-0", "zeta", "u3")]));
    await expect.poll(() => (labelled("Velero namespace") as HTMLInputElement).value).toBe("zeta");
    const options = () => [...(labelled("Storage location") as HTMLSelectElement).options].map((o) => o.value);
    expect(options()).toEqual(["", "zeta-1", "zeta-0"]);
    // A change keeps its place, a new one comes last, a deleted one goes.
    host.watches[0]!.emit({ type: "delta", upserted: [at("zeta-2", "zeta", "u4"), at("zeta-1", "zeta", "u1")] as never, deleted: ["u3"] });
    await expect.poll(options).toEqual(["", "zeta-1", "zeta-2"]);
    host.watches[0]!.emit({ type: "delta", upserted: [], deleted: ["u1"] });
    await expect.poll(() => (labelled("Velero namespace") as HTMLInputElement).value).toBe("alpha");
  });

  it("puts the focus on the name, also after going back, as the built-in dialog's autoFocus", async () => {
    await openAction(BACKUP_ACTION, fx("namespaceShop"));
    expect(document.activeElement).toBe(labelled("Name"));
    button("Review")!.click();
    button("Back")!.click();
    expect(document.activeElement).toBe(labelled("Name"));
  });
});

describe("Restore from this backup…", () => {
  it("says that Velero skips what already exists, and maps namespaces", async () => {
    const backup = fx("backupCompleted");
    await openAction(RESTORE_ACTION, backup);
    expect(text()).toContain("Restore from backup shop-20261019-1432");
    expect(text()).not.toContain("not Completed");
    expect((labelled("Name") as HTMLInputElement).value).toMatch(/^shop-20261019-1432-\d{8}-\d{4}$/);
    type("Name", "shop-copy");
    expect((labelled("Namespace shop into") as HTMLInputElement).placeholder).toBe("shop");
    type("Namespace shop into", "Shop");
    expect(text()).toContain("Enter a namespace name: lowercase letters, digits and dashes.");
    expect(button("Review")!.disabled).toBe(true);
    type("Namespace shop into", "shop-restored");
    button("Review")!.click();
    expect(root.querySelector('[aria-label="Objects to create"]')?.textContent).toBe("Restore velero/shop-copy");
    expect(root.querySelector(".st-note")?.textContent).toMatch(/^Objects are restored into the namespaces you named\. Velero skips most objects/);
    const yaml = [
      "apiVersion: velero.io/v1",
      "kind: Restore",
      "metadata:",
      "  name: shop-copy",
      "  namespace: velero",
      "spec:",
      "  backupName: shop-20261019-1432",
      "  namespaceMapping:",
      "    shop: shop-restored",
      "",
    ].join("\n");
    expect(root.querySelector('[aria-label="YAML of the object"]')?.textContent).toBe(yaml);
    button("Create")!.click();
    await expect.poll(() => text()).toContain("Created Restore velero/shop-copy.");
    expect(created).toEqual([yaml]);
  });

  it("a backup of every namespace restores each under its name; one not Completed is warned about", async () => {
    await openAction(RESTORE_ACTION, fx("backupFailedValidation"));
    expect(text()).toContain("The backup's phase is FailedValidation, not Completed: the restore may fail or bring back only part of it.");
    expect(text()).toContain("The backup covers every namespace; each is restored under its own name.");
    type("Name", "again");
    button("Review")!.click();
    expect(root.querySelector(".st-note")?.textContent).toMatch(/^Velero skips most objects that already exist/);
    expect(root.querySelector('[aria-label="YAML of the object"]')?.textContent).not.toContain("namespaceMapping");
  });

  it("a backup without a phase yet", async () => {
    await openAction(RESTORE_ACTION, fx("backupNew"));
    expect(text()).toContain("The backup's phase is —, not Completed");
    expect(document.activeElement).toBe(labelled("Name"));
  });
});
