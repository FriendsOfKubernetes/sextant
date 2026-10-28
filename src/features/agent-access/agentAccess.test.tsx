import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AccessPreset, AccessRule, ClusterAccess, ClusterInfo, ResourceKind } from "../../api";
import { resetClusterKinds } from "../../resources";
import { useClustersStore } from "../clusters/clustersStore";
import { getClusterSettingsSections } from "../clusters/settingsRegistry";
import { copy, emitSnapshot, watchBackend, watchOf, type WatchBackend } from "../details/testing";
import "./index";

const cluster: ClusterInfo = {
  id: "c1",
  context: "kind-sextant-test",
  clusterName: "kind-sextant-test",
  server: "https://127.0.0.1:6443",
  user: "admin",
  namespace: null,
  sourceId: "default",
};

/** What the backend's `access_preset_rules` answers (spec "Decisions": the sets). */
const PRESET_RULES: Record<AccessPreset, AccessRule[]> = {
  off: [],
  custom: [],
  readOnly: [{ namespaces: { type: "all" }, kinds: { type: "all" }, actions: ["read", "logs"], confirm: false }],
  readWrite: [
    {
      namespaces: { type: "all" },
      kinds: { type: "all" },
      actions: ["read", "modify", "logs", "exec", "portForward"],
      confirm: true,
    },
  ],
  full: [
    {
      namespaces: { type: "all" },
      kinds: { type: "all" },
      actions: ["read", "modify", "delete", "logs", "exec", "portForward"],
      confirm: true,
    },
  ],
};

function kind(group: string, name: string, namespaced = true): ResourceKind {
  return { kindRef: { group, version: "v1", kind: name }, plural: `${name.toLowerCase()}s`, namespaced, verbs: [], printerColumns: [] };
}

const KINDS = [kind("", "Pod"), kind("apps", "Deployment"), kind("", "Node", false), kind("example.com", "Widget")];

let wb: WatchBackend;

/** An `agentAccess` the core could not read: it arrives beside a closed access and is sent back until the user decides. */
const KEPT = { preset: "custom", rules: [{ actions: ["read"], expires: "2027-01-01" }] };

function setup(saved?: ClusterAccess, kinds: ResourceKind[] | Error = KINDS, kept?: unknown) {
  wb = watchBackend();
  wb.backend.on("access_preset_rules", (args) => copy(PRESET_RULES[args.preset as AccessPreset]));
  wb.backend.on("cluster_kinds", () => {
    if (kinds instanceof Error) throw { code: "unreachable", message: "no discovery" };
    return kinds;
  });
  if (saved) {
    wb.backend.settings.clusters["c1"] = {
      displayName: null,
      color: null,
      namespaces: null,
      lastView: null,
      prometheus: { mode: "auto" },
      usageSource: "auto",
      icon: null,
      agentAccess: saved,
      ...(kept === undefined ? {} : { agentAccessUnrecognised: kept as never }),
    };
  }
}

/** Shows the section and waits until the saved settings are in. */
async function section() {
  const def = getClusterSettingsSections().find((s) => s.id === "agentAccess");
  const Section = def!.Component;
  render(<Section clusterId="c1" cluster={cluster} />);
  const preset = wb.backend.settings.clusters["c1"]?.agentAccess.preset ?? "off";
  const name = { off: "Off", readOnly: "Read-only", readWrite: "Read + write (no delete)", full: "Full", custom: "Custom" }[preset];
  await waitFor(() => expect(screen.getByRole("radio", { name })).toBeChecked());
}

/** The saved access, as the core will read it from `settings.json`. */
function saved(): unknown {
  return JSON.parse(JSON.stringify(wb.backend.settings.clusters["c1"]?.agentAccess));
}

function connect() {
  useClustersStore.setState({ states: { c1: { state: "connected" } } });
}

const CUSTOM_ALL: ClusterAccess = { preset: "custom", rules: copy(PRESET_RULES.readOnly) };

beforeEach(() => {
  useClustersStore.setState({ states: {} });
  resetClusterKinds();
});

afterEach(() => {
  wb?.backend.restore();
  resetClusterKinds();
});

describe("registration", () => {
  it("is a cluster settings section titled \"AI agent access\"", () => {
    const def = getClusterSettingsSections().find((s) => s.id === "agentAccess");
    expect(def?.order).toBe(30);
    expect(def?.titleKey).toBe("access:title");
  });
});

describe("effective permissions", () => {
  const box = () => screen.queryByRole("checkbox", { name: "Let agents see my effective permissions" });

  it("is not offered while access is Off", async () => {
    setup();
    await section();
    expect(box()).toBeNull();
  });

  it("is off by default and saved as its own switch", async () => {
    setup({ preset: "readOnly", rules: [] });
    await section();
    expect(box()).not.toBeChecked();
    fireEvent.click(box()!);
    await waitFor(() => expect(wb.backend.settings.clusters["c1"]?.agentAccessReviews).toBe(true));
    // The access itself is untouched.
    expect(saved()).toEqual({ preset: "readOnly", rules: [] });
    await waitFor(() => expect(box()).toBeChecked());
    fireEvent.click(box()!);
    await waitFor(() => expect(wb.backend.settings.clusters["c1"]).not.toHaveProperty("agentAccessReviews"));
  });
});

describe("sets", () => {
  it("starts with Off and says what that means", async () => {
    setup();
    await section();
    expect(screen.getByRole("radio", { name: "Off" })).toBeChecked();
    expect(screen.getByText(/The agent has no access to this cluster/)).toBeInTheDocument();
    expect(screen.queryByText("Rules")).toBeNull();
  });

  it("choosing a set saves it with its description; the Custom rules are kept", async () => {
    setup({ preset: "off", rules: copy(PRESET_RULES.full) });
    await section();
    fireEvent.click(screen.getByRole("radio", { name: "Read-only" }));
    await waitFor(() => expect(saved()).toEqual({ preset: "readOnly", rules: PRESET_RULES.full }));
    expect(screen.getByText(/read all resources in all namespaces and fetch pod logs/)).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Read-only" })).toBeChecked();

    fireEvent.click(screen.getByRole("radio", { name: "Read + write (no delete)" }));
    await waitFor(() => expect((saved() as ClusterAccess).preset).toBe("readWrite"));
    expect(screen.getByText(/It cannot delete/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("radio", { name: "Off" }));
    await waitFor(() => expect(saved()).toEqual({ preset: "off", rules: PRESET_RULES.full }));
  });

  it("Custom starts from the rules of the set that was chosen, taken from the backend", async () => {
    setup({ preset: "readWrite", rules: [] });
    await section();
    fireEvent.click(screen.getByRole("radio", { name: "Custom" }));
    await waitFor(() => expect(saved()).toEqual({ preset: "custom", rules: PRESET_RULES.readWrite }));
    expect(wb.backend.calls.filter((c) => c.cmd === "access_preset_rules").map((c) => c.args)).toEqual([{ preset: "readWrite" }]);
    // The rule is shown for editing.
    const rule = await screen.findByRole("group", { name: "Rule 1" });
    expect(within(rule).getByRole("checkbox", { name: "Exec / shell" })).toBeChecked();
    expect(within(rule).getByRole("checkbox", { name: "Delete" })).not.toBeChecked();
    expect(within(rule).getByRole("checkbox", { name: "Ask before running" })).toBeChecked();
  });

  it("Custom from Off starts with no rules and says that nothing is allowed", async () => {
    setup();
    await section();
    fireEvent.click(screen.getByRole("radio", { name: "Custom" }));
    await waitFor(() => expect(saved()).toEqual({ preset: "custom", rules: [] }));
    expect(await screen.findByText(/no rules, so the agent has no access/)).toBeInTheDocument();
  });
});

describe("custom rules kept apart from the sets", () => {
  const MINE: AccessRule[] = [
    { namespaces: { type: "only", namespaces: ["prod"] }, kinds: { type: "all" }, actions: ["read", "delete"], confirm: true },
  ];

  it("returning to Custom restores the user's rules instead of copying the previous set", async () => {
    setup({ preset: "off", rules: copy(MINE) });
    await section();
    fireEvent.click(screen.getByRole("radio", { name: "Custom" }));
    await waitFor(() => expect(saved()).toEqual({ preset: "custom", rules: MINE }));
    expect(wb.backend.calls.filter((c) => c.cmd === "access_preset_rules")).toEqual([]);
    expect(await screen.findByRole("group", { name: "Rule 1" })).toBeInTheDocument();
  });

  it("Custom -> Read-only -> Custom keeps the same rules", async () => {
    setup({ preset: "custom", rules: copy(MINE) });
    await section();
    fireEvent.click(screen.getByRole("radio", { name: "Read-only" }));
    await waitFor(() => expect(saved()).toEqual({ preset: "readOnly", rules: MINE }));
    fireEvent.click(screen.getByRole("radio", { name: "Custom" }));
    await waitFor(() => expect(saved()).toEqual({ preset: "custom", rules: MINE }));
  });

  it("restored rules are cleaned like any rule the editor writes (a stray field is dropped)", async () => {
    setup({ preset: "off", rules: [{ ...copy(MINE[0]!), stray: 1 } as AccessRule] });
    await section();
    fireEvent.click(screen.getByRole("radio", { name: "Custom" }));
    await waitFor(() => expect(saved()).toEqual({ preset: "custom", rules: MINE }));
  });
});

describe("rules this version cannot read", () => {
  it("shows a notice, acts as Off, and offers Reset to Off", async () => {
    setup({ preset: "off", rules: [] }, KINDS, KEPT);
    await section();
    expect(screen.getByRole("radio", { name: "Off" })).toBeChecked();
    expect(screen.getByText(/written by a newer Sextant or edited by hand; they are kept but not applied/)).toBeInTheDocument();
    expect(screen.queryByText("Rules")).toBeNull();
    // Nothing was written just by looking.
    expect(wb.backend.settings.clusters["c1"]?.agentAccessUnrecognised).toEqual(KEPT);
  });

  it("Reset to Off drops the kept value and saves Off", async () => {
    setup({ preset: "off", rules: [] }, KINDS, KEPT);
    await section();
    fireEvent.click(screen.getByRole("button", { name: "Reset to Off" }));
    await waitFor(() => expect(wb.backend.settings.clusters["c1"]?.agentAccessUnrecognised).toBeUndefined());
    expect(saved()).toEqual({ preset: "off", rules: [] });
    await waitFor(() => expect(screen.queryByText(/kept but not applied/)).toBeNull());
  });

  it("choosing a set replaces the kept value", async () => {
    setup({ preset: "off", rules: [] }, KINDS, KEPT);
    await section();
    fireEvent.click(screen.getByRole("radio", { name: "Read-only" }));
    await waitFor(() => expect(saved()).toEqual({ preset: "readOnly", rules: [] }));
    expect(wb.backend.settings.clusters["c1"]?.agentAccessUnrecognised).toBeUndefined();
    expect(screen.queryByText(/kept but not applied/)).toBeNull();
  });
});

describe("custom rules", () => {
  it("adds a rule that only reads and asks before running; removes it", async () => {
    setup({ preset: "custom", rules: [] });
    await section();
    fireEvent.click(screen.getByRole("button", { name: "Add rule" }));
    await waitFor(() =>
      expect(saved()).toEqual({
        preset: "custom",
        rules: [{ namespaces: { type: "all" }, kinds: { type: "all" }, actions: ["read"], confirm: true }],
      }),
    );
    fireEvent.click(await screen.findByRole("button", { name: "Remove rule 1" }));
    await waitFor(() => expect(saved()).toEqual({ preset: "custom", rules: [] }));
  });

  it("actions and Ask before running are saved per rule", async () => {
    setup({ preset: "custom", rules: [...copy(PRESET_RULES.readOnly), ...copy(PRESET_RULES.readOnly)] });
    await section();
    const second = await screen.findByRole("group", { name: "Rule 2" });
    fireEvent.click(within(second).getByRole("checkbox", { name: "Exec / shell" }));
    fireEvent.click(within(second).getByRole("checkbox", { name: "Modify" }));
    fireEvent.click(within(second).getByRole("checkbox", { name: "Ask before running" }));
    fireEvent.click(within(second).getByRole("checkbox", { name: "Logs" }));
    await waitFor(() =>
      expect((saved() as ClusterAccess).rules[1]).toEqual({
        namespaces: { type: "all" },
        kinds: { type: "all" },
        // Always in the same order, whatever order they were ticked in.
        actions: ["read", "modify", "exec"],
        confirm: true,
      }),
    );
    expect((saved() as ClusterAccess).rules[0]).toEqual(PRESET_RULES.readOnly[0]);
  });

  it("quick edits do not overwrite one another", async () => {
    setup(CUSTOM_ALL);
    await section();
    const rule = await screen.findByRole("group", { name: "Rule 1" });
    fireEvent.click(within(rule).getByRole("checkbox", { name: "Modify" }));
    fireEvent.click(within(rule).getByRole("checkbox", { name: "Delete" }));
    fireEvent.click(within(rule).getByRole("checkbox", { name: "Port forward" }));
    await waitFor(() =>
      expect((saved() as ClusterAccess).rules[0]?.actions).toEqual(["read", "modify", "delete", "logs", "portForward"]),
    );
  });

  it("Only → All → Only writes exactly the fields of each variant", async () => {
    setup(CUSTOM_ALL);
    await section();
    const rule = await screen.findByRole("group", { name: "Rule 1" });
    const namespaces = within(rule).getByRole("group", { name: "Namespaces" });
    const kinds = within(rule).getByRole("group", { name: "Kinds" });
    const rulesOf = () => (saved() as ClusterAccess).rules[0];

    fireEvent.click(within(namespaces).getByRole("radio", { name: "Selected namespaces" }));
    await waitFor(() => expect(rulesOf()?.namespaces).toStrictEqual({ type: "only", namespaces: [] }));
    fireEvent.change(within(namespaces).getByRole("textbox", { name: "Add a namespace by name" }), { target: { value: "team-a" } });
    fireEvent.click(within(namespaces).getByRole("button", { name: "Add namespace" }));
    await waitFor(() => expect(rulesOf()?.namespaces).toStrictEqual({ type: "only", namespaces: ["team-a"] }));

    fireEvent.click(within(namespaces).getByRole("radio", { name: "All namespaces" }));
    await waitFor(() => expect(rulesOf()?.namespaces).toStrictEqual({ type: "all" }));
    expect(JSON.stringify(rulesOf()?.namespaces)).toBe('{"type":"all"}');

    fireEvent.click(within(namespaces).getByRole("radio", { name: "Selected namespaces" }));
    await waitFor(() => expect(rulesOf()?.namespaces).toStrictEqual({ type: "only", namespaces: [] }));
    expect(JSON.stringify(rulesOf()?.namespaces)).toBe('{"type":"only","namespaces":[]}');

    // Kinds the same way.
    fireEvent.click(within(kinds).getByRole("radio", { name: "Selected kinds" }));
    fireEvent.change(await within(kinds).findByRole("textbox", { name: "Add a kind by name" }), { target: { value: "apps/Deployment" } });
    fireEvent.click(within(kinds).getByRole("button", { name: "Add kind" }));
    await waitFor(() =>
      expect(rulesOf()?.kinds).toStrictEqual({ type: "only", kinds: [{ group: "apps", kind: "Deployment" }] }),
    );
    fireEvent.click(within(kinds).getByRole("radio", { name: "All kinds" }));
    await waitFor(() => expect(rulesOf()?.kinds).toStrictEqual({ type: "all" }));
    expect(JSON.stringify(rulesOf())).toBe(
      '{"namespaces":{"type":"only","namespaces":[]},"kinds":{"type":"all"},"actions":["read","logs"],"confirm":false}',
    );
    expect(Object.keys(saved() as object).sort()).toEqual(["preset", "rules"]);
  });

  it("a rule that came with foreign fields is written back without them", async () => {
    const dirty = {
      preset: "custom",
      rules: [
        {
          namespaces: { type: "all", namespaces: ["old"] },
          kinds: { type: "only", kinds: [{ group: "", kind: "Pod", version: "v1" }] },
          actions: ["read"],
          confirm: true,
          label: "x",
        },
      ],
    } as unknown as ClusterAccess;
    setup(dirty);
    await section();
    const rule = await screen.findByRole("group", { name: "Rule 1" });
    fireEvent.click(within(rule).getByRole("checkbox", { name: "Logs" }));
    await waitFor(() =>
      expect(JSON.stringify((saved() as ClusterAccess).rules[0])).toBe(
        '{"namespaces":{"type":"all"},"kinds":{"type":"only","kinds":[{"group":"","kind":"Pod"}]},"actions":["read","logs"],"confirm":true}',
      ),
    );
  });

  it("Secret values carries a warning for as long as it is ticked", async () => {
    setup(CUSTOM_ALL);
    await section();
    const rule = await screen.findByRole("group", { name: "Rule 1" });
    expect(within(rule).queryByText(/in clear text/)).toBeNull();
    fireEvent.click(within(rule).getByRole("checkbox", { name: "Secret values" }));
    expect(await within(rule).findByText(/read Secret data and the values of Helm releases in clear text/)).toBeInTheDocument();
    await waitFor(() => expect((saved() as ClusterAccess).rules[0]?.actions).toEqual(["read", "logs", "secretValues"]));
    fireEvent.click(within(rule).getByRole("checkbox", { name: "Secret values" }));
    await waitFor(() => expect(within(rule).queryByText(/in clear text/)).toBeNull());
  });
});

describe("namespaces and kinds from the cluster", () => {
  it("without a connection says so; All and names typed by hand still work", async () => {
    setup({ preset: "custom", rules: copy(PRESET_RULES.readOnly) });
    await section();
    const rule = await screen.findByRole("group", { name: "Rule 1" });
    fireEvent.click(within(rule).getByRole("radio", { name: "Selected namespaces" }));
    fireEvent.click(within(rule).getByRole("radio", { name: "Selected kinds" }));
    await waitFor(() => expect(within(rule).getAllByText(/Connect to this cluster to choose from its list/)).toHaveLength(2));
    expect(wb.backend.calls.some((c) => c.cmd === "cluster_kinds")).toBe(false);
    // Helm releases can still be ticked: they are not discovered.
    fireEvent.click(within(rule).getByRole("checkbox", { name: /Helm releases/ }));
    fireEvent.change(within(rule).getByRole("textbox", { name: "Add a namespace by name" }), { target: { value: "Not Valid" } });
    fireEvent.click(within(rule).getByRole("button", { name: "Add namespace" }));
    expect(within(rule).getByRole("alert")).toHaveTextContent("Not a valid namespace name.");
    fireEvent.change(within(rule).getByRole("textbox", { name: "Add a namespace by name" }), { target: { value: "team-b" } });
    fireEvent.keyDown(within(rule).getByRole("textbox", { name: "Add a namespace by name" }), { key: "Enter" });
    await waitFor(() =>
      expect((saved() as ClusterAccess).rules[0]).toEqual({
        namespaces: { type: "only", namespaces: ["team-b"] },
        kinds: { type: "only", kinds: [{ group: "helm.sh", kind: "Release" }] },
        actions: ["read", "logs"],
        confirm: false,
      }),
    );
  });

  it("lists the namespaces of the cluster and the kinds of its discovery (CRDs and Helm releases too)", async () => {
    setup(CUSTOM_ALL);
    connect();
    await section();
    const rule = await screen.findByRole("group", { name: "Rule 1" });
    fireEvent.click(within(rule).getByRole("radio", { name: "Selected namespaces" }));
    fireEvent.click(within(rule).getByRole("radio", { name: "Selected kinds" }));

    const watchId = await watchOf(wb, "Namespace");
    emitSnapshot(wb, watchId, [
      { apiVersion: "v1", kind: "Namespace", metadata: { name: "team-b", uid: "2" } },
      { apiVersion: "v1", kind: "Namespace", metadata: { name: "team-a", uid: "1" } },
    ]);
    const namespaces = within(rule).getByRole("group", { name: "Namespaces" });
    const kinds = within(rule).getByRole("group", { name: "Kinds" });
    await within(namespaces).findByRole("checkbox", { name: "team-a" });
    expect(within(namespaces).getAllByRole("checkbox").map((c) => c.closest("label")?.textContent)).toEqual(["team-a", "team-b"]);
    fireEvent.click(within(namespaces).getByRole("checkbox", { name: "team-b" }));
    await waitFor(() =>
      expect((saved() as ClusterAccess).rules[0]?.namespaces).toStrictEqual({ type: "only", namespaces: ["team-b"] }),
    );

    await within(kinds).findByRole("checkbox", { name: /Widget/ });
    for (const name of [/Helm releases/, /Widget/, /Deployment/, /Pod/, /Node/]) {
      expect(within(kinds).getByRole("checkbox", { name })).toBeInTheDocument();
    }
    // Filter, then tick a custom resource and a core kind.
    fireEvent.change(within(kinds).getByRole("textbox", { name: "Filter kinds" }), { target: { value: "example.com" } });
    expect(within(kinds).queryByRole("checkbox", { name: /Deployment/ })).toBeNull();
    fireEvent.click(within(kinds).getByRole("checkbox", { name: /Widget/ }));
    fireEvent.change(within(kinds).getByRole("textbox", { name: "Filter kinds" }), { target: { value: "" } });
    fireEvent.click(within(kinds).getByRole("checkbox", { name: /Pod/ }));
    await waitFor(() =>
      expect((saved() as ClusterAccess).rules[0]?.kinds).toStrictEqual({
        type: "only",
        kinds: [
          { group: "example.com", kind: "Widget" },
          { group: "", kind: "Pod" },
        ],
      }),
    );
    // Ticked kinds are listed first, and unticking removes them.
    fireEvent.click(within(kinds).getByRole("checkbox", { name: /Widget/ }));
    await waitFor(() =>
      expect((saved() as ClusterAccess).rules[0]?.kinds).toStrictEqual({ type: "only", kinds: [{ group: "", kind: "Pod" }] }),
    );
  });

  it("a kind the cluster does not serve stays listed so it can be unticked", async () => {
    const rules: AccessRule[] = [
      { namespaces: { type: "all" }, kinds: { type: "only", kinds: [{ group: "gone.example", kind: "Thing" }] }, actions: ["read"], confirm: true },
    ];
    setup({ preset: "custom", rules });
    connect();
    await section();
    const rule = await screen.findByRole("group", { name: "Rule 1" });
    await within(rule).findByRole("checkbox", { name: /Widget/ });
    fireEvent.click(within(rule).getByRole("checkbox", { name: /Thing/ }));
    await waitFor(() => expect((saved() as ClusterAccess).rules[0]?.kinds).toStrictEqual({ type: "only", kinds: [] }));
    expect(within(rule).getByText(/No kind is selected, so this rule covers nothing/)).toBeInTheDocument();
  });

  it("when the cluster's list cannot be read, says so and keeps typing available", async () => {
    setup({ preset: "custom", rules: copy(PRESET_RULES.readOnly) }, new Error("no"));
    connect();
    await section();
    const rule = await screen.findByRole("group", { name: "Rule 1" });
    fireEvent.click(within(rule).getByRole("radio", { name: "Selected kinds" }));
    expect(await within(rule).findByText(/The cluster's list is unavailable/)).toBeInTheDocument();
    expect(within(rule).getByRole("textbox", { name: "Add a kind by name" })).toBeInTheDocument();
  });
});
