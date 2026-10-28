// Terminal tools are installed from three places (a cluster's terminal, the Helm section, the tools list): an install
// in one tells the others, so a list already shown does not keep saying "Not installed".
const listeners = new Set<() => void>();

/** Calls `listener` after every install or removal; returns the unsubscribe. */
export function onToolsChanged(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function toolsChanged(): void {
  for (const listener of listeners) listener();
}
