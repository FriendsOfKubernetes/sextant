// The details sections, driven through the SDK's stand-in for Sextant's window, as the built-in view's tests drove
// them (src/features/security/security.test.tsx: "the details of a Trivy report", the image scans of a workload).
import type { KubeObject, WatchUpdate } from "@sextant/extension-sdk";
import { startTestHost, type TestHost, type TestWatch } from "@sextant/extension-sdk/testing";
import { afterEach, describe, expect, it } from "vitest";
import auditJson from "../fixtures/configauditreport.json";
import reportsJson from "../fixtures/reports.json";
import vulnJson from "../fixtures/vulnerabilityreport.json";
import { REPORT_BLOCK, SCANS_BLOCK, startDetails } from "./details";
import { setLanguage } from "./i18n";
import { DETAILS_TOP } from "./model";

const vuln = () => structuredClone(vulnJson) as unknown as KubeObject;
const audit = () => structuredClone(auditJson) as unknown as KubeObject;
const report = (kind: string) => structuredClone((reportsJson as unknown as KubeObject[]).find((r) => r.kind === kind)!);

const refOf = (o: KubeObject) => {
  const api = o.apiVersion ?? "";
  const [group, version] = api.includes("/") ? api.split("/") : ["", api];
  return { kind: { group: group!, version: version!, kind: o.kind ?? "" }, namespace: o.metadata.namespace ?? null, name: o.metadata.name };
};

const served = (group: string, kind: string) => ({ kindRef: { group, version: "v1alpha1", kind }, plural: `${kind.toLowerCase()}s`, namespaced: true, verbs: ["list", "watch"], printerColumns: [] });
const BOTH = [served("aquasecurity.github.io", "VulnerabilityReport"), served("aquasecurity.github.io", "ConfigAuditReport")];

let host: TestHost;
let root: HTMLElement;
let stop: () => void = () => undefined;
/** Sextant's memory of the section's blocks (`context.blocks`, `ui.setBlockOpen`). */
let remembered: Record<string, boolean> = {};
/** Whether Sextant hides the section (`ui.setHidden`; the scans section starts hidden). */
let hidden = false;
let opened: unknown[] = [];

interface Options {
  contribution?: string;
  language?: string;
  blocks?: Record<string, boolean>;
  kinds?: unknown[] | Error | (() => unknown[]);
  kindsVersion?: number;
}

async function open(obj: KubeObject, options: Options = {}): Promise<void> {
  const { contribution = "report", language = "en", blocks = {}, kinds = BOTH, kindsVersion } = options;
  remembered = { ...blocks };
  hidden = contribution === "scans";
  opened = [];
  host = await startTestHost({
    context: { view: "details", contribution, selection: [refOf(obj)], resourceVersion: "1", language, blocks: remembered, kindsVersion },
    handlers: {
      "resources.get": () => structuredClone(obj),
      kinds: () => {
        if (kinds instanceof Error) throw kinds;
        return typeof kinds === "function" ? kinds() : kinds;
      },
      "ui.openDetails": (ref: unknown) => void opened.push(ref),
      "ui.setBlockOpen": ({ id, open: isOpen }: { id: string; open: boolean }) => {
        remembered = { ...remembered, [id]: isOpen };
        host.setContext({ blocks: remembered });
      },
      "ui.setHidden": ({ hidden: hide }: { hidden: boolean }) => void (hidden = hide),
    },
  });
  setLanguage(language);
  root = document.createElement("main");
  document.body.append(root);
  stop = startDetails(host.sextant, root, contribution);
}

afterEach(() => {
  setLanguage("en");
  stop();
  root?.remove();
  host?.close();
});

const text = () => root.textContent ?? "";
const byLabel = (label: string) => [...root.querySelectorAll("button")].filter((b) => b.getAttribute("aria-label") === label);
const badges = () => [...root.querySelectorAll(".badge")].map((b) => `${b.textContent}|${b.className.replace("badge badge--", "")}`);
const cells = (column: number) => [...root.querySelectorAll(".sec-table tbody tr")].map((tr) => tr.children[column]?.textContent);
type Params = { kind: { group: string; kind: string }; namespaces?: string[]; labelSelector?: string };
const params = (w: TestWatch) => w.params as Params;
const live = () => host.watches.filter((w) => !w.stopped);
const watchOf = (kind: string) => live().find((w) => params(w).kind.kind === kind);
const snapshot = (items: KubeObject[]): WatchUpdate => ({ type: "snapshot", items: items as never });

describe("the details of a Trivy report", () => {
  it("link the scanned object and list the most severe rows with their fixed versions", async () => {
    await open(vuln());
    await expect.poll(() => byLabel("Open ReplicaSet web-7d9c6b8f5d").length).toBe(1);
    const link = byLabel("Open ReplicaSet web-7d9c6b8f5d")[0]!;
    expect(link.textContent).toBe("ReplicaSet: web-7d9c6b8f5d");
    expect(text()).toContain("Scanned object:");
    expect(text()).toContain("Container nginx");
    expect(root.querySelector(".sec-code")?.textContent).toBe("index.docker.io/library/nginx:1.25.3");
    expect(cells(1)).toEqual(["CVE-2024-45491", "CVE-2024-45492", "CVE-2023-52425", "CVE-2024-2511", "CVE-2024-5535"]);
    expect(cells(3).filter((c) => c === "2.5.0-1")).toHaveLength(3);
    expect(cells(4).filter((c) => c === "2.5.0-1+deb12u1")).toHaveLength(2);
    expect(cells(4).filter((c) => c === "No fix")).toHaveLength(1);
    // The vulnerability's title on hover of its id, as the built-in table had it.
    expect((root.querySelector(".sec-table tbody tr td:nth-child(2)") as HTMLElement).title).toBe("libexpat: Integer Overflow or Wraparound");
    expect(badges().slice(0, 4)).toEqual(["Critical: 1|danger", "High: 2|danger", "Medium: 1|warning", "Low: 1|info"]);
    expect(text()).toContain("4 vulnerabilities have a fixed version.");
    link.click();
    await expect.poll(() => opened).toEqual([{ kind: { group: "apps", version: "v1", kind: "ReplicaSet" }, namespace: "shop", name: "web-7d9c6b8f5d" }]);
    expect(root.querySelector("[data-block] .sx-block__title")?.textContent).toBe("Report");
  });

  it("say how many of how many are listed when a report has more than 50", async () => {
    const big = vuln();
    const list = (big.report as { vulnerabilities: unknown[] }).vulnerabilities;
    for (let i = 0; i < 5000; i++) list.push({ vulnerabilityID: `CVE-X-${i}`, severity: "LOW", resource: "x", installedVersion: "1" });
    await open(big);
    await expect.poll(() => cells(1).length).toBe(50);
    expect(text()).toContain("Listed: the 50 most severe of 5005.");
  });

  it("list a configuration audit's failed checks with their messages and remediation, zero counts untoned", async () => {
    await open(audit());
    await expect.poll(() => root.querySelectorAll(".sec-check").length).toBe(2);
    const checks = [...root.querySelectorAll(".sec-check")];
    expect(checks.map((li) => li.querySelector(".sec-finding__title")?.textContent)).toEqual(["KSV014", "KSV001"]);
    expect(checks[1]!.textContent).toContain("Can elevate its own privileges");
    expect(checks[1]!.querySelector(".sec-note")?.textContent).toBe("Container 'nginx' should set 'securityContext.allowPrivilegeEscalation' to false");
    expect(checks[1]!.querySelector(".sec-remediation")?.textContent).toContain("allowPrivilegeEscalation");
    expect(badges().slice(0, 4)).toEqual(["Critical: 0|neutral", "High: 1|danger", "Medium: 1|warning", "Low: 0|neutral"]);
    expect(badges().slice(4)).toEqual(["High|danger", "Medium|warning"]);
  });

  it("keep several messages of a check on their own lines, and say when every check passed", async () => {
    await open(report("ClusterRbacAssessmentReport"));
    await expect.poll(() => root.querySelectorAll(".sec-check").length).toBe(3);
    expect(root.querySelectorAll(".sec-check")[1]!.querySelector(".sec-note")?.textContent).toBe("first\nsecond");
    // A ClusterRole is cluster-scoped: its link names no namespace.
    byLabel("Open ClusterRole admin")[0]!.click();
    await expect.poll(() => opened).toEqual([{ kind: { group: "rbac.authorization.k8s.io", version: "v1", kind: "ClusterRole" }, namespace: null, name: "admin" }]);
    stop();
    root.remove();
    host.close();
    await open(report("ClusterInfraAssessmentReport"));
    await expect.poll(() => text()).toContain("All checks passed.");
    expect(byLabel("Open Node worker-1")).toHaveLength(1);
  });

  it("list exposed secrets by rule and file, never the matched text", async () => {
    await open(report("ExposedSecretReport"));
    await expect.poll(() => cells(1)).toEqual(["aws-access-key-id"]);
    expect(cells(2)).toEqual(["AWS Access Key ID"]);
    expect(cells(3)).toEqual(["/app/.env"]);
    expect(root.innerHTML).not.toContain("AKIA");
  });

  it("give a compliance report's totals and its failing controls, and an SBOM's components", async () => {
    await open(report("ClusterComplianceReport"));
    await expect.poll(() => text()).toContain("Passed: 101, failed: 15");
    expect(cells(1)).toEqual(["5.2.2", "1.1.1", "4.2.6"]);
    expect(cells(3)).toEqual(["4", "1", "2"]);
    // A compliance report names no scanned object.
    expect(text()).not.toContain("Scanned object:");
    stop();
    root.remove();
    host.close();
    await open(report("SbomReport"));
    await expect.poll(() => text()).toContain("Components: 142");
  });

  it("show a scanned object of a kind it cannot link as text", async () => {
    const odd = audit();
    (odd.metadata.labels as Record<string, string>)["trivy-operator.resource.kind"] = "Gadget";
    await open(odd);
    await expect.poll(() => text()).toContain("Gadget: web-7d9c6b8f5d");
    expect(byLabel("Open Gadget web-7d9c6b8f5d")).toHaveLength(0);
  });

  it("open and close its block in Sextant's memory, drawing nothing while closed", async () => {
    await open(vuln(), { blocks: { [REPORT_BLOCK]: false } });
    await expect.poll(() => root.querySelector(".sx-block__toggle")?.getAttribute("aria-expanded")).toBe("false");
    expect(root.querySelector(".sec-table")).toBeNull();
    (root.querySelector(".sx-block__toggle") as HTMLButtonElement).click();
    await expect.poll(() => remembered[REPORT_BLOCK]).toBe(true);
    await expect.poll(() => root.querySelector(".sec-table")).not.toBeNull();
    // "Collapse all" closes it again.
    host.setContext({ blocks: { "*": false } });
    await expect.poll(() => root.querySelector(".sec-table")).toBeNull();
  });

  it("speak the UI language", async () => {
    await open(vuln(), { language: "ru" });
    await expect.poll(() => text()).toContain("Проверенный объект:");
    expect(text()).toContain("Контейнер nginx");
    expect(byLabel("Открыть ReplicaSet web-7d9c6b8f5d")).toHaveLength(1);
  });
});

// ---------- A workload's image scans ----------

const deployment = (): KubeObject => ({
  apiVersion: "apps/v1",
  kind: "Deployment",
  metadata: { name: "web", namespace: "shop", uid: "d-1" },
  spec: { selector: { matchLabels: { app: "web" } }, template: { spec: { containers: [{ name: "nginx", image: "nginx:1.25.3" }] } } },
});
const replicaSet = (name: string, replicas: number): KubeObject => ({
  apiVersion: "apps/v1",
  kind: "ReplicaSet",
  metadata: { name, namespace: "shop", uid: `rs-${name}`, creationTimestamp: "2026-10-10T00:00:00Z", ownerReferences: [{ apiVersion: "apps/v1", kind: "Deployment", name: "web", uid: "d-1", controller: true }] },
  spec: { replicas },
});
const SELECTOR = "trivy-operator.resource.kind=ReplicaSet,trivy-operator.resource.name=web-7d9c6b8f5d";

describe("the image scans of a workload", () => {
  it("shows a Deployment's reports through its live ReplicaSet, watched by label in its namespace", async () => {
    await open(deployment(), { contribution: "scans" });
    await expect.poll(() => hidden).toBe(false);
    const rsWatch = watchOf("ReplicaSet")!;
    expect(params(rsWatch)).toMatchObject({ namespaces: ["shop"], labelSelector: "app=web" });
    // Until the ReplicaSets answer, no report is watched, and nothing is said yet.
    expect(watchOf("VulnerabilityReport")).toBeUndefined();
    expect(root.querySelector("[data-block] .sx-block__title")?.textContent).toBe("Image scans (Trivy)");
    expect(text()).toBe("Image scans (Trivy)");
    rsWatch.emit(snapshot([replicaSet("web-7d9c6b8f5d", 2), replicaSet("web-5b6c7d8e9f", 0)]));
    await expect.poll(() => watchOf("VulnerabilityReport") !== undefined).toBe(true);
    expect(params(watchOf("VulnerabilityReport")!)).toMatchObject({ namespaces: ["shop"], labelSelector: SELECTOR });
    expect(params(watchOf("ConfigAuditReport")!)).toMatchObject({ namespaces: ["shop"], labelSelector: SELECTOR });
    watchOf("VulnerabilityReport")!.emit(snapshot([vuln()]));
    watchOf("ConfigAuditReport")!.emit(snapshot([audit()]));
    await expect.poll(() => text()).toContain("CVE-2024-45491");
    expect(text()).toContain("Container nginx");
    expect(text()).toContain("4 vulnerabilities have a fixed version.");
    expect(text()).toContain("Configuration audit");
    expect(text()).toContain("KSV014");
    const openReport = byLabel("Open VulnerabilityReport replicaset-web-7d9c6b8f5d-nginx")[0]!;
    expect(openReport.textContent).toBe("Open the report");
    openReport.click();
    await expect.poll(() => opened).toEqual([{ kind: { group: "aquasecurity.github.io", version: "v1alpha1", kind: "VulnerabilityReport" }, namespace: "shop", name: "replicaset-web-7d9c6b8f5d-nginx" }]);
    expect(byLabel("Open ConfigAuditReport replicaset-web-7d9c6b8f5d")).toHaveLength(1);
  });

  it(`lists at most ${DETAILS_TOP} rows of a report, and says how many there are`, async () => {
    const big = vuln();
    const list = (big.report as { vulnerabilities: unknown[] }).vulnerabilities;
    for (let i = 0; i < 20; i++) list.push({ vulnerabilityID: `CVE-X-${i}`, severity: "LOW", resource: "x", installedVersion: "1" });
    const sts: KubeObject = { apiVersion: "apps/v1", kind: "StatefulSet", metadata: { name: "db", namespace: "shop", uid: "s-1" }, spec: { selector: { matchLabels: { app: "db" } } } };
    await open(sts, { contribution: "scans" });
    await expect.poll(() => watchOf("VulnerabilityReport") !== undefined).toBe(true);
    expect(watchOf("ReplicaSet")).toBeUndefined();
    expect(params(watchOf("VulnerabilityReport")!).labelSelector).toBe("trivy-operator.resource.kind=StatefulSet,trivy-operator.resource.name=db");
    const labels = big.metadata.labels as Record<string, string>;
    labels["trivy-operator.resource.kind"] = "StatefulSet";
    labels["trivy-operator.resource.name"] = "db";
    watchOf("VulnerabilityReport")!.emit(snapshot([big]));
    await expect.poll(() => cells(1).length).toBe(DETAILS_TOP);
    expect(text()).toContain(`Listed: the ${DETAILS_TOP} most severe of 25.`);
  });

  it("files a Pod's reports under its controller, a CronJob's Job's under the CronJob", async () => {
    const pod: KubeObject = { apiVersion: "v1", kind: "Pod", metadata: { name: "backup-29312520-abcde", namespace: "shop", ownerReferences: [{ apiVersion: "batch/v1", kind: "Job", name: "backup-29312520", uid: "j", controller: true }] } };
    await open(pod, { contribution: "scans" });
    await expect.poll(() => watchOf("VulnerabilityReport") !== undefined).toBe(true);
    expect(params(watchOf("VulnerabilityReport")!).labelSelector).toBe("trivy-operator.resource.kind=CronJob,trivy-operator.resource.name=backup");
  });

  it("says when there are no reports yet, and when they cannot be read", async () => {
    await open(deployment(), { contribution: "scans" });
    await expect.poll(() => watchOf("ReplicaSet") !== undefined).toBe(true);
    watchOf("ReplicaSet")!.emit(snapshot([replicaSet("web-7d9c6b8f5d", 2)]));
    await expect.poll(() => watchOf("VulnerabilityReport") !== undefined).toBe(true);
    watchOf("VulnerabilityReport")!.emit(snapshot([]));
    await expect.poll(() => text()).toContain("Trivy Operator has no reports for this object yet.");
    watchOf("ConfigAuditReport")!.emit({ type: "error", code: "forbidden", message: "no" } as WatchUpdate);
    await expect.poll(() => text()).toContain("Could not read the Trivy reports.");
    expect(root.querySelector(".sec-note--warning")).not.toBeNull();
    expect(text()).not.toContain("no reports for this object");
  });

  it("watches nothing while its block is closed, and again once it opens", async () => {
    await open(deployment(), { contribution: "scans", blocks: { [SCANS_BLOCK]: false } });
    await expect.poll(() => hidden).toBe(false);
    expect(live()).toHaveLength(0);
    (root.querySelector(".sx-block__toggle") as HTMLButtonElement).click();
    await expect.poll(() => watchOf("ReplicaSet") !== undefined).toBe(true);
    expect(remembered[SCANS_BLOCK]).toBe(true);
    (root.querySelector(".sx-block__toggle") as HTMLButtonElement).click();
    await expect.poll(() => live()).toHaveLength(0);
  });

  it("stays hidden where the cluster serves neither report kind, or its kinds cannot be told", async () => {
    await open(deployment(), { contribution: "scans", kinds: [] });
    await new Promise((r) => setTimeout(r, 20));
    expect(hidden).toBe(true);
    expect(host.watches).toHaveLength(0);
    stop();
    root.remove();
    host.close();
    await open(deployment(), { contribution: "scans", kinds: new Error("discovery failed") });
    await new Promise((r) => setTimeout(r, 20));
    expect(hidden).toBe(true);
    expect(host.watches).toHaveLength(0);
  });

  it("asks the cluster's kinds again when they change, as the built-in block followed discovery", async () => {
    let kinds: unknown[] = [];
    let asked = 0;
    await open(deployment(), {
      contribution: "scans",
      kindsVersion: 1,
      kinds: () => {
        asked += 1;
        return kinds;
      },
    });
    await expect.poll(() => asked).toBe(1);
    await new Promise((r) => setTimeout(r, 20));
    expect(hidden).toBe(true);
    expect(host.watches).toHaveLength(0);
    // Trivy Operator installed: the block comes without the details being opened again.
    kinds = BOTH;
    host.setContext({ kindsVersion: 2 });
    await expect.poll(() => hidden).toBe(false);
    expect(asked).toBe(2);
    await expect.poll(() => watchOf("ReplicaSet") !== undefined).toBe(true);
    // A context change that leaves the kinds as they were asks nothing.
    host.setContext({ resourceVersion: "1" });
    await new Promise((r) => setTimeout(r, 20));
    expect(asked).toBe(2);
    // And removed: the block goes, with its watches.
    kinds = [];
    host.setContext({ kindsVersion: 3 });
    await expect.poll(() => hidden).toBe(true);
    await expect.poll(() => live()).toHaveLength(0);
  });

  it("with only configuration audits served, watches those and says there are none until it hears", async () => {
    const sts: KubeObject = { apiVersion: "apps/v1", kind: "StatefulSet", metadata: { name: "db", namespace: "shop", uid: "s-1" } };
    await open(sts, { contribution: "scans", kinds: [BOTH[1]] });
    await expect.poll(() => watchOf("ConfigAuditReport") !== undefined).toBe(true);
    expect(watchOf("VulnerabilityReport")).toBeUndefined();
    // As the built-in block: "none" is said once the image reports answered, and they are not served here.
    expect(text()).toContain("Trivy Operator has no reports for this object yet.");
  });
});
