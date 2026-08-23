let activeBusinessName: string | null = null;
const listeners = new Set<() => void>();

export function setActiveAgencyBusinessName(name: string | null) {
  const next = name && name.trim() ? name.trim() : null;
  if (next === activeBusinessName) return;
  activeBusinessName = next;
  listeners.forEach((l) => l());
}

export function getActiveAgencyBusinessName(): string | null {
  return activeBusinessName;
}

export function subscribeAgencyBusinessName(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}
