import { createHash, createPublicKey, randomBytes, sign, verify } from "node:crypto";
import type { KeyObject } from "node:crypto";

/**
 * How a person's machine proves itself to the orchestrator. It pairs once with a short code the
 * person reads off Settings, sending the public half of an Ed25519 key it made and kept; from then
 * on every call carries the machine's token and a signature over the call, made with that key.
 * A token copied off the machine is not enough without the key, and a signed call replayed later,
 * or to another path, fails: the signature covers the method, the path, the time, a nonce the
 * orchestrator takes once, and the body's hash. The CLI signs with signRunnerRequest, so both ends
 * build the one canonical string.
 */
export const RUNNER_PROTOCOL = 1;
export const RUNNER_TOKEN_PREFIX = "hr_";
export const SIGNATURE_HEADER = "x-runner-signature";
/** The most a call's time stands from the orchestrator's, and how long its nonce is kept. */
export const SKEW_SECONDS = 300;
export const PAIRING_MINUTES = 5;

// Crockford's base32 in upper case: no I, L, O or U for a person to misread off a screen.
const CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const CODE_LENGTH = 12;

/** A pairing code as it is shown, XXXX-XXXX-XXXX: 60 bits, good for five minutes and one claim. */
export function pairingCode(): string {
  const bytes = randomBytes(CODE_LENGTH);
  const raw = [...bytes].map((b) => CODE_ALPHABET[b & 31]).join("");
  return `${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8)}`;
}

/** A code as typed, read the way it was shown: dashes, spaces and case do not matter; anything else is no code. */
export function cleanPairingCode(input: unknown): string | null {
  const raw = typeof input === "string" ? input.replace(/[\s-]/g, "").toUpperCase() : "";
  return raw.length === CODE_LENGTH && [...raw].every((ch) => CODE_ALPHABET.includes(ch)) ? raw : null;
}

export const codeHash = (code: string) => createHash("sha256").update(code).digest("hex");

/** A machine's token, shown to it once at its claim; the orchestrator keeps its hash. */
export function runnerToken(): string {
  return `${RUNNER_TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
}

export interface SignedCall {
  method: string;
  /** The path with its query, as the request line carries it. */
  path: string;
  body: string | Uint8Array;
  /** Seconds since the epoch. */
  time: number;
  nonce: string;
}

function canonical(call: SignedCall): Buffer {
  const body = createHash("sha256").update(call.body).digest("hex");
  return Buffer.from(["v1", call.method.toUpperCase(), call.path, String(call.time), call.nonce, body].join("\n"));
}

/** The signature header a machine sends with a call, made with its private key. */
export function signRunnerRequest(privateKey: KeyObject, call: Omit<SignedCall, "time" | "nonce"> & { time?: number; nonce?: string }): string {
  const signed: SignedCall = { ...call, time: call.time ?? Math.floor(Date.now() / 1000), nonce: call.nonce ?? randomBytes(16).toString("base64url") };
  return `v1 t=${signed.time} n=${signed.nonce} s=${sign(null, canonical(signed), privateKey).toString("base64url")}`;
}

// An Ed25519 public key's DER prefix: the 32 raw bytes a machine sends follow it.
const ED25519_SPKI = Buffer.from("302a300506032b6570032100", "hex");

/** A machine's public key as it sends it, base64url of the 32 raw bytes, or null for anything else. */
export function publicKeyOf(raw: unknown): KeyObject | null {
  if (typeof raw !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(raw)) return null;
  const bytes = Buffer.from(raw, "base64url");
  if (bytes.length !== 32) return null;
  try {
    return createPublicKey({ key: Buffer.concat([ED25519_SPKI, bytes]), format: "der", type: "spki" });
  } catch {
    return null;
  }
}

/**
 * The nonce of a call whose signature this key made over this very call within the allowed skew,
 * or null. Taking the nonce, so the same call is not accepted twice, is the caller's next step.
 */
export function checkRunnerSignature(publicKey: KeyObject, header: string | undefined, call: Omit<SignedCall, "time" | "nonce">, now = Date.now()): string | null {
  const parts = /^v1 t=(\d{1,12}) n=([A-Za-z0-9_-]{16,64}) s=([A-Za-z0-9_-]{86})$/.exec(header ?? "");
  if (!parts) return null;
  const time = Number(parts[1]);
  if (Math.abs(now / 1000 - time) > SKEW_SECONDS) return null;
  const nonce = parts[2]!;
  return verify(null, canonical({ ...call, time, nonce }), publicKey, Buffer.from(parts[3]!, "base64url")) ? nonce : null;
}
