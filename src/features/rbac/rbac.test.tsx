import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { KindRef, KubeObject, ObjectRef, ResourceKind } from "../../api";
import { resetAppStore, useAppStore } from "../../app/store";
import { DetailsPanel } from "../../layout/details/DetailsPanel";
import { Sidebar } from "../../layout/sidebar/Sidebar";
import { resetClusterKinds } from "../../resources";
import "../details";
import { emitSnapshot, watchBackend, watchOf, type WatchBackend } from "../details/testing";
import { resetNamespaceRestore } from "../namespaces";
import "./index";
import { RbacPage } from "./RbacPage";
import { sharedWatchCount } from "./sharedWatch";
import { RBAC_PAGE, resetRbacPageState, useRbacStore } from "./state";

const RBAC = "rbac.authorization.k8s.io/v1";

const clusterRoles: KubeObject[] = [
  {
    apiVersion: RBAC,
    kind: "ClusterRole",
    metadata: { name: "pod-reader", uid: "cr1" },
    rules: [{ verbs: ["get", "list"], apiGroups: [""], resources: ["pods", "pods/log"] }],
  },
  {
    apiVersion: RBAC,
    kind: "ClusterRole",
    metadata: { name: "secret-admin", uid: "cr2" },
    rules: [{ verbs: ["*"], apiGroups: [""], resources: ["secrets"] }],
  },
];
const roles: KubeObject[] = [
  {
    apiVersion: RBAC,
    kind: "Role",
    metadata: { name: "exec", namespace: "dev", uid: "r1" },
    rules: [{ verbs: ["create"], apiGroups: [""], resources: ["pods/exec"] }],
  },
];
const clusterRoleBindings: KubeObject[] = [
  {
    apiVersion: RBAC,
    kind: "ClusterRoleBinding",
    metadata: { name: "ops-secrets", uid: "crb1" },
    roleRef: { apiGroup: "rbac.authorization.k8s.io", kind: "ClusterRole", name: "secret-admin" },
    subjects: [{ kind: "Group", name: "ops" }],
  },
];
const roleBindings: KubeObject[] = [
  {
    apiVersion: RBAC,
    kind: "RoleBinding",
    metadata: { name: "alice-pods", namespace: "prod", uid: "rb1" },
    roleRef: { apiGroup: "rbac.authorization.k8s.io", kind: "ClusterRole", name: "pod-reader" },
    subjects: [{ kind: "User", name: "alice" }, { kind: "ServiceAccount", name: "web" }],
  },
  {
    apiVersion: RBAC,
    kind: "RoleBinding",
    metadata: { name: "dangling", namespace: "dev", uid: "rb2" },
    roleRef: { apiGroup: "rbac.authorization.k8s.io", kind: "Role", name: "gone" },
    subjects: [{ kind: "User", name: "alice" }],
  },
];

const served = (kind: KindRef, plural: string, namespaced = true): ResourceKind => ({
  kindRef: kind,
  plural,
  namespaced,
  verbs: ["list", "watch"],
  printerColumns: [],
});

let wb: WatchBackend;

beforeEach(() => {
  resetAppStore();
  resetClusterKinds();
  resetRbacPageState();
  resetNamespaceRestore();
  wb = watchBackend();
  wb.backend.on("cluster_kinds", () => [
    served({ group: "", version: "v1", kind: "Pod" }, "pods"),
    served({ group: "", version: "v1", kind: "Secret" }, "secrets"),
    served({ group: "", version: "v1", kind: "Node" }, "nodes", false),
  ]);
});

afterEach(() => {
  wb.backend.restore();
  resetClusterKinds();
});

const listWatch = (kind: string) => watchOf(wb, kind, (s) => s.fieldSelector === null);

async function feed(): Promise<void> {
  emitSnapshot(wb, await listWatch("ClusterRole"), clusterRoles);
  emitSnapshot(wb, await listWatch("Role"), roles);
  emitSnapshot(wb, await listWatch("ClusterRoleBinding"), clusterRoleBindings);
  emitSnapshot(wb, await listWatch("RoleBinding"), roleBindings);
  await waitFor(() => expect(screen.queryByText("Reading roles and bindings…")).toBeNull());
}

describe("the Permissions page", () => {
  it("is in the Access Control section of the sidebar", async () => {
    render(<Sidebar clusterId="c1" />);
    fireEvent.click(await screen.findByRole("button", { name: /Access Control/ }));
    fireEvent.click(screen.getByRole("button", { name: "Permissions" }));
    expect(useAppStore.getState().clusterViews.c1?.view).toBe(RBAC_PAGE);
  });

  it("shows a subject's permissions as a matrix with the granting binding, and warns about a missing role", async () => {
    render(<RbacPage clusterId="c1" />);
    await feed();
    expect(screen.getByText("3 subjects are named in bindings.")).toBeInTheDocument();
    fireEvent.change(screen.getByRole("searchbox", { name: /Search users/ }), { target: { value: "ali" } });
    fireEvent.click(screen.getByRole("button", { name: "User alice" }));

    expect(screen.getByText(/RoleBinding dev\/dangling refers to Role dev\/gone, which does not exist/)).toBeInTheDocument();
    expect(screen.getByText(/Also counts as a member of system:authenticated/)).toBeInTheDocument();
    const matrix = screen.getByRole("table", { name: "Permissions of User alice by verb and resource" });
    expect(within(matrix).queryByRole("button", { name: "delete pods: allowed" })).toBeNull();
    const cell = within(matrix).getByRole("button", { name: "get pods: allowed" });
    expect(cell).toHaveAttribute("title", "Allowed by 1 rule (RoleBinding prod/alice-pods). Click for the rule.");
    fireEvent.click(cell);
    const detail = screen.getByRole("region", { name: "get pods" });
    expect(within(detail).getByRole("button", { name: "Open RoleBinding alice-pods" })).toBeInTheDocument();
    expect(within(detail).getByRole("button", { name: "Open ClusterRole pod-reader" })).toBeInTheDocument();
    expect(detail).toHaveTextContent("Only in prod");

    // In dev the prod RoleBinding grants nothing.
    fireEvent.change(screen.getByRole("combobox", { name: "Namespace" }), { target: { value: "dev" } });
    expect(screen.getByText("No permissions found.")).toBeInTheDocument();
  });

  it("answers who can delete secrets, with the binding and the explained wildcard", async () => {
    render(<RbacPage clusterId="c1" />);
    await feed();
    fireEvent.click(screen.getByRole("tab", { name: "Who can" }));
    fireEvent.change(screen.getByRole("combobox", { name: "Verb" }), { target: { value: "delete" } });
    fireEvent.change(screen.getByRole("combobox", { name: "Resource" }), { target: { value: "secrets" } });
    fireEvent.change(screen.getByRole("combobox", { name: "Namespace" }), { target: { value: "prod" } });
    fireEvent.click(screen.getByRole("button", { name: "Find" }));
    expect(screen.getByText("1 grant allows it.")).toBeInTheDocument();
    const table = screen.getByRole("table", { name: "Subjects allowed" });
    expect(within(table).getByRole("button", { name: "Group ops" })).toBeInTheDocument();
    expect(within(table).getByRole("button", { name: "Open ClusterRoleBinding ops-secrets" })).toBeInTheDocument();
    expect(table).toHaveTextContent("Every verb, including escalate, bind and impersonate.");
    // The subject opens its own permissions.
    fireEvent.click(within(table).getByRole("button", { name: "Group ops" }));
    expect(useRbacStore.getState().clusters.c1).toMatchObject({ tab: "subject", subject: { kind: "Group", name: "ops" } });
  });

  it("explains a list it may not read", async () => {
    render(<RbacPage clusterId="c1" />);
    const id = await listWatch("ClusterRoleBinding");
    wb.backend.emit(`watch:${id}`, { type: "error", code: "forbidden", message: "nope" });
    expect(await screen.findByText("You may not list ClusterRoleBindings: cluster-wide permissions are missing.")).toBeInTheDocument();
  });

  it("Can I asks the API server and watches nothing", async () => {
    const asked: unknown[] = [];
    wb.backend.on("rbac_can_i", (args) => {
      asked.push(args);
      return [{ allowed: true, denied: false, reason: "RBAC: allowed by RoleBinding \"x\"", evaluationError: "" }];
    });
    wb.backend.on("rbac_rules_review", (args) => ({
      namespace: (args as { namespace: string }).namespace,
      resourceRules: [{ verbs: ["get"], apiGroups: [""], resources: ["pods"], resourceNames: [] }],
      nonResourceRules: [{ verbs: ["get"], nonResourceUrls: ["/healthz"] }],
      incomplete: true,
      evaluationError: "",
    }));
    useRbacStore.getState().patch("c1", { tab: "canI" });
    render(<RbacPage clusterId="c1" />);
    await screen.findByText(/Answered by the API server/);
    fireEvent.change(screen.getByRole("combobox", { name: "Verb" }), { target: { value: "create" } });
    fireEvent.change(screen.getByRole("combobox", { name: "Resource" }), { target: { value: "pods/exec" } });
    fireEvent.change(screen.getAllByRole("combobox", { name: "Namespace" })[0]!, { target: { value: "prod" } });
    fireEvent.click(screen.getByRole("button", { name: "Ask" }));
    expect(await screen.findByText("Yes, allowed")).toBeInTheDocument();
    expect(asked).toEqual([
      {
        clusterId: "c1",
        queries: [{ verb: "create", group: "", resource: "pods", subresource: "exec", name: "", namespace: "prod", nonResourceUrl: "" }],
      },
    ]);

    fireEvent.click(screen.getByRole("button", { name: "List my permissions" }));
    expect(await screen.findByText(/The list may be incomplete/)).toBeInTheDocument();
    const matrix = screen.getByRole("table", { name: "My permissions in default by verb and resource" });
    expect(within(matrix).getByRole("button", { name: "get pods: allowed" })).toBeInTheDocument();
    expect(within(matrix).getByRole("button", { name: "get /healthz: allowed" })).toBeInTheDocument();
    expect(wb.specs.size).toBe(0);
  });
});

// ---------- Details ----------

function refTo(obj: KubeObject, kind: KindRef): ObjectRef {
  return { kind, namespace: obj.metadata?.namespace ?? null, name: obj.metadata?.name ?? "" };
}

async function openDetails(obj: KubeObject, kind: KindRef): Promise<void> {
  const ref = refTo(obj, kind);
  useAppStore.getState().openDetails(ref);
  render(<DetailsPanel clusterId="c1" objectRef={ref} />);
  const id = await watchOf(wb, kind.kind, (s) => s.fieldSelector === `metadata.name=${ref.name}`);
  emitSnapshot(wb, id, [obj]);
}

const RBAC_KIND = (kind: string): KindRef => ({ group: "rbac.authorization.k8s.io", version: "v1", kind });

describe("details sections", () => {
  it("a ServiceAccount shows what it can do and opens the page on itself", async () => {
    const sa: KubeObject = { apiVersion: "v1", kind: "ServiceAccount", metadata: { name: "web", namespace: "prod", uid: "sa1" } };
    await openDetails(sa, { group: "", version: "v1", kind: "ServiceAccount" });
    await feed();
    const matrix = await screen.findByRole("table", { name: "Permissions of prod/web by verb and resource" });
    expect(within(matrix).getByRole("button", { name: "list pods: allowed" })).toBeInTheDocument();
    // The page joins the section's watches instead of opening its own.
    render(<RbacPage clusterId="c1" />);
    await screen.findByText("3 subjects are named in bindings.");
    expect([...wb.specs.values()].filter((s) => s.kind.kind === "ClusterRole")).toHaveLength(1);
    expect(sharedWatchCount()).toBe(4);
    fireEvent.click(screen.getByRole("button", { name: "Open in Permissions" }));
    expect(useAppStore.getState().clusterViews.c1?.view).toBe(RBAC_PAGE);
    expect(useRbacStore.getState().clusters.c1?.subject).toEqual({ kind: "ServiceAccount", name: "web", namespace: "prod" });
  });

  it("a binding to a missing role warns, and a ClusterRole lists who it is bound to", async () => {
    await openDetails(roleBindings[1]!, RBAC_KIND("RoleBinding"));
    emitSnapshot(wb, await watchOf(wb, "Role", (s) => s.fieldSelector === null && s.namespaces?.[0] === "dev"), roles);
    expect(await screen.findByText(/RoleBinding dev\/dangling refers to Role dev\/gone, which does not exist/)).toBeInTheDocument();
  });

  it("a ClusterRole explains its rules and lists its bindings and subjects", async () => {
    await openDetails(clusterRoles[1]!, RBAC_KIND("ClusterRole"));
    emitSnapshot(wb, await listWatch("ClusterRoleBinding"), clusterRoleBindings);
    emitSnapshot(wb, await listWatch("RoleBinding"), roleBindings);
    expect(await screen.findByText("Every verb, including escalate, bind and impersonate.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open ClusterRoleBinding ops-secrets" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Group ops" }));
    expect(useRbacStore.getState().clusters.c1?.subject).toEqual({ kind: "Group", name: "ops" });
  });
});
