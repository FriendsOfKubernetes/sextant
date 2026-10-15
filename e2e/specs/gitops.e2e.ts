// GitOps scenarios against the fixtures of `scripts/test-cluster.sh up --gitops` (scripts/fixtures/gitops/): the
// Flux Kustomization `sextant-flux/podinfo` and the Argo CD Application `argocd/guestbook`. Each part is skipped
// when the cluster does not serve its kinds (a cluster brought up without --gitops).
import { $, browser, expect } from "@wdio/globals";
import { after, before, describe, it } from "mocha";
import {
  actionOfRow,
  closeDetails,
  connectTo,
  detailsPanel,
  eventually,
  openSection,
  rowWith,
  searchTable,
  textOf,
} from "../app";
import { CONTEXT, hasCrd, kubectl } from "../cluster";

const FLUX_NS = "sextant-flux";
const KUSTOMIZATION = "podinfo";
const ARGO_NS = "argocd";
const APPLICATION = "guestbook";

const suspendedInCluster = () =>
  kubectl("-n", FLUX_NS, "get", "kustomization", KUSTOMIZATION, "-o", "jsonpath={.spec.suspend}").trim();

describe("GitOps on sextant-test", () => {
  const flux = hasCrd("kustomizations.kustomize.toolkit.fluxcd.io");
  const argo = hasCrd("applications.argoproj.io");

  before(async function () {
    if (!flux && !argo) this.skip();
    await browser.setWindowSize(1280, 800);
    await connectTo(CONTEXT);
  });

  describe("Flux", () => {
    before(function () {
      if (!flux) this.skip();
    });

    after(() => {
      // A failed run must not leave the fixture suspended.
      if (!flux) return;
      kubectl("-n", FLUX_NS, "patch", "kustomization", KUSTOMIZATION, "--type=merge", "-p", '{"spec":{"suspend":false}}');
    });

    it("lists the Kustomizations", async () => {
      await openSection("Kustomizations", "Flux");
      await searchTable(KUSTOMIZATION);
      const target = rowWith(KUSTOMIZATION, FLUX_NS);
      await expect(target).toBeDisplayed({ wait: 30_000 });
      await eventually(async () => (await textOf(target)).includes("GitRepository/podinfo"), "the source column");
    });

    it("opens the details of a Kustomization", async () => {
      await rowWith(KUSTOMIZATION, FLUX_NS).click();
      const panel = detailsPanel();
      await expect(panel).toBeDisplayed();
      await expect(panel.$("h2")).toHaveText(KUSTOMIZATION);
      await eventually(async () => (await textOf(panel)).includes("./kustomize"), "the path of the Kustomization");
      await closeDetails();
    });

    it("suspends and resumes a Kustomization", async () => {
      const target = rowWith(KUSTOMIZATION, FLUX_NS);
      await actionOfRow(target, "Suspend");
      const dialog = $('[role="dialog"]');
      await expect(dialog).toBeDisplayed();
      await dialog.$("button=Suspend").click();
      await eventually(() => suspendedInCluster() === "true", "spec.suspend=true in the cluster");
      await eventually(async () => /\bYes\b/.test(await textOf(target)), "Suspended: Yes in the table");

      await actionOfRow(target, "Resume");
      await eventually(() => suspendedInCluster() === "false", "spec.suspend=false in the cluster");
      await eventually(async () => !/\bYes\b/.test(await textOf(target)), "Suspended: No in the table");
    });
  });

  describe("Argo CD", () => {
    before(function () {
      if (!argo) this.skip();
    });

    it("lists the Applications", async () => {
      await closeDetails();
      await openSection("Applications", "Argo CD");
      await searchTable(APPLICATION);
      const target = rowWith(APPLICATION, ARGO_NS);
      await expect(target).toBeDisplayed({ wait: 30_000 });
      await eventually(async () => (await textOf(target)).includes("sextant-argo"), "the destination column");
    });

    it("opens the details of an Application", async () => {
      await rowWith(APPLICATION, ARGO_NS).click();
      const panel = detailsPanel();
      await expect(panel).toBeDisplayed();
      await expect(panel.$("h2")).toHaveText(APPLICATION);
      const text = await eventually(async () => {
        const t = await textOf(panel);
        return t.includes("argocd-example-apps") ? t : "";
      }, "the source of the Application");
      expect(text).toContain("Sync status");
      expect(text).toContain("Health");
      await closeDetails();
    });
  });
});
