// The window protocol as released (version 1), frozen (ADR-0142). Every extension published so far carries an SDK
// that relies on it: Sextant may add methods, tokens, context fields and answer fields, and raise limits, but never
// take any of these away, rename them, change their type, lower a limit or make a frame send more than it did.
// Sextant's side is checked at run time and, for the types, by the compiler (`tsc -p sdk/tsconfig.test.json`).
import { describe, expect, expectTypeOf, it } from "vitest";
import type { CoreError } from "../../src/api/generated/CoreError";
import type { ErrorCode } from "../../src/api/generated/ErrorCode";
import type { MetricAnswer } from "../../src/api/generated/MetricAnswer";
import type { ObjectRef } from "../../src/api/generated/ObjectRef";
import type { ResourceKind } from "../../src/api/generated/ResourceKind";
import type { WatchUpdate } from "../../src/api/generated/WatchUpdate";
import * as host from "../../src/extensions/protocol";

const RELEASED = {
  version: 1,
  remoteMethods: [
    "clusters.list",
    "kinds",
    "resources.list",
    "resources.get",
    "resources.watch",
    "resources.apply",
    "resources.patch",
    "resources.delete",
    "logs.tail",
    "secret.value",
    "metrics.query",
    "storage.get",
    "storage.set",
    "storage.remove",
    "backend.call",
  ],
  localMethods: ["context.get", "ui.openDetails", "ui.navigate", "ui.notify", "ui.close", "resources.unwatch"],
  themeTokens: [
    "--color-bg",
    "--color-rail",
    "--color-sidebar",
    "--color-main",
    "--color-panel",
    "--color-dock",
    "--color-dock-header",
    "--color-text",
    "--color-text-muted",
    "--color-border",
    "--color-hover",
    "--color-selected",
    "--color-accent",
    "--color-accent-text",
    "--color-danger",
    "--color-warning",
    "--color-success",
    "--color-focus",
    "--color-on-status",
    "--shadow-panel",
    "--control-height",
    "--control-height-compact",
    "--control-font-size",
    "--icon-size",
    "--font-family",
    "--font-mono",
  ],
  docPattern: "^[A-Za-z0-9_-]{16,128}$",
  // Lower bounds: Sextant may allow more, never less.
  maxNoticeChars: 500,
  maxStreamsPerDocument: 32,
  maxDocumentsPerFrame: 8,
  maxFrameHeight: 5000,
  views: ["page", "details", "action", "dock", "settings"],
  settingsContribution: "settings",
};

/** The context as released: every field an extension may read. */
interface ReleasedContext {
  apiVersion: 1;
  extensionId: string;
  view: "page" | "details" | "action" | "dock" | "settings";
  contribution: string;
  clusterId: string | null;
  namespaces: string[] | null;
  theme: "light" | "dark";
  language: string;
  tokens: Record<string, string>;
  selection: ReleasedRef[];
  resourceVersion: string | null;
}

interface ReleasedKindRef {
  group: string;
  version: string;
  kind: string;
}
interface ReleasedRef {
  kind: ReleasedKindRef;
  namespace: string | null;
  name: string;
}

/** What a `kinds` answer gives for each kind. */
interface ReleasedKind {
  kindRef: ReleasedKindRef;
  plural: string;
  namespaced: boolean;
  verbs: string[];
  printerColumns: { name: string; jsonPath: string; type: string; priority: number }[];
}

/** Every error code a released SDK passes on (Sextant may add codes). */
type ReleasedErrorCode =
  | "unreachable"
  | "unauthorized"
  | "forbidden"
  | "notFound"
  | "conflict"
  | "invalid"
  | "authPlugin"
  | "helmMissing"
  | "portInUse"
  | "kubeconfig"
  | "timeout"
  | "denied"
  | "other";

/** The updates of a `resources.watch` as released (Sextant may add update types, sent only to API versions that know them). */
type ReleasedWatchUpdate =
  | { type: "snapshot"; items: unknown[] }
  | { type: "delta"; upserted: unknown[]; deleted: string[] }
  | { type: "reconnecting" }
  | ({ type: "error" } & { code: ReleasedErrorCode; message: string })
  | { type: "forbidden"; namespaces: string[] };

interface ReleasedMetricAnswer {
  resultType: string;
  series: { labels: Record<string, string>; points: [number, number | null][] }[];
}

describe("the released protocol (version 1) is still served", () => {
  it("keeps every method, token, view and limit", () => {
    expect(host.PROTOCOL_VERSION).toBe(RELEASED.version);
    expect(host.REMOTE_METHODS).toEqual(expect.arrayContaining(RELEASED.remoteMethods));
    expect(host.LOCAL_METHODS).toEqual(expect.arrayContaining(RELEASED.localMethods));
    expect(host.THEME_TOKENS).toEqual(expect.arrayContaining(RELEASED.themeTokens));
    expect(Object.values(host.VIEW)).toEqual(expect.arrayContaining(RELEASED.views));
    expect(host.SETTINGS_CONTRIBUTION).toBe(RELEASED.settingsContribution);
    expect(host.DOC_PATTERN.source).toBe(RELEASED.docPattern);
    expect(host.MAX_NOTICE_CHARS).toBeGreaterThanOrEqual(RELEASED.maxNoticeChars);
    expect(host.MAX_STREAMS_PER_DOCUMENT).toBeGreaterThanOrEqual(RELEASED.maxStreamsPerDocument);
    expect(host.MAX_DOCUMENTS_PER_FRAME).toBeGreaterThanOrEqual(RELEASED.maxDocumentsPerFrame);
    expect(host.MAX_FRAME_HEIGHT).toBeGreaterThanOrEqual(RELEASED.maxFrameHeight);
  });

  it("still parses every message a released SDK sends", () => {
    const doc = "0123456789abcdef0123456789abcdef";
    const sent = [
      { sextant: 1, doc, type: "ready" },
      { sextant: 1, doc, id: 1, method: "clusters.list" },
      { sextant: 1, doc, id: "a-1", method: "resources.get", params: { ref: { kind: { kind: "Pod" }, name: "x" } } },
      { sextant: 1, doc, type: "resize", height: 120 },
      { sextant: 1, doc, type: "error", message: "TypeError: x" },
    ];
    for (const message of sent) expect(host.parseFrameMessage(message)).toEqual(message);
  });

  it("sends a context, answers and updates a released SDK reads (types)", () => {
    // Sextant's types must still fit the released ones: fields may be added, none removed, renamed or widened.
    expectTypeOf<host.HostContext>().toExtend<ReleasedContext>();
    expectTypeOf<ObjectRef>().toExtend<ReleasedRef>();
    expectTypeOf<ResourceKind>().toExtend<ReleasedKind>();
    expectTypeOf<MetricAnswer>().toExtend<ReleasedMetricAnswer>();
    expectTypeOf<CoreError>().toExtend<{ code: string; message: string }>();
    // Every released code still exists, and every released update type is still sent as it was.
    expectTypeOf<ReleasedErrorCode>().toExtend<ErrorCode>();
    expectTypeOf<Extract<WatchUpdate, { type: ReleasedWatchUpdate["type"] }>>().toExtend<ReleasedWatchUpdate>();
    expectTypeOf<ReleasedWatchUpdate["type"]>().toExtend<WatchUpdate["type"]>();
  });
});
