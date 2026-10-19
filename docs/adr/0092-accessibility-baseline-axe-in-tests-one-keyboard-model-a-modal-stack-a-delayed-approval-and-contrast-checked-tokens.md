# ADR-0092: Accessibility baseline: axe in tests, one keyboard model, a modal stack, a delayed approval and contrast-checked tokens

## Context

#158 asked that Sextant be usable with the keyboard alone and with a screen reader, readable in both themes and calm for users who ask for reduced motion. Before it, tables had no row focus (every row and its buttons were tab stops), dialogs did not keep the focus, two open modals both reacted to Escape, a terminal kept the keyboard for good, log views flooded screen readers, several colours were below WCAG AA, and nothing checked any of it.

## Decision

- **axe in Vitest.** `src/test/axe.ts` (`axeViolations`) runs axe-core with the WCAG 2.0–2.2 A/AA tags and best practices over the main screens (`src/test/a11y.test.tsx`) and over every registered page (`src/test/a11y-pages.test.tsx`), and a test fails on any violation. Rules jsdom cannot judge (colour contrast, target size, scrollable regions) are off; contrast is checked by the token test instead. A new screen gets an axe test.
- **One keyboard model.**
  - Resource tables keep one row in the tab order (roving tabindex by object uid, so it survives watch updates): ↑/↓, Home/End, Page Up/Down move, Enter opens the details, Space selects, the context-menu key or Shift+F10 opens the row's actions; a row's checkbox and "⋮" are tab stops only in that row.
  - The dock follows the tabs pattern: ←/→, Home/End move between tabs, Delete closes one, Escape returns the focus to where it was before the tab opened.
  - In a terminal, Ctrl+Shift+E moves the focus to its dock tab; xterm keeps every other key. It is matched by the typed letter, or by the physical key when the layout types no Latin letter there, and is announced through the input's description.
  - The details panel focuses its heading when it opens and gives the focus back to its trigger.
- **A modal stack.** Every modal traps the focus through `useFocusTrap` (`src/components/useFocusTrap.ts`), which the shared `Dialog` uses. Open modals form a stack: only the top one takes Tab and Escape, and on close the focus goes to the modal now on top or back to the opener (an opener removed with a closed menu stands for that menu's opener). The first focus is predictable: `data-autofocus`, else "Cancel" in a confirmation or next to a danger button, else the first text field, else the first footer button. The agent/extension confirmation is `alwaysOnTop`: nothing opened later takes the focus from it, and the command palette does not open over it.
- **A delayed approval.** "Allow" in the agent/extension confirmation (`ConfirmHost.tsx`) ignores keyboard activation for 1 s (`ALLOW_KEYBOARD_DELAY_MS`) and clicks for 300 ms (`ALLOW_CLICK_DELAY_MS`) after a request appears; "Deny" works at once and has the first focus.
- **Quiet live regions.** Log views are `role="log"` with `aria-live="off"`; `LogAnnouncer` says "N new lines" at most every 15 s and only while the focus is in that log. A table announces its row count only after its search or filter changed.
- **Contrast-checked tokens.** Colours come only from the theme tokens in `src/styles/global.css`; `src/styles/contrast.test.ts` computes the WCAG ratios from the token values for the light and dark themes: text and status colours 4.5:1 on every surface, text on fills (`--color-accent-text`, `--color-on-status`) 4.5:1, the focus ring (`--color-focus`) and chart lines (`--color-chart-*`) 3:1. A global `:focus-visible` ring makes the focus visible. Status is never colour only.
- **Reduced motion and zoom.** `prefers-reduced-motion: reduce` turns transitions and animations off (CSS only). Ctrl+= / Ctrl+- / Ctrl+0 zoom the window (Tauri's `zoomHotkeysEnabled`); the page sets the web view back to 100 % on each load (`resetZoomOnLoad`, `src/api/zoom.ts`), because Tauri's hotkey counter restarts there.

## Why

- A test that runs on every page catches regressions that a one-off audit would not; axe is the common engine and needs no browser.
- A delay on "Allow" was chosen over a typed confirmation: an agent's request can appear while the user types elsewhere, and Tab, Enter must not approve a change the user has not read, while a deliberate click is barely slowed.
- A focus stack in one hook was chosen over per-dialog handling: two modals that both react to Escape, or a confirmation that loses the focus to a dialog opened behind it, are the failures the issue described.
- Computing contrast from the token values was chosen because jsdom cannot render colours, and the tokens are the only place colours are defined.

## Consequences

- A new modal uses `Dialog` or `useFocusTrap`; one that handles the focus itself breaks the stack.
- The approval delay must stay; removing it reopens the stray-keystroke approval.
- A new colour is a token in both themes and is added to the contrast test.
- An IBus setup that binds Ctrl+Shift+E to emoji input (a default on several GNOME versions) takes the key before the window; such users change that IBus shortcut.
- Screen-reader behaviour was checked through the accessibility tree and tests, not with every screen reader.

Amended (after v0.15.1, #186): the leave key also has a visible hint over the terminal's corner while it has the focus; text fields and selects are edged with `--color-control-border` (3:1, checked by the contrast test, which also refuses `--color-border` on such a rule); a cluster icon's letters are white or black by contrast with its color.
