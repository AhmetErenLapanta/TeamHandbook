/**
 * What a read found, kept in this process for a short while and shared: requests that ask while the first read is
 * still running wait for it instead of starting their own, and a write forgets everything kept so the next read
 * sees what the write did. A failed read is not kept. With `staleMs`, an answer past its time but within that many
 * more milliseconds is returned at once and read again behind it, so a page does not wait on a slow command twice.
 */
export function shortMemory(ttlMs: number, now: () => number = Date.now, staleMs = 0) {
  const kept = new Map<string, { at: number; value: Promise<unknown>; reloading?: boolean }>();
  const store = (key: string, load: () => Promise<unknown>) => {
    const entry = { at: now(), value: load() };
    kept.set(key, entry);
    entry.value.catch(() => {
      if (kept.get(key) === entry) kept.delete(key);
    });
    return entry;
  };
  return {
    read<T>(key: string, load: () => Promise<T>): Promise<T> {
      const held = kept.get(key);
      const age = held ? now() - held.at : Infinity;
      if (held && age < ttlMs) return held.value as Promise<T>;
      if (held && age < ttlMs + staleMs) {
        if (!held.reloading) {
          held.reloading = true;
          // A reload that fails keeps the answer it was to replace; the next read past its time tries again.
          load().then(
            (value) => {
              if (kept.get(key) === held) kept.set(key, { at: now(), value: Promise.resolve(value) });
            },
            () => {
              held.reloading = false;
            },
          );
        }
        return held.value as Promise<T>;
      }
      return store(key, load).value as Promise<T>;
    },
    forget(): void {
      kept.clear();
    },
  };
}

/** What the handbook and the MCP sign-in state read, one memory for the process, answering from the last read for ten minutes more while a new one runs behind: written by routes that change either. */
export const handbookReads = shortMemory(60_000, Date.now, 10 * 60_000);
