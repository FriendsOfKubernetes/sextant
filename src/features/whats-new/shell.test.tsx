// "What's new" in the whole window shell with every feature loaded, as after an update from 0.29 (ADR-0166).
import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it } from "vitest";
import { mockBackend, type MockBackend } from "../../api";
import "../../app/features";
import { resetAppStore } from "../../app/store";
import { AppShell } from "../../layout/AppShell";
import { resetUpdatesState } from "../updates";
import { closeWhatsNew } from "./store";

let backend: MockBackend;

beforeEach(() => {
  resetAppStore();
  resetUpdatesState();
  closeWhatsNew();
  backend = mockBackend({}, { settings: { whatsNew: { seenVersion: "0.29.0" } }, app: { version: "0.29.2" } });
});
afterEach(() => backend.restore());

it("opens over the window after an update", async () => {
  render(<AppShell />);
  expect(await screen.findByRole("dialog", { name: "What's new in Sextant 0.30.1" })).toBeInTheDocument();
});
