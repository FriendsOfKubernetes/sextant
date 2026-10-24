// The pin toggle next to the object's name in the details panel (#274); "Pin to favourites" left the action bar.
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mockBackend, type KubeObject, type MockBackend } from "../../api";
import { getSettingsSnapshot, resetSettingsCache } from "../../api/settings";
import { resetAppStore } from "../../app/store";
import { DetailsPanel } from "../../layout/details/DetailsPanel";
import { axeViolations } from "../../test/axe";
import { getAction } from "../actions/registry";
import "./index";

const POD = { group: "", version: "v1", kind: "Pod" };
const pod: KubeObject = { apiVersion: "v1", kind: "Pod", metadata: { name: "web", namespace: "demo", uid: "u1" } };

let backend: MockBackend;
beforeEach(() => {
  resetAppStore();
  resetSettingsCache();
  backend = mockBackend({ resource_get: () => pod }, {});
});
afterEach(() => backend.restore());

describe("the pin toggle in the details header", () => {
  it("pins and unpins the object, its state in aria-pressed and the icon", async () => {
    render(<DetailsPanel clusterId="c1" objectRef={{ kind: POD, namespace: "demo", name: "web" }} />);
    const header = screen.getByRole("heading", { name: "web" }).closest("header")!;
    const toggle = within(header).getByRole("button", { name: "Pin to favourites" });
    await waitFor(() => expect(toggle).toBeEnabled());
    expect(toggle).toHaveAttribute("aria-pressed", "false");
    expect(toggle).toHaveTextContent(/^$/);
    // Next to the name, after the copy button's place.
    expect(toggle.closest(".details__name-line")).not.toBeNull();

    fireEvent.click(toggle);
    await waitFor(() => expect(toggle).toHaveAttribute("aria-pressed", "true"));
    expect(toggle).toHaveAttribute("title", "Unpin from favourites");
    expect(toggle).toHaveClass("views-pin-toggle--on");
    expect(getSettingsSnapshot()?.pins.map((p) => p.target)).toEqual([
      { type: "object", group: "", version: "v1", kind: "Pod", namespace: "demo", name: "web" },
    ]);
    expect(await axeViolations()).toEqual([]);

    fireEvent.click(toggle);
    await waitFor(() => expect(toggle).toHaveAttribute("aria-pressed", "false"));
    expect(getSettingsSnapshot()?.pins).toEqual([]);
  });

  it("leaves the details action bar to the table's row menu", () => {
    expect(getAction("pin")?.inDetails).toBe(false);
    expect(getAction("unpin")?.inDetails).toBe(false);
  });
});
