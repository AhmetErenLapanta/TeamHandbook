import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";

/**
 * scrypt with its parameters stored beside the hash, so a later cost increase reads the old
 * hashes it already has. N = 2^15 with r = 8 costs 32 MiB per check: the floor OWASP gives
 * for scrypt, and still a fraction of a second on one core.
 */
const N = 1 << 15;
const R = 8;
const P = 1;
const KEY_BYTES = 32;
const MAX_MEMORY = 128 * N * R * 2;

export const MIN_PASSWORD_LENGTH = 12;

function derive(password: string, salt: Buffer, n: number, r: number, p: number): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scrypt(password.normalize("NFKC"), salt, KEY_BYTES, { N: n, r, p, maxmem: Math.max(MAX_MEMORY, 128 * n * r * 2) }, (err, key) =>
      err ? reject(err) : resolve(key),
    ),
  );
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await derive(password, salt, N, R, P);
  return `scrypt$${N}$${R}$${P}$${salt.toString("base64")}$${key.toString("base64")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, n, r, p, salt, key] = stored.split("$");
  if (scheme !== "scrypt" || !n || !r || !p || !salt || !key) return false;
  const expected = Buffer.from(key, "base64");
  const actual = await derive(password, Buffer.from(salt, "base64"), Number(n), Number(r), Number(p));
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/**
 * A hash nobody's password matches, checked when the address is unknown, so a wrong address
 * takes as long to refuse as a wrong password and the timing does not say which accounts exist.
 */
let decoy: Promise<string> | null = null;
export function decoyHash(): Promise<string> {
  decoy ??= hashPassword(randomBytes(24).toString("base64"));
  return decoy;
}

export function passwordProblem(password: unknown): string | null {
  if (typeof password !== "string") return "a password is required";
  if (password.length < MIN_PASSWORD_LENGTH) return `a password needs at least ${MIN_PASSWORD_LENGTH} characters`;
  if (password.length > 1024) return "that password is too long";
  return null;
}
