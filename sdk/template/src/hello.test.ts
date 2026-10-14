import { startTestHost, type TestHost } from "@sextant/extension-sdk/testing";
import { afterEach, expect, it } from "vitest";
import { startHello } from "./hello";

let host: TestHost;
afterEach(() => host.close());

it("shows where it is and says hello", async () => {
  host = await startTestHost({ context: { clusterId: "kind-sextant-test", theme: "dark" } });
  const root = document.createElement("main");
  startHello(host.sextant, root);
  expect(root.textContent).toContain("Cluster kind-sextant-test, dark theme.");

  host.setContext({ theme: "light" });
  expect(root.textContent).toContain("light theme");

  root.querySelector("button")!.click();
  await expect.poll(() => host.notices).toEqual(["Hello from the Hello extension!"]);
});
