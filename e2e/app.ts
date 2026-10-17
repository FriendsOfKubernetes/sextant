// Helpers that drive the Sextant window through WebdriverIO. Elements are found the way a user finds them: by
// their accessible name (`aria/…`) inside a named region.
import { $, browser } from "@wdio/globals";

type Element = ReturnType<typeof $>;

/** An element by accessible name, optionally inside `scope`. */
export function byName(name: string, scope?: Element): Element {
  return scope ? scope.$(`aria/${name}`) : $(`aria/${name}`);
}

export async function click(name: string, scope?: Element): Promise<void> {
  const el = byName(name, scope);
  await el.waitForClickable();
  await el.click();
}

/**
 * The header of a collapsible sidebar section, found by its label alone: a header may also carry a counter (the
 * problems of "Cluster", of "Gateway API"), which a match on the button's whole text would trip over.
 */
export function sectionGroup(sidebar: Element, group: string): Element {
  return sidebar.$(
    `.//button[@aria-expanded][.//span[contains(concat(" ", @class, " "), " sidebar__label ") and normalize-space(.)="${group}"]]`,
  );
}

/** An entry of the sidebar (not a section header, which may have the same label: a section shown as one link). */
export function sectionEntry(sidebar: Element, entry: string): Element {
  return sidebar.$(`.//button[not(@aria-expanded) and normalize-space(.)="${entry}"]`);
}

/** Opens a sidebar entry; `group` is the collapsible section it lives in. */
export async function openSection(entry: string, group?: string): Promise<void> {
  const sidebar = $('nav[aria-label="Sections"]');
  await sidebar.waitForDisplayed();
  if (group) {
    const groupButton = sectionGroup(sidebar, group);
    if ((await groupButton.isExisting()) && (await groupButton.getAttribute("aria-expanded")) === "false") {
      await groupButton.click();
    }
  }
  const item = sectionEntry(sidebar, entry);
  await item.waitForClickable();
  await item.click();
}

/** The table of the open section after typing `search` into its search box. */
export async function searchTable(search: string): Promise<Element> {
  const box = $('main input[type="search"]');
  await box.waitForDisplayed();
  await box.setValue(search);
  return $("main [role='table']");
}

/** The table row (not the header) whose text contains `text`: a resource table row or a plain `<tr>`. */
export function row(text: string): Element {
  return $(`//main//*[(self::tr or @role='row') and not(@aria-rowindex='1') and not(.//th) and contains(., '${text}')]`);
}

/**
 * Types `text` into the focused element one key at a time: within one action WebKitWebDriver drops repeated keys
 * and some spaces.
 */
export async function typeText(text: string): Promise<void> {
  for (const key of text) await browser.keys(key);
}

/** Closes the details panel if it is open. */
export async function closeDetails(): Promise<void> {
  const close = byName("Close details");
  if (await close.isExisting()) await close.click();
}

/** Runs an action from the row's "⋮" menu. */
export async function rowAction(name: string, action: string): Promise<void> {
  await click(`Actions for ${name}`);
  const menu = $("[role='menu']");
  await menu.waitForDisplayed();
  await menu.$(`[role='menuitem']*=${action}`).click();
}

export function detailsPanel(): Element {
  return $('aside[aria-label="Details"]');
}

export function dock(): Element {
  return $('section[aria-label="Dock"]');
}

/** The visible panel of the active dock tab. */
export function activeDockPanel(): Element {
  return $('section[aria-label="Dock"] [role="tabpanel"]:not([hidden])');
}

/** Waits until `read()` returns something truthy, returning it. */
export async function eventually<T>(read: () => T | Promise<T>, what: string, timeout = 30_000): Promise<NonNullable<T>> {
  let value: T | undefined;
  await browser.waitUntil(
    async () => {
      value = await read();
      return Boolean(value);
    },
    { timeout, interval: 500, timeoutMsg: `timed out waiting for ${what}` },
  );
  return value as NonNullable<T>;
}

/** Text of the element as rendered (`innerText`); "" while it does not exist. */
export async function textOf(el: Element): Promise<string> {
  if (!(await el.isExisting())) return "";
  return browser.execute((node: HTMLElement) => node.innerText, await el.getElement());
}

/** Connects to `context` from the cluster rail and waits for its sections. */
export async function connectTo(context: string): Promise<void> {
  const rail = $('nav[aria-label="Clusters"]');
  await click(context, rail);
  await $('nav[aria-label="Sections"]').waitForDisplayed({ timeout: 60_000 });
  await browser.waitUntil(async () => (await byName(context, rail).getAttribute("data-state")) === "connected", {
    timeout: 60_000,
    timeoutMsg: `${context} did not connect`,
  });
}

/** The table row with a cell of exactly each of `cells` (e.g. a name and a namespace). */
export function rowWith(...cells: string[]): Element {
  const has = cells.map((c) => `.//*[normalize-space(text())='${c}']`).join(" and ");
  return $(`//main//*[(self::tr or @role='row') and not(@aria-rowindex='1') and not(.//th) and ${has}]`);
}

/** Runs an action from the "⋮" menu of the row `target` (when its name alone is not unique). */
export async function actionOfRow(target: Element, action: string): Promise<void> {
  const button = target.$('button[aria-label^="Actions for"]');
  await button.waitForClickable();
  await button.click();
  const menu = $("[role='menu']");
  await menu.waitForDisplayed();
  await menu.$(`[role='menuitem']*=${action}`).click();
}
