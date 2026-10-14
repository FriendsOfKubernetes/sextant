// The SDK's copy of the protocol and of the manifest types against Sextant's own: the constants at run time, the
// types by the compiler (`tsc -p sdk/tsconfig.test.json`, part of `npm run sdk:check`).
import { describe, expect, expectTypeOf, it } from "vitest";
import type { AccessAction } from "../../src/api/generated/AccessAction";
import type { AccessRule } from "../../src/api/generated/AccessRule";
import type { ActionContribution } from "../../src/api/generated/ActionContribution";
import type { ClusterScope } from "../../src/api/generated/ClusterScope";
import type { ColumnContribution } from "../../src/api/generated/ColumnContribution";
import type { Contributions } from "../../src/api/generated/Contributions";
import type { DetailsSectionContribution } from "../../src/api/generated/DetailsSectionContribution";
import type { DockActionContribution } from "../../src/api/generated/DockActionContribution";
import type { ExtensionManifest } from "../../src/api/generated/ExtensionManifest";
import type { ExtensionPermissions } from "../../src/api/generated/ExtensionPermissions";
import type { KindScope } from "../../src/api/generated/KindScope";
import type { NamespaceScope } from "../../src/api/generated/NamespaceScope";
import type { PageContribution } from "../../src/api/generated/PageContribution";
import type { SettingsContribution } from "../../src/api/generated/SettingsContribution";
import * as host from "../../src/extensions/protocol";
import type {
  ExtensionAction,
  ManifestAction,
  ManifestClusterScope,
  ManifestColumn,
  ManifestContributions,
  ManifestDetailsSection,
  ManifestDockAction,
  ManifestFile,
  ManifestKindScope,
  ManifestNamespaceScope,
  ManifestPage,
  ManifestRule,
  ManifestSettings,
} from "../src/manifest";
import * as sdk from "../src/protocol";

/** `T` as one flat object type. */
type Simplify<T> = { [K in keyof T]: T[K] } & {};

describe("protocol", () => {
  it("has Sextant's constants", () => {
    expect(sdk.PROTOCOL_VERSION).toBe(host.PROTOCOL_VERSION);
    expect([...sdk.REMOTE_METHODS]).toEqual([...host.REMOTE_METHODS]);
    expect([...sdk.LOCAL_METHODS]).toEqual([...host.LOCAL_METHODS]);
    expect([...sdk.THEME_TOKENS]).toEqual([...host.THEME_TOKENS]);
    expect(sdk.DOC_PATTERN.source).toBe(host.DOC_PATTERN.source);
    expect(sdk.MAX_NOTICE_CHARS).toBe(host.MAX_NOTICE_CHARS);
    expect(sdk.MAX_STREAMS_PER_DOCUMENT).toBe(host.MAX_STREAMS_PER_DOCUMENT);
    expect(sdk.MAX_FRAME_HEIGHT).toBe(host.MAX_FRAME_HEIGHT);
  });

  it("has Sextant's message and context types", () => {
    expectTypeOf<sdk.HostContext>().toEqualTypeOf<host.HostContext>();
    expectTypeOf<sdk.FrameView>().toEqualTypeOf<host.FrameView>();
    expectTypeOf<sdk.RequestId>().toEqualTypeOf<host.RequestId>();
    expectTypeOf<sdk.ProtocolError>().toEqualTypeOf<host.ProtocolError>();
    expectTypeOf<sdk.FrameMessage>().toEqualTypeOf<
      Simplify<host.ReadyMessage> | Simplify<host.RequestMessage> | Simplify<host.ResizeMessage> | Simplify<host.FrameErrorMessage>
    >();
    expectTypeOf<sdk.HostMessage>().toEqualTypeOf<
      Simplify<host.ResultMessage> | Simplify<host.ErrorMessage> | Simplify<host.StreamMessage> | Simplify<host.ContextMessage>
    >();
    // Every message the SDK sends is one the host parses.
    const doc = "a".repeat(32);
    const sent: sdk.FrameMessage[] = [
      { sextant: 1, doc, type: "ready" },
      { sextant: 1, doc, id: 1, method: "clusters.list" },
      { sextant: 1, doc, type: "resize", height: 10 },
      { sextant: 1, doc, type: "error", message: "x" },
    ];
    for (const message of sent) expect(host.parseFrameMessage(message)).toEqual(message);
  });
});

describe("manifest types", () => {
  it("are Sextant's, with the defaults Sextant fills left optional", () => {
    expectTypeOf<ExtensionAction>().toEqualTypeOf<Exclude<AccessAction, "exec" | "portForward">>();
    expectTypeOf<ManifestClusterScope>().toEqualTypeOf<ClusterScope>();
    expectTypeOf<ManifestNamespaceScope>().toEqualTypeOf<NamespaceScope>();
    expectTypeOf<ManifestKindScope>().toEqualTypeOf<KindScope>();
    expectTypeOf<Simplify<Omit<ManifestRule, "confirm" | "actions"> & { confirm: boolean; actions: AccessAction[] }>>()
      .toEqualTypeOf<AccessRule>();
    expectTypeOf<ManifestPage>().toEqualTypeOf<PageContribution>();
    expectTypeOf<ManifestDetailsSection>().toEqualTypeOf<DetailsSectionContribution>();
    expectTypeOf<Simplify<Omit<ManifestAction, "danger" | "multiple"> & { danger: boolean; multiple: boolean }>>()
      .toEqualTypeOf<ActionContribution>();
    expectTypeOf<ManifestColumn>().toEqualTypeOf<ColumnContribution>();
    expectTypeOf<ManifestDockAction>().toEqualTypeOf<DockActionContribution>();
    expectTypeOf<ManifestSettings>().toEqualTypeOf<SettingsContribution>();
    expectTypeOf<keyof ManifestContributions>().toEqualTypeOf<keyof Contributions>();
    expectTypeOf<keyof ManifestFile>().toEqualTypeOf<keyof ExtensionManifest | "$schema">();
    expectTypeOf<keyof ManifestFile["permissions"]>().toEqualTypeOf<keyof ExtensionPermissions>();
    expect(true).toBe(true);
  });
});
