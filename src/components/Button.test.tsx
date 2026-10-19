import { fireEvent, render, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createRef } from "react";
import { describe, expect, it, vi } from "vitest";
import { Button } from "./Button";

// Read from disk: the test run does not process CSS (`css: false`).
const globalCss = readFileSync(join(process.cwd(), "src/styles/global.css"), "utf8");

/** The declarations of the first rule whose selector list is exactly `selector`. */
function rule(css: string, selector: string): Record<string, string> {
  const blocks = [...css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^}]*)\}/g)];
  const block = blocks.find(([, sel]) => sel!.split(",").map((s) => s.trim()).join(",") === selector);
  if (!block) throw new Error(`no rule for ${selector}`);
  return Object.fromEntries(
    block[2]!
      .split(";")
      .map((d) => d.trim())
      .filter(Boolean)
      .map((d) => [d.slice(0, d.indexOf(":")).trim(), d.slice(d.indexOf(":") + 1).trim()]),
  );
}

describe("Button", () => {
  it("is a plain button by default, not a form submit", () => {
    const onClick = vi.fn();
    render(<Button onClick={onClick}>Save</Button>);
    const button = screen.getByRole("button", { name: "Save" });
    expect(button).toHaveAttribute("type", "button");
    expect(button.className).toBe("btn");
    fireEvent.click(button);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("takes a variant, the compact size, extra classes and a submit type", () => {
    render(
      <>
        <Button variant="primary">Apply</Button>
        <Button variant="danger" size="compact" className="extra">
          Delete
        </Button>
        <Button type="submit">Sign in</Button>
      </>,
    );
    expect(screen.getByRole("button", { name: "Apply" })).toHaveClass("btn", "btn--primary");
    const danger = screen.getByRole("button", { name: "Delete" });
    expect(danger).toHaveClass("btn", "btn--danger", "btn--compact", "extra");
    expect(danger).not.toHaveClass("btn--primary");
    expect(screen.getByRole("button", { name: "Sign in" })).toHaveAttribute("type", "submit");
  });

  it("puts the icon before the text; the name stays the text", () => {
    render(
      <Button icon="logs" variant="default">
        Logs
      </Button>,
    );
    const button = screen.getByRole("button", { name: "Logs" });
    expect(button.firstElementChild?.tagName.toLowerCase()).toBe("svg");
    expect(button).toHaveTextContent(/^Logs$/);
    expect(button).not.toHaveClass("btn--icon");
  });

  it("takes only names of the set as `icon`: a text glyph does not type-check", () => {
    // Checked by `tsc` (npm run check): the directive fails when the line below stops being a type error.
    const wrong = () => (
      // @ts-expect-error a glyph is not an IconName
      <Button icon="≡">Logs</Button>
    );
    expect(wrong).toBeTypeOf("function");
  });

  it("icon only: the label is the accessible name and the tooltip, the content only the icon", () => {
    const ref = createRef<HTMLButtonElement>();
    render(<Button ref={ref} iconOnly icon="eye" label="Show value of password" aria-pressed={false} size="compact" />);
    const button = screen.getByRole("button", { name: "Show value of password" });
    expect(button).toHaveAttribute("aria-label", "Show value of password");
    expect(button).toHaveAttribute("title", "Show value of password");
    expect(button).toHaveAttribute("aria-pressed", "false");
    expect(button).toHaveClass("btn", "btn--icon", "btn--compact");
    expect(button.textContent).toBe("");
    expect(button.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
    expect(ref.current).toBe(button);
  });

  it("icon only keeps a tooltip of its own when one is given", () => {
    render(<Button iconOnly icon="close" label="Close details" title="Close (Esc)" />);
    expect(screen.getByRole("button", { name: "Close details" })).toHaveAttribute("title", "Close (Esc)");
  });
});

describe("button styles", () => {
  it("share the size tokens: 32 px, 28 px compact, 13 px text, 16 px icons", () => {
    const root = rule(globalCss, ":root");
    expect(root["--control-height"]).toBe("32px");
    expect(root["--control-height-compact"]).toBe("28px");
    expect(root["--control-font-size"]).toBe("13px");
    expect(root["--icon-size"]).toBe("16px");
  });

  it("a .btn has a fixed height, never wraps its text and never shrinks in a flex row", () => {
    const btn = rule(globalCss, ".btn");
    expect(btn["height"]).toBe("var(--control-height)");
    expect(btn["white-space"]).toBe("nowrap");
    expect(btn["flex"]).toBe("none");
    expect(btn["display"]).toBe("inline-flex");
    expect(btn["align-items"]).toBe("center");
    expect(btn["font-size"]).toBe("var(--control-font-size)");
    expect(rule(globalCss, ".btn--compact")["height"]).toBe("var(--control-height-compact)");
    const icon = rule(globalCss, ".btn--icon");
    expect(icon["width"]).toBe("var(--control-height)");
    expect(icon["padding"]).toBe("0");
    expect(rule(globalCss, ".btn--icon.btn--compact")["width"]).toBe("var(--control-height-compact)");
  });

  it("an .icon-btn is the size of an icon-only .btn: 32 px, 28 px small", () => {
    const iconBtn = rule(globalCss, ".icon-btn");
    expect(iconBtn["width"]).toBe("var(--control-height)");
    expect(iconBtn["height"]).toBe("var(--control-height)");
    const small = rule(globalCss, ".icon-btn--small");
    expect(small["width"]).toBe("var(--control-height-compact)");
    expect(small["height"]).toBe("var(--control-height-compact)");
  });

  it("show disabled and keyboard focus", () => {
    expect(rule(globalCss, ".btn:disabled,.icon-btn:disabled")["cursor"]).toBe("default");
    expect(rule(globalCss, ".btn:focus-visible,.icon-btn:focus-visible")["outline"]).toContain("var(--color-focus)");
  });
});
