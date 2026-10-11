// Loads every feature module `src/features/<name>/index.ts(x)`. Features register their pages, dock tabs,
// details sections, actions and slots there, so adding a feature never edits the shell.
export const featureModules = import.meta.glob("../features/*/index.{ts,tsx}", { eager: true });
