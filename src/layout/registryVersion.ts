// A change counter for a registry, so components that read the registry at render time re-render when something is
// registered or removed after startup (extensions come and go while the window runs).
import { useSyncExternalStore } from "react";

export interface RegistryVersion {
  /** Call after every change of the registry. */
  bump(): void;
  /** The current count; a component that calls it re-renders on every change. */
  use(): number;
  subscribe(listener: () => void): () => void;
  get(): number;
}

export function createRegistryVersion(): RegistryVersion {
  let version = 0;
  const listeners = new Set<() => void>();
  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => void listeners.delete(listener);
  };
  const get = () => version;
  return {
    bump() {
      version++;
      for (const listener of [...listeners]) listener();
    },
    use: () => useSyncExternalStore(subscribe, get, get),
    subscribe,
    get,
  };
}
