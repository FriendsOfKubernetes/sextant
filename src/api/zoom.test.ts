import { afterEach, describe, expect, it } from "vitest";
import { mockBackend, type MockBackend } from "./mockBackend";
import { resetZoomOnLoad } from "./zoom";

let backend: MockBackend;
afterEach(() => backend.restore());

describe("zoom on load (#158)", () => {
  it("sets the main web view to 100 % once per page load, ignoring a refusal", async () => {
    backend = mockBackend({});
    resetZoomOnLoad();
    resetZoomOnLoad();
    await Promise.resolve();
    expect(backend.calls).toEqual([{ cmd: "plugin:webview|set_webview_zoom", args: { label: "main", value: 1 } }]);
  });
});
