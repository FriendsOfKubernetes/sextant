// The order of the namespace filter's list (#219): the namespaces selected when the list was opened come first,
// sorted by name, then the others. The split is taken once per opening, so ticking or unticking an item while the
// list is open never moves it from under the pointer; the next opening sorts again.

export interface NamespaceGroups {
  /** Namespaces selected when the list was opened (and still known), sorted by name. */
  selected: string[];
  /** Every other namespace, sorted by name. */
  others: string[];
}

/**
 * Splits `all` into the namespaces of `pinned` (the selection at opening) and the rest, both sorted by name, and
 * keeps those whose name contains `filter` (case-insensitive, trimmed). A pinned name missing from `all` is dropped.
 */
export function orderNamespaces(all: readonly string[], pinned: readonly string[], filter = ""): NamespaceGroups {
  const needle = filter.trim().toLowerCase();
  const pinnedSet = new Set(pinned);
  const selected: string[] = [];
  const others: string[] = [];
  for (const ns of [...new Set(all)].sort()) {
    if (needle && !ns.toLowerCase().includes(needle)) continue;
    (pinnedSet.has(ns) ? selected : others).push(ns);
  }
  return { selected, others };
}
