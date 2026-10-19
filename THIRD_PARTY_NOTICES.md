# Third-party notices

Sextant itself is licensed under MIT OR Apache-2.0 (`LICENSE-MIT`, `LICENSE-APACHE`). This file lists third-party
material that is shipped inside the application and carries its own notice requirements. Rust crates and npm packages
linked into the program are under their own licences, listed in `Cargo.lock` / `package-lock.json`.

## Fonts (embedded in the frontend bundle, ADR-0093)

| Font | Copyright | Licence |
|---|---|---|
| Fira Sans 4.203 (WOFF2 subsets latin, latin-ext, cyrillic, cyrillic-ext; weights 400, 500, 600, 700, 400 italic) | Copyright (c) 2012-2015, The Mozilla Foundation and Telefonica S.A. | SIL Open Font License 1.1 |
| Fira Mono 3.206 (WOFF2 subsets latin, latin-ext, cyrillic, cyrillic-ext; weights 400, 700) | Copyright (c) 2012-2013, The Mozilla Corporation and Telefonica S.A. | SIL Open Font License 1.1 |

The files come from the npm packages `@fontsource/fira-sans` and `@fontsource/fira-mono` (Google Fonts builds), not
changed by Sextant. No Reserved Font Name is declared. The full licence text with these copyright lines is
`src/assets/fonts/OFL.txt`; it is compiled into the application and shown in About Sextant ("Fonts: …").
