// The details sections, driven through the SDK's stand-in for Sextant's window, as the built-in view's tests drove it.
import type { KubeObject, WatchUpdate } from "@sextant/extension-sdk";
import { startTestHost, type TestHost, type TestWatch } from "@sextant/extension-sdk/testing";
import { afterEach, describe, expect, it } from "vitest";
import manifest from "../sextant-extension.json";
import eventingJson from "../fixtures/eventing.json";
import revisionsJson from "../fixtures/revisions.json";
import serviceJson from "../fixtures/service.json";
import { startDetails } from "./details";
import { setLanguage } from "./i18n";

const eventing = eventingJson as unknown as KubeObject[];
const find = (kind: string, name: string): KubeObject => structuredClone(eventing.find((o) => o.kind === kind && o.metadata.name === name)!);
const service = serviceJson as unknown as KubeObject;
const [, failedRevision] = revisionsJson as unknown as KubeObject[];

const ref = (o: KubeObject) => ({
  kind: { group: o.apiVersion!.split("/")[0]!, version: o.apiVersion!.split("/")[1]!, kind: o.kind! },
  namespace: o.metadata.namespace ?? null,
  name: o.metadata.name,
});
const sectionOf = (o: KubeObject) => manifest.contributes.detailsSections.find((d) => d.kinds[0]!.kind === o.kind)!.id;

const SERVED = [
  ["eventing.knative.dev", "v1", "Broker"],
  ["eventing.knative.dev", "v1", "Trigger"],
  ["sources.knative.dev", "v1", "PingSource"],
  ["sources.knative.dev", "v1", "ApiServerSource"],
] as const;
const kinds = (served: readonly (readonly [string, string, string])[]) =>
  served.map(([group, version, kind]) => ({ kindRef: { group, version, kind }, plural: `${kind.toLowerCase()}s`, namespaced: true, verbs: ["list", "watch"], printerColumns: [] }));

let host: TestHost;
let root: HTMLElement;
let stop: () => void = () => undefined;

async function open(obj: KubeObject, served: readonly (readonly [string, string, string])[] = SERVED): Promise<void> {
  host = await startTestHost({
    context: { view: "details", contribution: sectionOf(obj), selection: [ref(obj)], resourceVersion: "1" },
    handlers: { "resources.get": () => structuredClone(obj), kinds: () => kinds(served) },
  });
  root = document.createElement("main");
  document.body.append(root);
  stop = startDetails(host.sextant, root);
  await expect.poll(() => root.querySelector(".sx-loading")).toBeNull();
}

afterEach(() => {
  setLanguage("en");
  stop();
  root?.remove();
  host?.close();
});

const text = () => root.textContent ?? "";
const byLabel = (label: string) => [...root.querySelectorAll("button")].filter((b) => b.getAttribute("aria-label") === label);
type Params = { kind: { group?: string; version?: string; kind: string }; namespaces?: string[] };
const watchParams = (w: TestWatch) => w.params as Params;
const watchOf = (kind: string) => host.watches.find((w) => watchParams(w).kind.kind === kind && !w.stopped);
const snapshot = (items: KubeObject[]): WatchUpdate => ({ type: "snapshot", items: items as never });
const rows = () => [...root.querySelectorAll("tbody tr")].map((r) => [...r.querySelectorAll("td")].map((c) => c.textContent));
const callOf = (method: string) => host.calls.filter((c) => c.method === method).at(-1)?.params;

describe("details of Knative Serving", () => {
  it("of a Service: why it is not ready, the revisions and the traffic split with links", async () => {
    await open(service);
    expect(text()).toContain("The latest revision hello-00003 failed (RevisionFailed). Traffic stays on hello-00002, the last revision that became ready.");
    expect(root.querySelector(".kn-explain--danger")).not.toBeNull();
    expect(root.querySelector(".kn-message")?.textContent).toContain('Revision "hello-00003" failed');
    expect(text()).toContain("http://hello.default.example.com");
    expect(text()).toContain("Address in the cluster");
    expect(root.querySelector(".sx-status--danger")?.textContent).toBe("Failed");
    expect(byLabel("Open Revision hello-00003")).toHaveLength(1);
    expect(byLabel("Open Revision hello-00001")).toHaveLength(1);
    expect(rows()).toEqual([
      ["hello-00001", "v1", "20%", "", "http://v1-hello.default.example.com"],
      ["hello-00002", "", "80%", "Yes", ""],
    ]);
    expect(root.querySelector("[aria-label='Traffic']")).not.toBeNull();
    byLabel("Open Revision hello-00003")[0]!.click();
    await expect.poll(() => callOf("ui.openDetails")).toEqual({
      kind: { group: "serving.knative.dev", version: "v1", kind: "Revision" },
      namespace: "default",
      name: "hello-00003",
    });
  });

  it("of a Route without a split in effect: the asked one", async () => {
    const route = { ...structuredClone(service), kind: "Route" };
    delete (route.status as Record<string, unknown>).traffic;
    await open(route);
    expect(text()).toContain("Traffic (asked, not yet in effect)");
    expect(rows()[1]).toEqual(["Latest ready revision (hello-00002)", "", "80%", "Yes", ""]);
  });

  it("of a Revision: the failing container, its Configuration and replicas", async () => {
    await open(structuredClone(failedRevision!));
    expect(text()).toContain("The container does not start or fails its health checks (ExitCode1).");
    expect(byLabel("Open Configuration hello")).toHaveLength(1);
    expect(byLabel("Open Service hello")).toHaveLength(1);
    expect(text()).toContain("0 of 1");
    expect(text()).toContain("10");
    expect(text()).toContain("300 s");
    // Serving views watch nothing.
    expect(host.watches).toHaveLength(0);
  });

  it("of a DomainMapping: the Service it points at", async () => {
    const dm = { ...structuredClone(service), apiVersion: "serving.knative.dev/v1beta1", kind: "DomainMapping", spec: { ref: { apiVersion: "serving.knative.dev/v1", kind: "Service", name: "hello" } } };
    await open(dm);
    expect(byLabel("Open Service hello")).toHaveLength(1);
    expect(text()).toContain("Points at");
  });
});

describe("details of Knative Eventing", () => {
  it("of a Broker: its address and the event path from the namespace's sources to the subscribers", async () => {
    await open(find("Broker", "default"));
    expect(text()).toContain("Ready: receives events at http://broker-ingress.knative-eventing.svc.cluster.local/default/default.");
    expect(text()).toContain("MTChannelBasedBroker");
    expect(byLabel("Open ConfigMap config-br-default-channel")).toHaveLength(1);
    await expect.poll(() => watchOf("Trigger")).toBeDefined();
    expect(text()).toContain("Reading the objects on the path…");
    expect(watchParams(watchOf("Trigger")!)).toMatchObject({ kind: { group: "eventing.knative.dev", version: "v1" }, namespaces: ["default"] });
    // Kinds the cluster does not serve are never watched, and Brokers and Subscriptions are not needed here.
    expect(host.watches.map((w) => watchParams(w).kind.kind).sort()).toEqual(["ApiServerSource", "PingSource", "Trigger"]);
    watchOf("Trigger")!.emit(snapshot([find("Trigger", "my-service-trigger"), find("Trigger", "orders-trigger")]));
    watchOf("PingSource")!.emit(snapshot([find("PingSource", "test-ping-source")]));
    watchOf("ApiServerSource")!.emit(snapshot([]));
    await expect.poll(() => byLabel("Open Trigger orders-trigger")).toHaveLength(1);
    expect(text()).not.toContain("Reading the objects on the path…");
    expect(byLabel("Open PingSource test-ping-source")).toHaveLength(1);
    expect(byLabel("Open Service event-display").length).toBeGreaterThan(0);
    expect(text()).toContain("Sent here by:");
    expect(root.querySelector("[aria-current='true']")?.textContent).toContain("default");
    // The filter of each Trigger in words beside it, the subscriber with the address it resolved to.
    expect(text()).toContain("type is dev.knative.sources.ping");
    expect(text()).toContain("http://event-display.default.svc.cluster.local");
  });

  it("closing the event path stops its watches; opening it again starts them", async () => {
    await open(find("Broker", "default"));
    await expect.poll(() => watchOf("Trigger")).toBeDefined();
    const toggle = [...root.querySelectorAll<HTMLButtonElement>(".sx-block__toggle")].find((b) => b.textContent === "Event path")!;
    toggle.click();
    await expect.poll(() => host.watches.filter((w) => !w.stopped)).toHaveLength(0);
    const again = [...root.querySelectorAll<HTMLButtonElement>(".sx-block__toggle")].find((b) => b.textContent === "Event path")!;
    expect(again.getAttribute("aria-expanded")).toBe("false");
    again.click();
    await expect.poll(() => watchOf("Trigger")).toBeDefined();
  });

  it("of a Trigger: why it is not ready, its filter in words and its Broker", async () => {
    await open(find("Trigger", "orders-trigger"));
    expect(text()).toContain("Its subscriber Service/orders /events cannot be resolved to an address");
    expect(text()).toContain("type is com.example.order");
    expect(text()).toContain("any of: source starts with /orders/, subject ends with .json");
    expect(text()).toContain("spec.filter is ignored");
    expect(byLabel("Open Broker default").length).toBeGreaterThan(0);
    // The path of a Trigger reads its Broker and the sources of the Broker's namespace.
    await expect.poll(() => watchOf("Broker")).toBeDefined();
    expect(watchOf("Trigger")).toBeUndefined();
  });

  it("of a Subscription: its channel, subscriber and reply; of a SinkBinding: its subject by selector", async () => {
    await open(find("Subscription", "my-subscription"));
    expect(byLabel("Open Channel my-channel").length).toBeGreaterThan(0);
    expect(byLabel("Open Broker default").length).toBeGreaterThan(0);
    stop();
    root.remove();
    host.close();
    await open(find("SinkBinding", "bind-heartbeat"));
    expect(text()).toContain("Job app=heartbeat-cron");
    expect(text()).toContain("Ready: the sink address");
  });

  it("of a Sequence: its steps in order; of a Parallel: its branches", async () => {
    await open(find("Sequence", "sequence"));
    expect(text()).toContain("Not ready yet: Knative is still setting it up.");
    expect([...root.querySelectorAll(".kn-chain__kind")].map((n) => n.textContent)).toContain("Step 3");
    stop();
    root.remove();
    host.close();
    await open(find("Parallel", "odd-even-parallel"));
    expect(text()).toContain("Branch 2");
    expect(byLabel("Open Service odd-filter")).toHaveLength(1);
  });

  it("speak the UI language", async () => {
    setLanguage("de");
    await open(find("Trigger", "orders-trigger"));
    expect(text()).toContain("type ist com.example.order");
    expect(text()).toContain("Event-Pfad");
  });
});
