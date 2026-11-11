import { createPrivateKey, generateKeyPairSync } from "node:crypto";
import type { KeyObject } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { signRunnerRequest } from "../server/runner-auth.js";
import { PROTOCOL_HEADER, RUNNER_PROTOCOL, SIGNATURE_HEADER } from "../shared/runner-wire.js";

/** What a machine keeps of its pairing with one organization: where it reaches it, who it is there, and its own key. */
export interface RunnerProfile {
  /** The address the pairing command printed, kept exactly: no call ever goes anywhere else. */
  address: string;
  org: string;
  machineId: string;
  token: string;
  /** PKCS#8 PEM of the machine's Ed25519 key; it never leaves this file. */
  privateKey: string;
}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

/** Why this machine will not send its credentials to an address, or null when it will: https, or plain http to this machine alone. */
export function addressProblem(address: string): string | null {
  let url: URL;
  try {
    url = new URL(address);
  } catch {
    return "that is not an address; copy the whole command from Settings";
  }
  if (url.username || url.password || url.search || url.hash) return "the address carries more than an orchestrator's address; copy the command from Settings again";
  if (url.protocol === "https:") return null;
  if (url.protocol === "http:" && LOOPBACK.has(url.hostname)) return null;
  return "this machine sends its credentials only over https (or to an orchestrator on this machine)";
}

/** The address as kept: without a trailing slash, so a path joins it once. */
export const cleanAddress = (address: string) => address.replace(/\/+$/, "");

/**
 * Where this machine keeps what belongs to one organization: its pairing and the agents it runs
 * for it. Apart from the local orchestrator's own runner (`runnerDir(dataDir)/local`), so neither
 * one's start ends what the other runs, and an organization's name never meets a file of the runner's.
 */
/** An organization's short name as an orchestrator gives it: no separator, no dot, so it names one folder and nothing above it. */
export const ORG_NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;

export function orgDir(dataDir: string, org: string): string {
  if (!ORG_NAME.test(org)) throw new Error(`the orchestrator named an organization this machine cannot keep a file for: ${JSON.stringify(org)}`);
  return join(runnerDir(dataDir), "machines", org);
}

export const runnerDir = (dataDir: string) => join(dataDir, "runner");

export function profileFile(dataDir: string, org: string): string {
  return join(orgDir(dataDir, org), "profile.json");
}

/** The organizations this machine keeps a pairing for. */
export function connectedOrgs(dataDir: string): string[] {
  try {
    return readdirSync(join(runnerDir(dataDir), "machines")).filter((org) => existsSync(profileFile(dataDir, org)));
  } catch {
    return [];
  }
}

export function saveProfile(dataDir: string, profile: RunnerProfile): string {
  const file = profileFile(dataDir, profile.org);
  for (const dir of [runnerDir(dataDir), join(runnerDir(dataDir), "machines"), orgDir(dataDir, profile.org)]) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
  }
  const next = `${file}.next`;
  writeFileSync(next, JSON.stringify(profile, null, 2) + "\n", { mode: 0o600 });
  chmodSync(next, 0o600);
  renameSync(next, file);
  return file;
}

export function readProfile(dataDir: string, org: string): RunnerProfile | null {
  const file = profileFile(dataDir, org);
  if (!existsSync(file)) return null;
  const value = JSON.parse(readFileSync(file, "utf8")) as Partial<RunnerProfile>;
  const fields = ["address", "org", "machineId", "token", "privateKey"] as const;
  return fields.every((f) => typeof value[f] === "string") ? (value as RunnerProfile) : null;
}

export function removeProfile(dataDir: string, org: string): boolean {
  if (!existsSync(profileFile(dataDir, org))) return false;
  rmSync(orgDir(dataDir, org), { recursive: true, force: true });
  return true;
}

/** A key made on this machine for one pairing: the private half for its file, the public half as the orchestrator takes it. */
export function machineKey(): { privateKey: string; publicKey: string } {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const raw = publicKey.export({ format: "der", type: "spki" }).subarray(-32);
  return { privateKey: privateKey.export({ format: "pem", type: "pkcs8" }).toString(), publicKey: Buffer.from(raw).toString("base64url") };
}

export type Fetch = typeof fetch;

/**
 * Where a runner call goes: an address that names its organization (`/api/orgs/<org>`, as Settings
 * prints on an orchestrator of several) is that organization's `/api`, so the call's own `/api` is
 * not said twice. The path signed is the call's own either way.
 */
export function runnerUrl(address: string, path: string): string {
  return /\/api\/orgs\/[^/]+$/.test(new URL(address).pathname) ? `${address}${path.replace(/^\/api/, "")}` : `${address}${path}`;
}

/**
 * One call of this machine to its orchestrator: the token names the machine, the signature over
 * method, path, time, nonce and body proves it still holds its key. The path signed is the one
 * under the organization; redirects are refused, so the token never follows one elsewhere.
 */
export function signedCall(profile: RunnerProfile, method: "GET" | "POST", path: string, body: unknown, fetchImpl: Fetch = fetch, signal?: AbortSignal): Promise<Response> {
  const text = body === undefined ? "" : JSON.stringify(body);
  const key: KeyObject = createPrivateKey(profile.privateKey);
  return fetchImpl(runnerUrl(profile.address, path), {
    method,
    redirect: "error",
    headers: {
      authorization: `Bearer ${profile.token}`,
      [SIGNATURE_HEADER]: signRunnerRequest(key, { method, path, body: text }),
      [PROTOCOL_HEADER]: String(RUNNER_PROTOCOL),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: text }),
    ...(signal ? { signal } : {}),
  });
}
