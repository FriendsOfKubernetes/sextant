// The kubeconfig items of the cluster rail (#150): expiry states and notifier problems, the forms' edits, and the
// rename flow from the cluster menu (preview first, write on the second click, the list follows the new name).
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  mockBackend,
  type ClusterInfo,
  type CredentialExpiry,
  type EditOutcome,
  type EditPreview,
  type KubeconfigSource,
  type MockBackend,
} from "../../../api";
import { resetAppStore } from "../../../app/store";
import { AppShell } from "../../../layout";
import { resetClustersStore } from "../clustersStore";
import "../index";
import { sourceKindLabelKey } from "../sources";
import { editOf } from "./ContextEditDialog";
import { credentialProblems } from "./CredentialsNotifier";
import { expiryState, resetCredentials } from "./credentials";

const DAY = 24 * 3600_000;
const home: KubeconfigSource = { id: "src-home", path: "/home/me/.kube/config", kind: "default", error: null };
const alpha: ClusterInfo = {
  id: "aaaa",
  context: "kind-alpha",
  clusterName: "alpha",
  server: "https://alpha.example:6443",
  user: "admin",
  namespace: null,
  sourceId: "src-home",
};

function credential(expiresAt: string | null, extra: Partial<CredentialExpiry> = {}): CredentialExpiry {
  return { clusterId: "aaaa", kind: "clientCertificate", expiresAt, command: null, refreshable: false, problem: null, ...extra };
}

describe("credential expiry", () => {
  it("is expired, expiring within the warning days, valid, or unknown", () => {
    const now = Date.parse("2026-10-19T00:00:00Z");
    expect(expiryState(credential("2026-10-18T00:00:00Z"), 14, now)).toBe("expired");
    expect(expiryState(credential("2026-10-25T00:00:00Z"), 14, now)).toBe("expiring");
    expect(expiryState(credential("2027-10-25T00:00:00Z"), 14, now)).toBe("valid");
    expect(expiryState(credential(null, { kind: "exec", command: "aws" }), 14, now)).toBe("unknown");
    expect(expiryState(undefined, 14, now)).toBe("unknown");
  });

  it("gives the notifier an expiring and an expired problem at their times, none when unknown", () => {
    const at = Date.parse("2026-11-01T00:00:00Z");
    const problems = credentialProblems(alpha, credential("2026-11-01T00:00:00Z"), 7, at - 30 * DAY);
    expect(problems.map((p) => [p.reason, p.activeAt, p.until])).toEqual([
      ["CredentialsExpiring", at - 7 * DAY, at],
      ["CredentialsExpired", at, undefined],
    ]);
    expect(problems.every((p) => p.category === "credentials" && p.notify)).toBe(true);
    expect(credentialProblems(alpha, credential(null), 7, at)).toEqual([]);
  });
});

describe("edits from the form", () => {
  it("are built only when complete", () => {
    expect(editOf("rename", alpha, " prod ", "")).toEqual({ type: "renameContext", clusterId: "aaaa", newName: "prod" });
    expect(editOf("rename", alpha, "  ", "")).toBeNull();
    expect(editOf("namespace", alpha, "", " ")).toEqual({ type: "setNamespace", clusterId: "aaaa", namespace: null });
    expect(editOf("duplicate", alpha, "copy", "")).toBeNull();
    expect(editOf("duplicate", alpha, "copy", "web")).toEqual({
      type: "duplicateContext",
      clusterId: "aaaa",
      newName: "copy",
      namespace: "web",
    });
    expect(editOf("delete", alpha, "", "")).toEqual({ type: "deleteContext", clusterId: "aaaa" });
    expect(sourceKindLabelKey("merged")).toBe("kubeconfig:sources.kindMerged");
    expect(sourceKindLabelKey("pasted")).toBe("clusters:sources.kind.pasted");
  });
});

describe("rename context from the cluster menu", () => {
  let backend: MockBackend;
  let clusters: ClusterInfo[];
  const preview: EditPreview = {
    sourceId: "src-home",
    path: "/home/me/.kube/config",
    target: { realPath: "/home/me/.kube/config", backupPattern: "/home/me/.kube/config.bak-YYYYMMDD-HHMMSS", backupsKept: 5 },
    currentContextElsewhere: [],
    createsFile: false,
    ownFile: false,
    changes: [{ entry: "context", change: "renamed", name: "kind-alpha", newName: "prod", origin: null, fields: [] }],
    commentsLost: true,
    layoutChanges: false,
    unchanged: false,
    base: "base-1",
    renamed: [{ from: "aaaa", to: "pppp" }],
    removed: [],
    added: [],
    changed: [],
  };

  beforeEach(() => {
    resetAppStore();
    resetClustersStore();
    resetCredentials();
    clusters = [alpha];
    backend = mockBackend({
      clusters_list: () => clusters,
      kubeconfig_sources: () => [home],
      cluster_state: () => ({ state: "disconnected" }),
      cluster_disconnect: () => undefined,
      kubeconfig_credentials: () => [credential(new Date(Date.now() + 2 * DAY).toISOString())],
      kubeconfig_edit_preview: () => preview,
      kubeconfig_edit_apply: (): EditOutcome => {
        clusters = [{ ...alpha, id: "pppp", context: "prod" }];
        return {
          source: home,
          backupPath: "/home/me/.kube/config.bak-20261019-000000",
          renamed: preview.renamed,
          removed: [],
          added: [],
          changed: [],
        };
      },
    });
  });
  afterEach(() => {
    resetClustersStore();
    backend.restore();
  });

  it("previews the change, writes it only on the second click and refreshes the list", async () => {
    render(<AppShell />);
    const rail = screen.getByRole("navigation", { name: "Clusters" });
    const icon = await within(rail).findByRole("button", { name: "kind-alpha" });
    // Credentials that expire within the warning days are marked on the cluster.
    expect(await within(rail).findByRole("img", { name: "Credentials expire soon" })).toBeInTheDocument();

    fireEvent.contextMenu(icon);
    fireEvent.click(screen.getByRole("menuitem", { name: "Rename context…" }));
    const dialog = await screen.findByRole("dialog", { name: "Rename context" });
    fireEvent.change(within(dialog).getByLabelText("New context name"), { target: { value: "prod" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Preview" }));
    expect(await within(dialog).findByText("kind-alpha → prod")).toBeInTheDocument();
    expect(within(dialog).getByText("The file has comments. They are not kept when the file is written.")).toBeInTheDocument();
    expect(backend.calls.filter((c) => c.cmd === "kubeconfig_edit_apply")).toHaveLength(0);

    fireEvent.click(within(dialog).getByRole("button", { name: "Write to the file" }));
    await waitFor(() => expect(backend.calls.filter((c) => c.cmd === "kubeconfig_edit_apply")).toHaveLength(1));
    const apply = backend.calls.find((c) => c.cmd === "kubeconfig_edit_apply");
    expect(apply?.args).toEqual({ edit: { type: "renameContext", clusterId: "aaaa", newName: "prod" }, base: "base-1" });
    expect(await within(rail).findByRole("button", { name: "prod" })).toBeInTheDocument();
    expect(within(dialog).getByText(/config\.bak-20261019-000000/)).toBeInTheDocument();
  });
});
