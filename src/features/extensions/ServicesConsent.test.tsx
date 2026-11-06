// The consent block of services (ADR-0158) and the status patches of the permissions (ADR-0155).
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
        }}
      />,
    );
    expect(screen.getByText("May change the status of: Rollout (argoproj.io) (where it may modify them).")).toBeInTheDocument();
  });
});
