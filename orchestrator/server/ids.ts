import { randomBytes } from "node:crypto";

/** What each kind of record's id starts with, so an id says what it names wherever it is pasted. */
export type IdPrefix = "usr" | "inv" | "key" | "svc" | "tsk" | "evt" | "pol" | "idn" | "eff" | "aut" | "drf" | "ses" | "att" | "ide" | "mch" | "req" | "fup" | "ssr" | "mcp";

// Crockford's base32 in lower case: no i, l, o or u to misread, and safe in a path, a branch
// name and a container name, which a task's id becomes.
const ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";
const BODY = "[0-9a-hjkmnp-tv-z]{26}";

function base32(value: bigint, length: number): string {
  let out = "";
  for (let i = 0; i < length; i++) {
    out = ALPHABET[Number(value & 31n)] + out;
    value >>= 5n;
  }
  return out;
}

let last = { time: -1, random: 0n };

/**
 * A new id: the prefix, then 10 characters of the time in milliseconds and 16 random ones
 * (80 bits). Ids made later sort after ids made earlier, as text, so a list ordered by id is
 * ordered by when its records were made; two made in the same millisecond by this process take
 * the random part of the first plus one, so they too read back in the order they were made.
 */
export function newId(prefix: IdPrefix, now: number = Date.now()): string {
  const random = now === last.time ? (last.random + 1n) % (1n << 80n) : BigInt(`0x${randomBytes(10).toString("hex")}`);
  last = { time: now, random };
  return `${prefix}_${base32(BigInt(now), 10)}${base32(random, 16)}`;
}

/**
 * Whether `value` is an id of this kind: one made by `newId`, or one in the shape the orchestrator
 * wrote before ids carried a prefix. Records made before keep their ids, since an id is written
 * into branch names, event subjects and addresses that a rewrite would leave pointing nowhere.
 */
export function isId(prefix: IdPrefix, value: string, older?: RegExp): boolean {
  return new RegExp(`^${prefix}_${BODY}$`).test(value) || (older?.test(value) ?? false);
}

/** The id shapes the orchestrator wrote before ids carried a prefix. */
export const OLDER_IDS = {
  uuid: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
  task: /^[a-f0-9]{12}$/,
  event: /^[0-9a-z]{9}[0-9a-f]{12}$|^[0-9a-z]{13}[0-9a-f]{8}$/,
};
