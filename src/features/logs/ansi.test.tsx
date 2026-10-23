import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cssRule } from "../../test/css";
import { parseAnsi, visibleText, type AnsiSegment } from "./ansi";
import { findMatches, MatchIndex } from "./search";
import { appendLines, EMPTY_BUFFER } from "./buffer";
import { logText, type LogTextOptions } from "./LogText";
import { logViewOf } from "./viewSettings";

const E = "\u001b";

describe("ANSI parser", () => {
  const cases: [string, string, AnsiSegment[]][] = [
    ["plain text", "hello", [{ text: "hello", style: null }]],
    ["empty line", "", [{ text: "", style: null }]],
    ["one colour and reset", `${E}[31mred${E}[0m plain`, [
      { text: "red", style: { fg: 1 } },
      { text: " plain", style: null },
    ]],
    ["empty parameters reset", `${E}[1mbold${E}[mplain`, [
      { text: "bold", style: { bold: true } },
      { text: "plain", style: null },
    ]],
    ["nesting adds to the style; 22, 39 and 49 undo one part", `${E}[1m${E}[33;44mA${E}[22mB${E}[39mC${E}[49mD`, [
      { text: "A", style: { bold: true, fg: 3, bg: 4 } },
      { text: "B", style: { fg: 3, bg: 4 } },
      { text: "C", style: { bg: 4 } },
      { text: "D", style: null },
    ]],
    ["0 inside a list resets before what follows", `${E}[1;31mA${E}[0;32mB`, [
      { text: "A", style: { bold: true, fg: 1 } },
      { text: "B", style: { fg: 2 } },
    ]],
    ["bright colours", `${E}[91;102mA`, [{ text: "A", style: { fg: 9, bg: 10 } }]],
    ["dim, italic, underline, strike, inverse and their resets", `${E}[2;3;4;9;7mA${E}[23;24;27;29mB`, [
      { text: "A", style: { dim: true, italic: true, underline: true, strike: true, inverse: true } },
      { text: "B", style: { dim: true } },
    ]],
    ["256 colours: palette, cube and grey", `${E}[38;5;9mA${E}[38;5;208mB${E}[48;5;244mC`, [
      { text: "A", style: { fg: 9 } },
      { text: "B", style: { fg: { r: 255, g: 135, b: 0 } } },
      { text: "C", style: { fg: { r: 255, g: 135, b: 0 }, bg: { r: 128, g: 128, b: 128 } } },
    ]],
    ["truecolor, with semicolons and with colons", `${E}[38;2;10;20;30mA${E}[48:2::1:2:3mB`, [
      { text: "A", style: { fg: { r: 10, g: 20, b: 30 } } },
      { text: "B", style: { fg: { r: 10, g: 20, b: 30 }, bg: { r: 1, g: 2, b: 3 } } },
    ]],
    ["an out-of-range colour is ignored, the rest still applies", `${E}[38;5;300;1mA${E}[38;2;256;0;0mB`, [
      { text: "A", style: { bold: true } },
      { text: "B", style: { bold: true } },
    ]],
    ["an unknown colour kind stops the list", `${E}[38;9;1mA`, [{ text: "A", style: null }]],
    ["unknown SGR codes are skipped", `${E}[5;53;1mA`, [{ text: "A", style: { bold: true } }]],
    ["a private SGR sequence is ignored", `${E}[>4;2mA`, [{ text: "A", style: null }]],
    ["other CSI sequences are dropped", `${E}[2K${E}[1G${E}[?25lA${E}[3;4HB`, [{ text: "AB", style: null }]],
    ["OSC 8 links keep their text", `${E}]8;;https://example.com${E}\\link${E}]8;;${E}\\ end`, [{ text: "link end", style: null }]],
    ["a window title ended by BEL is dropped", `${E}]0;title\u0007A`, [{ text: "A", style: null }]],
    ["character set and two-character sequences are dropped", `${E}(BA${E}7B${E}cC`, [{ text: "ABC", style: null }]],
    ["a sequence cut off at the end is dropped", `A${E}[1;3`, [{ text: "A", style: null }]],
    ["a lone ESC at the end is dropped", `A${E}`, [{ text: "A", style: null }]],
    ["a broken CSI drops only what was read", `${E}[1\u0001A`, [{ text: "A", style: null }]],
    ["an unterminated OSC never hides the rest of the line", `${E}]8;;x A`, [{ text: "8;;x A", style: null }]],
    ["8-bit CSI", `\u009b31mA`, [{ text: "A", style: { fg: 1 } }]],
    ["other control characters are dropped, tabs kept", `a\u0007\u0008b\tc\u007f`, [{ text: "ab\tc", style: null }]],
    ["CRLF and CR read as line breaks", "a\r\nb\rc\nd", [{ text: "a\nb\nc\nd", style: null }]],
    ["HTML-like text stays text", `${E}[31m<img src=x onerror=alert(1)>${E}[0m`, [
      { text: "<img src=x onerror=alert(1)>", style: { fg: 1 } },
    ]],
    ["only codes", `${E}[31m${E}[0m`, [{ text: "", style: null }]],
  ];

  it.each(cases)("%s", (_name, raw, expected) => {
    expect(parseAnsi(raw)).toEqual(expected);
    expect(visibleText(raw)).toBe(expected.map((s) => s.text).join(""));
  });

  it("the user's line reads as its text", () => {
    const line = `[2026-10-19T19:55:55.579172+00:00] ${E}[1mChain worker${E}[0m.${E}[0;33mwarning${E}[0m: ${E}[1;36mError send to client: … ${E}[1;35m(276.09ms)${E}[0m ${E}[1;33mPHPMailer Exception, SMTP Error: Could not connect to SMTP host. /opt/app/Email.php:401${E}[0m`;
    expect(visibleText(line)).toBe(
      "[2026-10-19T19:55:55.579172+00:00] Chain worker.warning: Error send to client: … (276.09ms) PHPMailer Exception, SMTP Error: Could not connect to SMTP host. /opt/app/Email.php:401",
    );
    expect(parseAnsi(line).find((s) => s.text.startsWith("Error send"))?.style).toEqual({ bold: true, fg: 6 });
  });
});

describe("log text rendering", () => {
  const options: LogTextOptions = { colours: true, wrap: false, lineBreakLabel: "line break" };
  const draw = (raw: string, extra: Partial<LogTextOptions> = {}) => {
    const { container } = render(<div>{logText(raw, { ...options, ...extra })}</div>);
    return container.firstElementChild as HTMLElement;
  };

  it("a hostile line stays text", () => {
    const el = draw(`${E}[31m<script>alert(1)</script><img src=x onerror=alert(2)>${E}[0m`);
    expect(el.querySelector("script, img")).toBeNull();
    expect(el.textContent).toBe("<script>alert(1)</script><img src=x onerror=alert(2)>");
  });

  it("colours become palette classes or checked rgb() styles", () => {
    const el = draw(`${E}[31;42mA${E}[0m${E}[38;2;1;2;3;48;5;196mB`);
    const [a, b] = [...el.querySelectorAll<HTMLElement>(".logs__ansi")];
    expect(a).toHaveClass("logs__ansi-fg1", "logs__ansi-bg2");
    expect(b!.style.color).toBe("rgb(1, 2, 3)");
    expect(b!.style.backgroundColor).toBe("rgba(255, 0, 0, 0.35)");
  });

  it("inverse uses the theme's colours", () => {
    const el = draw(`${E}[7;31mA`);
    const span = el.querySelector(".logs__ansi")!;
    expect(span).toHaveClass("logs__ansi-inverse");
    expect(span).not.toHaveClass("logs__ansi-fg1");
  });

  it("without colours the text is plain", () => {
    const el = draw(`${E}[1;31mA${E}[0mB`, { colours: false });
    expect(el.querySelector("span")).toBeNull();
    expect(el.textContent).toBe("AB");
  });

  it("one line per entry shows each break as a labelled symbol; wrapping keeps the break", () => {
    const one = draw("a\nb");
    const symbol = one.querySelector('[role="img"]')!;
    expect(symbol).toHaveAttribute("aria-label", "line break");
    expect(symbol).toHaveClass("logs__nl");
    expect(one.textContent).toBe("a↵b");
    const wrapped = draw("a\nb", { wrap: true });
    expect(wrapped.querySelector('[role="img"]')).toBeNull();
    expect(wrapped.textContent).toBe("a\nb");
  });

  it("matches are marked across style changes; the current one is stronger", () => {
    const el = draw(`ab${E}[31mcd${E}[0mef`, { ranges: [{ start: 1, end: 3 }, { start: 4, end: 6, current: true }] });
    const marks = [...el.querySelectorAll("mark")];
    expect(marks.map((m) => m.textContent)).toEqual(["b", "c", "ef"]);
    expect(marks[1]!.querySelector(".logs__ansi-fg1")).not.toBeNull();
    expect(marks[2]).toHaveClass("logs__mark--current");
    expect(el.textContent).toBe("abcdef");
  });

  it("an empty line keeps its height", () => {
    expect(draw("").textContent).toBe(" ");
    expect(draw(`${E}[0m`).textContent).toBe(" ");
  });
});

describe("log view setting", () => {
  it("reads leniently: a missing or wrong field keeps its default", () => {
    expect(logViewOf(null)).toEqual({ wrap: false, colours: true });
    expect(logViewOf({ logs: { wrap: true, colours: false } })).toEqual({ wrap: true, colours: false });
    expect(logViewOf({ logs: { wrap: "yes", colours: 0 } } as never)).toEqual({ wrap: false, colours: true });
    expect(logViewOf({} as never)).toEqual({ wrap: false, colours: true });
  });
});

describe("ANSI palette contrast", () => {
  type Rgb = [number, number, number];
  const hex = (value: string): Rgb => {
    const m = /^#([0-9a-f]{6})$/i.exec(value);
    if (!m) throw new Error(`not a colour: ${value}`);
    return [0, 2, 4].map((i) => parseInt(m[1]!.slice(i, i + 2), 16)) as Rgb;
  };
  const luminance = (rgb: Rgb) => {
    const [r, g, b] = rgb.map((v) => {
      const c = v / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
  };
  const ratio = (a: Rgb, b: Rgb) => {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (hi! + 0.05) / (lo! + 0.05);
  };

  it.each([
    ["light", ':root,\n:root[data-theme="light"]'],
    ["dark", ':root[data-theme="dark"]'],
  ])("every palette colour is readable on the %s dock (4.5:1)", (_theme, selector) => {
    // logs.css has more than one rule per theme selector: read them all.
    const css = readFileSync(join(process.cwd(), "src/features/logs/logs.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    const tokens: Record<string, string> = {};
    for (const [, sel, body] of css.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
      if (sel!.trim() !== selector) continue;
      for (const m of body!.matchAll(/(--logs-ansi-\d+)\s*:\s*([^;]+);/g)) tokens[m[1]!] = m[2]!.trim();
    }
    const dock = hex(cssRule("src/styles/global.css", selector)["--color-dock"]!);
    const weak = Array.from({ length: 16 }, (_, i) => [i, ratio(hex(tokens[`--logs-ansi-${i}`]!), dock)] as const).filter(
      ([, r]) => r < 4.5,
    );
    expect(weak).toEqual([]);
  });
});

describe("performance", () => {
  const coloured = (i: number) =>
    `[2026-10-19T19:55:55.${String(i).padStart(6, "0")}+00:00] ${E}[1mworker${E}[0m.${E}[0;33mwarning${E}[0m: ${E}[1;36mrequest ${i} took ${E}[1;35m(${i}ms)${E}[0m`;

  /** The fastest of `times` runs after one warm-up, in milliseconds. */
  const fastest = (run: () => void, times: number): number => {
    run();
    let best = Infinity;
    for (let i = 0; i < times; i++) {
      const started = performance.now();
      run();
      best = Math.min(best, performance.now() - started);
    }
    return best;
  };

  it("10 000 coloured lines are parsed and searched in time that grows linearly with their number", () => {
    // Compared with a tenth of the lines in the same run, not a fixed time: a loaded runner is slow for both (#258).
    // Linear work takes ~10x as long for 10x the lines; a quadratic path would take ~100x.
    const lines = Array.from({ length: 10_000 }, (_, i) => coloured(i));
    const tenth = lines.slice(0, 1_000);
    let chars = 0;
    const parse = (input: string[]) => () => {
      chars = 0;
      for (const line of input) chars += visibleText(line).length;
    };
    const parsedTenth = fastest(parse(tenth), 5);
    const parsed = fastest(parse(lines), 3);
    expect(chars).toBeGreaterThan(0);
    expect(findMatches(lines, "request 9999 took")).toEqual([{ line: 9999, start: expect.any(Number) }]);
    const searchedTenth = fastest(() => findMatches(tenth, "request 9999 took"), 5);
    const searched = fastest(() => findMatches(lines, "request 9999 took"), 3);
    expect(parsed).toBeLessThan(Math.max(30 * parsedTenth, 20));
    expect(searched).toBeLessThan(Math.max(30 * searchedTenth, 20));
  });

  it.each([
    ["ESC ]", "\u001b]"],
    ["ESC P", "\u001bP"],
    ["ESC _", "\u001b_"],
    ["ESC [ digits", "\u001b[1"],
    ["ESC ( ", "\u001b("],
  ])("a 64 KB line of repeated %s parses in linear time", (_name, piece) => {
    const line = piece.repeat(Math.ceil(65_536 / piece.length));
    const tenth = piece.repeat(Math.ceil(6_554 / piece.length));
    expect(visibleText(line).length).toBeLessThan(line.length);
    // Linear: about 1 ms, ~10x a tenth of the line measured in the same run; the quadratic scan took seconds.
    expect(fastest(() => visibleText(line), 3)).toBeLessThan(Math.max(30 * fastest(() => visibleText(tenth), 5), 20));
  });

  it("random escape-heavy lines parse in bounded time and never keep an ESC", () => {
    let seed = 42;
    const random = () => (seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31) / 2 ** 31;
    const alphabet = ["\u001b", "[", "]", "P", "\\", "\u0007", ";", "m", "1", "38", "5", "2", "a", " ", "\u009b", "\u009c", "\r", "\n", "<b>"];
    let worst = 0;
    for (let n = 0; n < 200; n++) {
      let line = "";
      while (line.length < 2048) line += alphabet[Math.floor(random() * alphabet.length)];
      const t0 = performance.now();
      const segments = parseAnsi(line);
      worst = Math.max(worst, performance.now() - t0);
      for (const s of segments) expect([...s.text].some((c) => "\u001b\u009b\u009c\u0007\r".includes(c))).toBe(false);
    }
    expect(worst).toBeLessThan(50);
  });

  it("a search over 100 000 coloured lines reads only the appended lines on each batch", () => {
    let buffer = appendLines(EMPTY_BUFFER, Array.from({ length: 100_000 }, (_, i) => coloured(i)));
    const index = new MatchIndex();
    const t0 = performance.now();
    const first = index.update(buffer.lines, buffer.dropped, "request 99999 took", "s1");
    const initial = performance.now() - t0;
    expect(first).toEqual([{ line: 99_999, start: expect.any(Number) }]);

    const batches: number[] = [];
    for (let b = 0; b < 10; b++) {
      buffer = appendLines(buffer, Array.from({ length: 100 }, (_, i) => coloured(100_000 + b * 100 + i)));
      const t1 = performance.now();
      const found = index.update(buffer.lines, buffer.dropped, "request 99999 took", "s1");
      batches.push(performance.now() - t1);
      // Older lines were discarded (the buffer keeps 100 000): the match moves up.
      expect(found).toEqual([{ line: 99_999 - buffer.dropped, start: expect.any(Number) }]);
    }
    expect(initial).toBeLessThan(1500);
    // A batch reads 100 lines, a full pass reads 100 000: compare with the full pass measured on the same machine
    // rather than a fixed number of milliseconds (a loaded CI runner took 23 ms for a batch once).
    const median = [...batches].sort((a, b) => a - b)[Math.floor(batches.length / 2)]!;
    expect(median).toBeLessThan(Math.max(initial / 10, 5));
  });

  it("the incremental search gives what a full search gives, through drops, a new query and a new stream", () => {
    let buffer = appendLines(EMPTY_BUFFER, ["a x", "b", "x x"], 4, Infinity);
    const index = new MatchIndex();
    const check = (query: string, generation = "g") =>
      expect(index.update(buffer.lines, buffer.dropped, query, generation)).toEqual(findMatches(buffer.lines, query));
    check("x");
    buffer = appendLines(buffer, ["\u001b[31mx\u001b[0m", "y"], 4, Infinity);
    check("x");
    check("y");
    buffer = appendLines(EMPTY_BUFFER, ["new x"], 4, Infinity);
    check("x", "g2");
  });
});
