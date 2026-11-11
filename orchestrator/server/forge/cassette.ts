import { readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { IncomingMessage, Server } from "node:http";
import type { AddressInfo } from "node:net";
import { detectSecret } from "../plugin.js";

/**
 * A forge's answers to one conversation, kept so a test plays them back without the forge:
 * every request as the orchestrator sent it and the answer it got, in order. The conversation is
 * recorded through a proxy in front of the forge, and what a forge sends back about the
 * caller - the token, cookies, rate-limit and request-id headers - is not kept.
 */
export interface Cassette {
  name: string;
  interactions: { request: { method: string; path: string; body: unknown }; response: { status: number; contentType: string | null; body: unknown } }[];
}

export class CassetteRefused extends Error {}

const readBody = (req: IncomingMessage): Promise<string> =>
  new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => resolve(raw));
    req.on("error", reject);
  });

const parsed = (raw: string): unknown => {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
};

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

const close = (server: Server) => new Promise<void>((resolve) => server.close(() => resolve()));

/**
 * A proxy that forwards every request to `target` and records the conversation. Only the
 * caller's own headers that say what is sent travel on with it: the credential header the
 * orchestrator adds is passed to the forge and never written down.
 */
export async function recordingProxy(name: string, target: string): Promise<{ url: string; cassette: Cassette; stop: () => Promise<void> }> {
  const cassette: Cassette = { name, interactions: [] };
  const base = target.replace(/\/+$/, "");
  const server = createServer((req, res) => {
    void (async () => {
      const raw = await readBody(req);
      const headers: Record<string, string> = {};
      for (const key of ["authorization", "private-token", "content-type", "accept"]) {
        const value = req.headers[key];
        if (typeof value === "string") headers[key] = value;
      }
      const answer = await fetch(`${base}${req.url}`, { method: req.method, headers, body: raw || undefined, redirect: "manual" });
      const text = await answer.text();
      const contentType = answer.headers.get("content-type");
      cassette.interactions.push({ request: { method: req.method!, path: req.url!, body: parsed(raw) }, response: { status: answer.status, contentType, body: parsed(text) } });
      res.statusCode = answer.status;
      if (contentType) res.setHeader("content-type", contentType);
      res.end(text);
    })().catch((err: Error) => {
      res.statusCode = 502;
      res.end(err.message);
    });
  });
  const url = await listen(server);
  return { url, cassette, stop: () => close(server) };
}

/**
 * Writes a cassette, or refuses to: one that carries a value that looks like a secret, or any
 * of the `tokens` the recording ran with, is never put on disk. A forge echoes a token back in
 * more places than a header, and a cassette is a file that gets committed.
 */
export function writeCassette(file: string, cassette: Cassette, tokens: readonly string[] = []): void {
  const text = JSON.stringify(cassette, null, 2) + "\n";
  const leaked = tokens.filter((t) => t && text.includes(t)).length;
  if (leaked) throw new CassetteRefused(`the cassette ${cassette.name} holds the token it was recorded with; it is not written`);
  const secret = detectSecret(text);
  if (secret) throw new CassetteRefused(`the cassette ${cassette.name} holds what looks like a ${secret}; it is not written`);
  writeFileSync(file, text);
}

export function readCassette(file: string): Cassette {
  return JSON.parse(readFileSync(file, "utf8")) as Cassette;
}

/**
 * A forge that answers from a cassette. Each recorded answer is given once, to the first request
 * that matches it by method, path and body, so lookups the client sends side by side are answered
 * in whatever order they arrive. A request nothing recorded matches is answered 599 and named in
 * `misses`, so a test sees the conversation changed rather than a forge that answered something else.
 */
export async function replayServer(cassette: Cassette): Promise<{ url: string; misses: string[]; left: () => number; stop: () => Promise<void> }> {
  const queue = [...cassette.interactions];
  const misses: string[] = [];
  const server = createServer((req, res) => {
    void readBody(req).then((raw) => {
      const body = JSON.stringify(parsed(raw));
      const at = queue.findIndex((i) => i.request.method === req.method && i.request.path === req.url && JSON.stringify(i.request.body) === body);
      if (at < 0) {
        misses.push(`${req.method} ${req.url}`);
        res.statusCode = 599;
        res.end();
        return;
      }
      const [next] = queue.splice(at, 1);
      res.statusCode = next!.response.status;
      if (next!.response.contentType) res.setHeader("content-type", next!.response.contentType);
      res.end(typeof next!.response.body === "string" ? next!.response.body : next!.response.body === null ? "" : JSON.stringify(next!.response.body));
    });
  });
  const url = await listen(server);
  return { url, misses, left: () => queue.length, stop: () => close(server) };
}
