# ADR-0033: Icons — the lucide-react set, connected only through a shared icon module

## Context

The app had neither an icon library nor SVG in JSX: action icons were text glyphs (≡, >_, ⇄, ✎, ×, ↻, ⏸, ⋮, ⚙ and others) in the string `ActionDef.icon`. The side menu had no icons at all. For 0.4.0, uniform icons are needed on action buttons, on the Show/Hide eye, and on sections and menu items. The CSP already allows `img-src data:`, but the network and external resources are not used for the UI.

## Decision

We take `lucide-react` (ISC, SVG components, works with React 19). Features do not import it: all icons are gathered in one shared module under their own names (`IconName`), and actions, menu items and pages refer to an icon by that name. A name outside the set is drawn as text, like the former glyph (compatibility with tests and old registrations). The SVGs are hidden from accessibility and have no `<title>`: the text of a button or menu item stays exactly what it was.

## Why

- An icon font was rejected: a uniform outline style, `currentColor` and the absence of fonts and network are needed outright (as the specification says); a font is an extra resource and one more point of failure.
- Keeping text glyphs was rejected: they are what we are replacing, because the set is heterogeneous and there are no suitable glyphs for the menu sections. Glyphs remained only as a fallback path.
- Our own SVG files imported as components were rejected: the project has no plugin for this (`vite-plugin-svgr` is not installed), and a set of dozens of icons would have to be drawn and maintained by us. The materials did not compare this directly; the argument follows from the state of the project.
- Importing `lucide-react` directly from features was rejected: replacing the set would then mean editing dozens of files, whereas this way it is one module.
- We do not take the Flux and Argo CD logos: the marks are licensed. For their sections, icons close in meaning were chosen.

## Consequences

- Icon names form a closed union, and this is a contract. A feature that needs a new icon will have to edit the shared module; in this build the menu and rail tasks did not edit it and stopped when a name was lacking. The base assembled names in advance, and some unused ones were later removed.
- A new dependency in `package.json`; only the icons used end up in the bundle.
- The Flux and Argo CD icons are not recognizable by brand: "refresh/flow" and "git-branch/rocket" only hint at them.
- Changing the set means editing one module and the name mapping table, but the look of the whole interface changes at once.
- Tests and e2e find buttons by accessible name, so a button of one icon with no label is an error; the duty to label lies with `Button` (ADR-0034).
