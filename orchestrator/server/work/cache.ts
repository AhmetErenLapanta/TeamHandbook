/** A tracker answer as the screens get it: when it was read, and whether a newer read is on its way. */
export interface Cached<T> {
  value: T;
  fetchedAt: string;
  stale: boolean;
}

interface Entry {
  at: number;
  value: unknown;
  loading?: Promise<unknown>;
}

export const WORK_TTL_MS = 60_000;
export const FRESH_EVERY_MS = 15_000;
const MAX_ENTRIES = 500;

/**
 * What the trackers answered, kept in this process only: a board polled every few seconds asks
 * the tracker once a minute, and an issue's text never reaches the database, a backup or an
 * export. An answer past its minute is returned at once and read again behind it; a fresh read,
 * as a board's "Read the tracker again" and the automations' watch make, asks the tracker anew.
 */
export class WorkCache {
  private readonly entries = new Map<string, Entry>();

  constructor(private readonly now: () => number = Date.now) {}

  async read<T>(key: string, load: () => Promise<T>, fresh = false): Promise<Cached<T>> {
    const entry = this.entries.get(key);
    const age = entry ? this.now() - entry.at : Infinity;
    if (entry && !(fresh && age >= FRESH_EVERY_MS)) {
      if (age < WORK_TTL_MS) return this.answer(entry, false);
      this.reload(key, entry, load);
      return this.answer(entry, true);
    }
    const value = await load();
    const stored = { at: this.now(), value };
    this.entries.delete(key);
    this.entries.set(key, stored);
    if (this.entries.size > MAX_ENTRIES) this.entries.delete(this.entries.keys().next().value!);
    return this.answer(stored, false);
  }

  /** Drops every answer whose key starts with `prefix`, such as one tenant's tracker. */
  evict(prefix: string): void {
    for (const key of [...this.entries.keys()]) if (key.startsWith(prefix)) this.entries.delete(key);
  }

  private reload<T>(key: string, entry: Entry, load: () => Promise<T>): void {
    if (entry.loading) return;
    entry.loading = load().then(
      (value) => {
        if (this.entries.get(key) === entry) this.entries.set(key, { at: this.now(), value });
        return value;
      },
      (err: Error) => {
        // A read that failed behind a stale answer is not kept: the next read asks again and shows its error.
        if (this.entries.get(key) === entry) this.entries.delete(key);
        console.error(`work: ${err.message}`);
      },
    );
  }

  private answer<T>(entry: Entry, stale: boolean): Cached<T> {
    return { value: entry.value as T, fetchedAt: new Date(entry.at).toISOString(), stale };
  }
}
