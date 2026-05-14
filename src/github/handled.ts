export const MAX_HANDLED_THREAD_IDS = 50;
export const MAX_HANDLED_CHECK_NAMES = 50;

export function appendRecentUnique(existing: readonly string[], additions: readonly string[], limit: number): string[] {
  const recent: string[] = [];
  const seen = new Set<string>();

  for (const value of existing.slice(-limit)) {
    if (!value || seen.has(value)) continue;
    seen.add(value);
    recent.push(value);
  }

  for (const value of additions) {
    if (!value) continue;
    if (seen.has(value)) {
      const index = recent.indexOf(value);
      if (index >= 0) recent.splice(index, 1);
    }
    seen.add(value);
    recent.push(value);
    if (recent.length > limit) {
      const removed = recent.shift();
      if (removed) seen.delete(removed);
    }
  }

  return recent;
}
