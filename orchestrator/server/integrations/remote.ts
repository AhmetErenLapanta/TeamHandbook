import { isIP } from "node:net";
import { ChangeRefused } from "../changes.js";

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** An address on this machine or a private network, by its literal host: what a member's URL must not make the orchestrator call. */
function internal(host: string): boolean {
  const bare = host.replace(/^\[|\]$/g, "").toLowerCase();
  if (LOOPBACK.has(host) || bare === "::1" || bare.endsWith(".localhost") || bare === "0.0.0.0") return true;
  if (isIP(bare) === 4) {
    const [a, b] = bare.split(".").map(Number) as [number, number];
    return a === 10 || a === 127 || a === 0 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127);
  }
  if (isIP(bare) === 6) return /^(fc|fd|fe80)/.test(bare) || bare.startsWith("::ffff:");
  return false;
}

/**
 * An address the orchestrator calls on a person's behalf - their own MCP server and the sign-in
 * service it names. Anyone signed in can add one, so the orchestrator does not let it point back at
 * itself or into the network it runs in: https to a public host only. `local` lets an orchestrator
 * whose operator asked for it reach this machine over http, for the lab's stand-ins.
 */
export function remoteUrl(raw: unknown, what: string, local = false): URL {
  let url: URL;
  try {
    url = new URL(String(raw ?? "").trim());
  } catch {
    throw new ChangeRefused(`${what} is not a URL`);
  }
  if (url.username || url.password) throw new ChangeRefused(`${what} carries no user name or password`);
  if (local && LOOPBACK.has(url.hostname) && (url.protocol === "http:" || url.protocol === "https:")) return url;
  if (url.protocol !== "https:") throw new ChangeRefused(`${what} has to be https`);
  if (internal(url.hostname)) throw new ChangeRefused(`${what} points at this machine or a private network, which the orchestrator does not call for anyone`);
  return url;
}
