/**
 * What a read found, kept in this process for a short while and shared: requests that ask while the first read is
 * still running wait for it instead of starting their own, and a write forgets everything kept so the next read
 * sees what the write did. A failed read is not kept.
 */
export function shortMemory(ttlMs: number, now: () => number = Date.now) {
  const kept = new Map<string, { at: number; value: Promise<unknown> }>();
  return {
    read<T>(key: string, load: () => Promise<T>): Promise<T> {
      const held = kept.get(key);
      if (held && now() - held.at < ttlMs) return held.value as Promise<T>;
      const value = load();
      kept.set(key, { at: now(), value });
      value.catch(() => {
        if (kept.get(key)?.value === value) kept.delete(key);
      });
      return value;
    },
    forget(): void {
      kept.clear();
    },
  };
}

/** What the handbook and the MCP sign-in state read, one memory for the process: written by routes that change either. */
export const handbookReads = shortMemory(60_000);
