// Fixtures and a timer for the scale measurements (#157). The measurements run only with `SEXTANT_SCALE=1`
// (`SEXTANT_SCALE=1 npx vitest run scale`), so the regular suite stays fast; the small checks next to them always run.
import { appendFileSync } from "node:fs";
import type { KubeObject } from "../api";
import type { JsonValue } from "../api/generated/serde_json/JsonValue";

/** Whether the measurements run. */
export const MEASURE = typeof process !== "undefined" && process.env.SEXTANT_SCALE === "1";

/** A pod as a cluster lists it (managedFields left out), like the Rust fixture `pod_json`. */
export function scalePod(i: number): KubeObject {
  const node = i % 250;
  return {
    apiVersion: "v1",
    kind: "Pod",
    metadata: {
      name: `web-${i}-7f9c6d5b8-x${String(i).padStart(5, "0")}`,
      generateName: `web-${i}-7f9c6d5b8-`,
      namespace: `team-${i % 50}`,
      uid: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
      resourceVersion: String(1000 + i),
      creationTimestamp: "2026-10-01T10:00:00Z",
      labels: { app: `web-${i % 200}`, "pod-template-hash": "7f9c6d5b8", tier: "frontend" },
      annotations: { "prometheus.io/scrape": "true" },
      ownerReferences: [
        { apiVersion: "apps/v1", kind: "ReplicaSet", name: `web-${i}-7f9c6d5b8`, uid: `rs-${i}`, controller: true },
      ],
    },
    spec: {
      nodeName: `node-${node}`,
      containers: [
        {
          name: "web",
          image: "registry.example.com/web:1.2.3",
          resources: { requests: { cpu: "100m", memory: "128Mi" }, limits: { memory: "256Mi" } },
        },
      ],
      restartPolicy: "Always",
      serviceAccountName: "default",
    },
    status: {
      phase: i % 97 === 0 ? "Pending" : "Running",
      hostIP: `10.0.0.${node}`,
      podIP: `10.244.${node}.${i % 250}`,
      qosClass: "Burstable",
      conditions: [{ type: "Ready", status: "True" }],
      containerStatuses: [
        { name: "web", ready: true, restartCount: i % 13, state: { running: { startedAt: "2026-10-01T10:00:04Z" } } },
      ],
    },
  };
}

export function scalePods(n: number): KubeObject[] {
  return Array.from({ length: n }, (_, i) => scalePod(i));
}

/** The median of `runs` timings of `fn`, in milliseconds (one warm-up run first). */
export function median(fn: () => unknown, runs = 5): number {
  fn();
  const times: number[] = [];
  for (let i = 0; i < runs; i++) {
    const start = performance.now();
    fn();
    times.push(performance.now() - start);
  }
  times.sort((a, b) => a - b);
  return times[Math.floor(times.length / 2)]!;
}

/** Prints one measurement line, and appends it to the file `SEXTANT_SCALE_OUT` names (collected for the wiki). */
export function report(line: string): void {
  console.log(`[scale] ${line}`);
  const out = process.env.SEXTANT_SCALE_OUT;
  if (out) appendFileSync(out, `${line}\n`);
}

/** Objects as the items of a watch update. */
export function asItems(objs: KubeObject[]): JsonValue[] {
  return objs as unknown as JsonValue[];
}
