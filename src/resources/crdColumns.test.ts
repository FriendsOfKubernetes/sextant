import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mockBackend, type KubeObject, type MockBackend, type ResourceKind } from "../api";
import { forgetCrdPrinterColumns, useCrdPrinterColumns } from "./crdColumns";

const widget: ResourceKind = {
  kindRef: { group: "demo.sextant.dev", version: "v1", kind: "Widget" },
  plural: "widgets",
  namespaced: true,
  verbs: ["list", "watch"],
  printerColumns: [],
};

const widgetsCrd: KubeObject = {
  apiVersion: "apiextensions.k8s.io/v1",
  kind: "CustomResourceDefinition",
  metadata: { name: "widgets.demo.sextant.dev", uid: "crd-1" },
  spec: {
    versions: [
      { name: "v1", additionalPrinterColumns: [{ name: "Size", jsonPath: ".spec.size", type: "string" }] },
    ],
  },
};

const SIZE = [{ name: "Size", jsonPath: ".spec.size", type: "string", priority: 0 }];

let backend: MockBackend;
/** What the next `resource_get` of the CRD does: the CRD, or throws this error code. */
let answer: { code: string } | "crd";

beforeEach(() => {
  forgetCrdPrinterColumns();
  answer = "crd";
  backend = mockBackend({
    resource_get: () => {
      if (answer === "crd") return widgetsCrd;
      throw { code: answer.code, message: "failed" };
    },
  });
});

afterEach(() => {
  backend.restore();
  forgetCrdPrinterColumns();
});

const reads = () => backend.calls.filter((c) => c.cmd === "resource_get").length;

/** Opens a CR table (mounts the hook) and returns once the CRD read has finished. */
async function open() {
  const before = reads();
  const view = renderHook(() => useCrdPrinterColumns("c1", widget));
  await waitFor(() => expect(reads()).toBe(before + 1));
  // Let the rejected or resolved promise settle.
  await new Promise((resolve) => setTimeout(resolve, 0));
  return view;
}

describe("printer columns of a custom resource", () => {
  it("are read from the CRD", async () => {
    const view = await open();
    await waitFor(() => expect(view.result.current).toEqual(SIZE));
  });

  it.each(["forbidden", "notFound"])("a CRD that %s is remembered as having no columns: it is not read again", async (code) => {
    answer = { code };
    const first = await open();
    await waitFor(() => expect(first.result.current).toEqual([]));
    first.unmount();

    const again = renderHook(() => useCrdPrinterColumns("c1", widget));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(reads()).toBe(1);
    expect(again.result.current).toEqual([]);
  });

  it.each(["timeout", "unreachable", "other"])(
    "a CRD that failed with %s is read again by the next table",
    async (code) => {
      answer = { code };
      const first = await open();
      // The failure is not remembered as "no columns".
      expect(first.result.current).toBeNull();
      first.unmount();

      answer = "crd";
      const again = await open();
      expect(reads()).toBe(2);
      await waitFor(() => expect(again.result.current).toEqual(SIZE));
    },
  );
});
