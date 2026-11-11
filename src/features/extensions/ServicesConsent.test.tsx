// The consent block of services (ADR-0158), the status patches of the permissions (ADR-0155) and their masked secrets (ADR-0169).
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import "../../i18n";
import { axeViolations } from "../../test/axe";
import { PermissionsView } from "./PermissionsView";
import { ServicesConsent } from "./ServicesConsent";

describe("services and status patches on the consent screen", () => {
  it("show each Service by name, port and scheme, and what reaching it takes", async () => {
    const { container } = render(
      <ServicesConsent services={[{ id: "api", title: "Argo CD API", name: "argocd-server", port: "https", scheme: "https" }]} />,
    );
    expect(screen.getByText("Argo CD API")).toBeInTheDocument();
    expect(screen.getByText("https://argocd-server:https")).toBeInTheDocument();
    expect(screen.getByText(/^Only in namespaces where it may read and forward to Services\./)).toBeInTheDocument();
    expect(await axeViolations(container)).toEqual([]);
  });

  it("name the kinds whose status the extension may change", () => {
    render(
      <PermissionsView
        permissions={{
          clusters: { type: "all" },
          rules: [],
          statusPatches: [{ group: "argoproj.io", kind: "Rollout" }],
          readGroups: ["*.cluster.x-k8s.io"],
        }}
      />,
    );
    expect(screen.getByText("May change the status of: Rollout (argoproj.io) (where it may modify them).")).toBeInTheDocument();
    expect(screen.getByText("May read every kind of the API groups under cluster.x-k8s.io, in every namespace.")).toBeInTheDocument();
  });

  it("name the kinds whose secret fields the extension sees masked (ADR-0169)", async () => {
    const { container } = render(
      <PermissionsView
        permissions={{
          clusters: { type: "all" },
          rules: [],
          maskedSecrets: [
            { group: "", kind: "Node" },
            { group: "helm.cattle.io", kind: "HelmChart" },
          ],
        }}
      />,
    );
    expect(
      screen.getByText(
        "Sees masked copies of the fields of Node, HelmChart (helm.cattle.io) that may hold secrets: Sextant hides every secret value in them before the extension gets them.",
      ),
    ).toBeInTheDocument();
    expect(await axeViolations(container)).toEqual([]);
  });
});
