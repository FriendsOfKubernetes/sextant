// Kubeconfig management dialogs (#150): a change is previewed before anything is written, the write sends the
// preview's `base`, a source Sextant may not edit shows the warning and offers no write, and no credential value
// from a kubeconfig full of (fake) secrets reaches the screen.
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  mockBackend,
  type ClusterInfo,
  type EditPreview,
  type KubeconfigInput,
  type KubeconfigValidation,
  type MockBackend,
} from "../../../api";
import { resetAppStore } from "../../../app/store";
import { resetClustersStore } from "../clustersStore";
import { closeContextEdit, openContextEdit } from "./apply";
import { ContextEditDialog } from "./ContextEditDialog";
import { SourceWritable } from "./SourceSettings";
import { ValidationDialog } from "./ValidationDialog";
import { axeViolations } from "../../../test/axe";

// Fake secrets: none of them may ever be rendered.
const SECRETS = [
  "eyJhbGciOiJSUzI1NiJ9.fake-bearer-token.sig",
  "LS0tLS1CRUdJTiBSU0EgUFJJVkFURSBLRVktLS0tLQ==",
  "hunter2-fake-password",
  "fake-oidc-refresh-token-123",
];

const KUBECONFIG_TEXT = `apiVersion: v1
kind: Config
clusters:
- name: prod
  cluster:
    server: https://prod.example:6443
users:
- name: admin
  user:
    token: ${SECRETS[0]}
    client-key-data: ${SECRETS[1]}
    password: ${SECRETS[2]}
    auth-provider:
      name: oidc
      config:
        refresh-token: ${SECRETS[3]}
contexts:
- name: prod
  context: { cluster: prod, user: admin }
current-context: prod
`;

const prod: ClusterInfo = {
  id: "prod-id",
  context: "prod",
  clusterName: "prod",
  server: "https://prod.example:6443",
  user: "admin",
  namespace: null,
  sourceId: "src-home",
};

function preview(over: Partial<EditPreview> = {}): EditPreview {
  return {
    sourceId: "src-home",
    path: "/tmp/sextant-test/config",
    target: {
      realPath: "/tmp/sextant-test/config",
      backupPattern: "/tmp/sextant-test/config.bak-YYYYMMDD-HHMMSS",
      backupsKept: 5,
    },
    currentContextElsewhere: [],
    createsFile: false,
    ownFile: false,
    changes: [
      { entry: "context", change: "renamed", name: "prod", newName: "prod-eu", origin: null, fields: [] },
      {
        entry: "user",
        change: "removed",
        name: "admin",
        newName: null,
        origin: null,
        // What the backend sends for a credential field.
        fields: [
          { field: "token", before: "<hidden>", after: null },
          { field: "client-key-data", before: "<hidden>", after: null },
        ],
      },
    ],
    commentsLost: false,
    layoutChanges: false,
    unchanged: false,
    base: "base-hash-1",
    renamed: [{ from: "prod-id", to: "prod-eu-id" }],
    removed: [],
    added: [],
    changed: [],
    ...over,
  } as EditPreview;
}

let backend: MockBackend;
const calls = (cmd: string) => backend.calls.filter((c) => c.cmd === cmd);

function expectNoSecrets() {
  const text = document.body.textContent ?? "";
  const html = document.body.innerHTML;
  for (const secret of SECRETS) {
    expect(text).not.toContain(secret);
    expect(html).not.toContain(secret);
  }
}

beforeEach(() => {
  resetAppStore();
  resetClustersStore();
});
afterEach(() => {
  act(() => closeContextEdit());
  resetClustersStore();
  backend.restore();
});

describe("context edit dialog", () => {
  function setup(handlers: Parameters<typeof mockBackend>[0] = {}) {
    backend = mockBackend({
      clusters_list: () => [prod],
      kubeconfig_sources: () => [],
      kubeconfig_credentials: () => [],
      cluster_disconnect: () => undefined,
      kubeconfig_edit_preview: () => preview(),
      kubeconfig_edit_apply: () => ({
        source: { id: "src-home", path: "/tmp/sextant-test/config", kind: "default", error: null },
        backupPath: "/tmp/sextant-test/config.bak-20261019T100000",
        renamed: [{ from: "prod-id", to: "prod-eu-id" }],
        removed: [],
        added: [],
        changed: [],
      }),
      ...handlers,
    });
  }

  it("shows the preview first and writes only on request, sending the preview's base", async () => {
    setup();
    render(<ContextEditDialog />);
    act(() => openContextEdit("rename", prod));
    fireEvent.change(await screen.findByLabelText("New context name"), { target: { value: "prod-eu" } });
    expect(screen.queryByRole("button", { name: "Write to the file" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Preview" }));

    expect(await screen.findByText("prod → prod-eu")).toBeInTheDocument();
    expect(screen.getByText("File: /tmp/sextant-test/config")).toBeInTheDocument();
    expect(calls("kubeconfig_edit_preview")[0]?.args).toEqual({
      edit: { type: "renameContext", clusterId: "prod-id", newName: "prod-eu" },
    });
    expect(calls("kubeconfig_edit_apply")).toHaveLength(0);

    fireEvent.click(screen.getByRole("button", { name: "Write to the file" }));
    expect(
      await screen.findByText("Saved. The previous file was copied to /tmp/sextant-test/config.bak-20261019T100000"),
    ).toBeInTheDocument();
    expect(calls("kubeconfig_edit_apply")).toHaveLength(1);
    expect(calls("kubeconfig_edit_apply")[0]?.args).toEqual({
      edit: { type: "renameContext", clusterId: "prod-id", newName: "prod-eu" },
      base: "base-hash-1",
    });
  });

  it("names the file a link points to, the backups, an unset current context and files it cannot follow", async () => {
    setup({
      kubeconfig_edit_preview: () =>
        preview({
          path: "/home/me/.kube/config",
          target: { realPath: "/home/me/dotfiles/kube.yaml", backupPattern: "/home/me/dotfiles/kube.yaml.bak-YYYYMMDD-HHMMSS", backupsKept: 5 },
          changes: [
            { entry: "context", change: "removed", name: "prod", newName: null, origin: null, fields: [] },
            {
              entry: "currentContext",
              change: "changed",
              name: "",
              newName: null,
              origin: null,
              fields: [{ field: "current-context", before: "prod", after: null }],
            },
          ],
          currentContextElsewhere: ["/home/me/other.yaml"],
          renamed: [],
          removed: ["prod-id"],
        }),
    });
    render(<ContextEditDialog />);
    act(() => openContextEdit("delete", prod));
    fireEvent.click(await screen.findByRole("button", { name: "Preview" }));
    expect(
      await screen.findByText("The path is a link. The change is written to the file it points to: /home/me/dotfiles/kube.yaml"),
    ).toBeInTheDocument();
    expect(screen.getByText(/copied to \/home\/me\/dotfiles\/kube\.yaml\.bak-YYYYMMDD-HHMMSS.*copies kept: 5/)).toBeInTheDocument();
    expect(screen.getByText(/The current context is left unset/)).toBeInTheDocument();
    expect(screen.getByText("/home/me/other.yaml")).toBeInTheDocument();
  });

  it("a change of the form after the preview drops it: nothing stale can be written", async () => {
    setup();
    render(<ContextEditDialog />);
    act(() => openContextEdit("rename", prod));
    const input = await screen.findByLabelText("New context name");
    fireEvent.change(input, { target: { value: "prod-eu" } });
    fireEvent.click(screen.getByRole("button", { name: "Preview" }));
    await screen.findByRole("button", { name: "Write to the file" });
    fireEvent.change(input, { target: { value: "prod-us" } });
    expect(screen.queryByRole("button", { name: "Write to the file" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Preview" })).toBeInTheDocument();
  });

  it("a source Sextant may not edit shows the warning and offers no write", async () => {
    setup({
      kubeconfig_edit_preview: () => {
        throw { code: "denied", message: "not writable" };
      },
    });
    render(<ContextEditDialog />);
    act(() => openContextEdit("delete", prod));
    fireEvent.click(await screen.findByRole("button", { name: "Preview" }));

    expect(
      await screen.findByText(
        "Sextant may not edit this file. Allow it for this kubeconfig in Settings → Clusters first.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open settings" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Write to the file" })).not.toBeInTheDocument();
    expect(calls("kubeconfig_edit_apply")).toHaveLength(0);
  });

  it("a file changed after the preview is previewed again, not written", async () => {
    let n = 0;
    setup({
      kubeconfig_edit_preview: () => preview({ base: `base-hash-${++n}` }),
      kubeconfig_edit_apply: () => {
        throw { code: "conflict", message: "changed" };
      },
    });
    render(<ContextEditDialog />);
    act(() => openContextEdit("delete", prod));
    fireEvent.click(await screen.findByRole("button", { name: "Preview" }));
    fireEvent.click(await screen.findByRole("button", { name: "Write to the file" }));
    expect(await screen.findByText("The file changed after the preview. Look at the change again.")).toBeInTheDocument();
    await waitFor(() => expect(calls("kubeconfig_edit_preview")).toHaveLength(2));
    fireEvent.click(await screen.findByRole("button", { name: "Write to the file" }));
    await waitFor(() => expect(calls("kubeconfig_edit_apply")).toHaveLength(2));
    expect(calls("kubeconfig_edit_apply")[1]?.args.base).toBe("base-hash-2");
  });

  it("renders credential fields only as the backend's hidden marker", async () => {
    setup();
    render(<ContextEditDialog />);
    act(() => openContextEdit("delete", prod));
    fireEvent.click(await screen.findByRole("button", { name: "Preview" }));
    expect(await screen.findByText("token: <hidden> → none")).toBeInTheDocument();
    expectNoSecrets();
  });
});

describe("kubeconfig check on add", () => {
  const input: KubeconfigInput = { type: "text", text: KUBECONFIG_TEXT };
  const validation: KubeconfigValidation = {
    problems: [],
    contexts: [
      {
        context: "prod",
        server: "https://prod.example:6443",
        problems: [
          { code: "tokenExpired", subject: "2026-01-01T00:00:00Z", line: null, column: null, warning: false },
          { code: "execNotFound", subject: "kubelogin", line: null, column: null, warning: false },
          { code: "insecureTls", subject: null, line: null, column: null, warning: true },
        ],
      },
    ],
  };

  it("explains the problems in plain words, connects only on request and never shows a credential", async () => {
    let added = 0;
    backend = mockBackend({
      kubeconfig_check_connection: () => {
        throw { code: "unreachable", message: "connection refused" };
      },
    });
    render(<ValidationDialog input={input} validation={validation} onAdd={() => added++} onClose={() => undefined} />);

    expect(screen.getByText("The login program kubelogin is not installed or not in PATH.")).toBeInTheDocument();
    expect(screen.getByText(/^The token expired on /)).toBeInTheDocument();
    expect(screen.getByText("The server's certificate is not verified (insecure-skip-tls-verify).")).toBeInTheDocument();
    expect(calls("kubeconfig_check_connection")).toHaveLength(0);
    expectNoSecrets();

    fireEvent.click(screen.getByRole("button", { name: "Check connection" }));
    await waitFor(() => expect(calls("kubeconfig_check_connection")).toHaveLength(1));
    expect(calls("kubeconfig_check_connection")[0]?.args).toEqual({ input, context: "prod" });
    await waitFor(() => expect(screen.getByRole("button", { name: "Check connection" })).toBeEnabled());
    expectNoSecrets();

    fireEvent.click(screen.getByRole("button", { name: "Add anyway" }));
    expect(added).toBe(1);
  });

  it("a file that is no kubeconfig cannot be added", () => {
    backend = mockBackend({});
    render(
      <ValidationDialog
        input={{ type: "file", path: "/tmp/sextant-test/notes.txt" }}
        validation={{
          problems: [{ code: "notYaml", subject: null, line: 3, column: 7, warning: false }],
          contexts: [],
        }}
        onAdd={() => undefined}
        onClose={() => undefined}
      />,
    );
    expect(screen.getByText("The file is not valid YAML (line 3, column 7).")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Add anyway" })).not.toBeInTheDocument();
  });
});

describe("a login program that is not on this computer (#253)", () => {
  const command = "/home/user/yandex-cloud/bin/yc";
  const missing: KubeconfigValidation = {
    problems: [],
    contexts: [
      {
        context: "yc",
        server: "https://yc.example:443",
        problems: [{ code: "execFolderMissing", subject: command, line: null, column: null, warning: false }],
      },
      { context: "plain", server: "https://plain.example:443", problems: [] },
    ],
  };

  it("names the command as written, says its folder is missing and how to fix it", async () => {
    backend = mockBackend({});
    render(<ValidationDialog input={{ type: "text", text: "" }} validation={missing} onAdd={() => undefined} onClose={() => undefined} />);
    expect(
      screen.getByText(`The folder of the login program ${command} does not exist on this computer.`),
    ).toBeInTheDocument();
    const hints = screen.getAllByTestId("exec-plugin-hint");
    expect(hints).toHaveLength(1);
    expect(hints[0]).toHaveTextContent("generated on another computer or in WSL");
    expect(hints[0]).toHaveTextContent("e.g. yc, aws, gcloud, az, kubelogin");
    expect(hints[0]).toHaveTextContent("On Windows, sign out and sign in again first.");
    expect(await axeViolations(screen.getByRole("dialog"))).toEqual([]);
  });

  it("explains a failed connection check whose plugin was not found, and no other failure", async () => {
    backend = mockBackend({
      kubeconfig_check_connection: (args) => {
        if (args.context === "plain") throw { code: "authPlugin", message: "the auth plugin 'yc' failed with exit code 1" };
        throw { code: "authPlugin", message: `the auth plugin was not found: '${command}' — the folder does not exist` };
      },
    });
    const clean: KubeconfigValidation = {
      problems: [],
      contexts: [
        { context: "yc", server: null, problems: [] },
        { context: "plain", server: null, problems: [] },
      ],
    };
    render(<ValidationDialog input={{ type: "text", text: "" }} validation={clean} onAdd={() => undefined} onClose={() => undefined} />);
    const [first, second] = screen.getAllByRole("button", { name: "Check connection" });
    fireEvent.click(second!);
    await waitFor(() => expect(calls("kubeconfig_check_connection")).toHaveLength(1));
    await waitFor(() => expect(screen.getAllByRole("button", { name: "Check connection" })[1]).toBeEnabled());
    expect(screen.queryByTestId("exec-plugin-hint")).not.toBeInTheDocument();
    fireEvent.click(first!);
    expect(await screen.findByTestId("exec-plugin-hint")).toBeInTheDocument();
  });
});

describe("allowing Sextant to edit a kubeconfig", () => {
  it("names the file a link points to and where the backups go before asking", async () => {
    backend = mockBackend({
      kubeconfig_edit_target: () => ({
        realPath: "/home/me/dotfiles/kube.yaml",
        backupPattern: "/home/me/dotfiles/kube.yaml.bak-YYYYMMDD-HHMMSS",
        backupsKept: 5,
      }),
    });
    render(<SourceWritable source={{ id: "src-home", path: "/home/me/.kube/config", kind: "default", error: null }} />);
    const box = await screen.findByLabelText("Allow Sextant to edit /home/me/.kube/config");
    await waitFor(() => expect(box).toBeEnabled());
    fireEvent.click(box);
    expect(await screen.findByText("The change is written to: /home/me/dotfiles/kube.yaml")).toBeInTheDocument();
    expect(
      screen.getByText("A copy is made before each write: /home/me/dotfiles/kube.yaml.bak-YYYYMMDD-HHMMSS (copies kept: 5)"),
    ).toBeInTheDocument();
    expect(calls("kubeconfig_edit_target")[0]?.args).toEqual({ sourceId: "src-home" });
  });
});
