import { createHash, randomBytes } from "node:crypto";
import { appendFileSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { JiraIssue } from "./jira.js";

/**
 * A stand-in remote MCP server that signs people in with OAuth, the way the MCP authorization
 * spec has a client find and use it: a 401 naming its protected-resource metadata, an
 * authorization server with dynamic client registration, PKCE and refresh tokens that expire
 * quickly, and a consent page listing the lab's people. Its tools read the lab's issues; one of
 * them writes, and every call it gets is recorded with whose token made it, for a test to read
 * at `/lab/calls`. No real service is reached.
 */

export interface McpOauthConfig {
  port: number;
  /** Whom the consent page lets sign in. */
  people: string[];
  issues: JiraIssue[];
  /** Seconds an access token lasts: short, so a run sees a refresh. */
  accessSeconds: number;
  log: string;
}

interface Client {
  id: string;
  redirects: string[];
}

interface Grant {
  client: string;
  redirect: string;
  challenge: string;
  person: string;
  expires: number;
}

export interface McpCall {
  at: string;
  person: string;
  tool: string;
  args: Record<string, unknown>;
}

const PROTOCOL = "2025-06-18";
const escape = (text: string) => text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export function startMcpOauth(config: McpOauthConfig): Promise<void> {
  const base = `http://127.0.0.1:${config.port}`;
  const clients = new Map<string, Client>();
  const grants = new Map<string, Grant>();
  const access = new Map<string, { person: string; expires: number }>();
  const refresh = new Map<string, { person: string; client: string }>();
  const calls: McpCall[] = [];
  const issuedRefresh: string[] = [];

  const json = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
    res.writeHead(status, { "content-type": "application/json", ...headers });
    res.end(JSON.stringify(body));
  };

  const issue = (key: unknown) => config.issues.find((i) => i.key === key);
  const tools = [
    { name: "getIssue", description: "Read one issue: its summary, description, subtasks and comments.", inputSchema: { type: "object", properties: { key: { type: "string" } }, required: ["key"] } },
    { name: "searchIssues", description: "Find issues whose summary holds the words given.", inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } },
    { name: "addComment", description: "Write a comment on an issue.", inputSchema: { type: "object", properties: { key: { type: "string" }, body: { type: "string" } }, required: ["key", "body"] } },
  ];

  const callTool = (person: string, name: string, args: Record<string, unknown>) => {
    calls.push({ at: new Date().toISOString(), person, tool: name, args });
    appendFileSync(config.log, `${new Date().toISOString()} tool ${name} by ${person}${name === "addComment" ? " WRITE" : ""}\n`);
    if (name === "getIssue") {
      const found = issue(args.key);
      if (!found) return { isError: true, content: [{ type: "text", text: `no issue ${String(args.key)}` }] };
      return { content: [{ type: "text", text: `${found.key}: ${found.summary}\n\n${found.description}\n\nSubtasks: ${found.subtasks.map((s) => `${s.key} ${s.summary}`).join("; ") || "none"}` }] };
    }
    if (name === "searchIssues") {
      const words = String(args.query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
      const found = config.issues.filter((i) => words.every((w) => i.summary.toLowerCase().includes(w)));
      return { content: [{ type: "text", text: found.map((i) => `${i.key} ${i.summary}`).join("\n") || "no issues" }] };
    }
    if (name === "addComment") return { content: [{ type: "text", text: `commented on ${String(args.key)}` }] };
    return { isError: true, content: [{ type: "text", text: `no tool ${name}` }] };
  };

  const mcp = (req: IncomingMessage, res: ServerResponse, raw: string) => {
    const bearer = /^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1];
    const token = bearer ? access.get(bearer) : undefined;
    if (!token || token.expires < Date.now()) {
      return json(res, 401, { error: "invalid_token" }, { "www-authenticate": `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource"` });
    }
    let message: { id?: unknown; method?: string; params?: Record<string, unknown> };
    try {
      message = JSON.parse(raw) as typeof message;
    } catch {
      return json(res, 400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
    }
    if (message.id === undefined) {
      res.writeHead(202);
      res.end();
      return;
    }
    const reply = (result: unknown) => json(res, 200, { jsonrpc: "2.0", id: message.id, result });
    if (message.method === "initialize") return reply({ protocolVersion: PROTOCOL, capabilities: { tools: {} }, serverInfo: { name: "lab-tracker", version: "1.0.0" } });
    if (message.method === "tools/list") return reply({ tools });
    if (message.method === "tools/call") return reply(callTool(token.person, String(message.params?.name ?? ""), (message.params?.arguments ?? {}) as Record<string, unknown>));
    if (message.method === "ping") return reply({});
    return json(res, 200, { jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Method not found" } });
  };

  const issueTokens = (res: ServerResponse, person: string, client: string) => {
    const accessToken = randomBytes(24).toString("base64url");
    const refreshToken = randomBytes(24).toString("base64url");
    access.set(accessToken, { person, expires: Date.now() + config.accessSeconds * 1000 });
    refresh.set(refreshToken, { person, client });
    issuedRefresh.push(refreshToken);
    appendFileSync(config.log, `${new Date().toISOString()} token for ${person}\n`);
    json(res, 200, { token_type: "Bearer", access_token: accessToken, refresh_token: refreshToken, expires_in: config.accessSeconds, scope: "tracker" });
  };

  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      const url = new URL(req.url ?? "/", base);
      const method = req.method ?? "GET";
      appendFileSync(config.log, `${new Date().toISOString()} ${method} ${url.pathname}\n`);
      if (url.pathname === "/health") return json(res, 200, { ok: true });
      if (url.pathname === "/lab/calls") return json(res, 200, { calls });
      // Every token it handed out, for a test to look for where none belongs: an answer, a log, a request.
      if (url.pathname === "/lab/tokens") return json(res, 200, { tokens: [...access.keys(), ...issuedRefresh] });
      if (url.pathname === "/mcp") return mcp(req, res, raw);
      if (url.pathname === "/.well-known/oauth-protected-resource" || url.pathname === "/.well-known/oauth-protected-resource/mcp") {
        return json(res, 200, { resource: `${base}/mcp`, authorization_servers: [base], bearer_methods_supported: ["header"] });
      }
      if (url.pathname === "/.well-known/oauth-authorization-server") {
        return json(res, 200, {
          issuer: base,
          authorization_endpoint: `${base}/authorize`,
          token_endpoint: `${base}/token`,
          registration_endpoint: `${base}/register`,
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code", "refresh_token"],
          code_challenge_methods_supported: ["S256"],
          token_endpoint_auth_methods_supported: ["none"],
        });
      }
      if (url.pathname === "/register" && method === "POST") {
        let body: { redirect_uris?: unknown } = {};
        try {
          body = JSON.parse(raw) as typeof body;
        } catch {
          return json(res, 400, { error: "invalid_client_metadata" });
        }
        const redirects = Array.isArray(body.redirect_uris) ? body.redirect_uris.filter((u): u is string => typeof u === "string") : [];
        if (!redirects.length) return json(res, 400, { error: "invalid_redirect_uri" });
        const client = { id: randomBytes(12).toString("hex"), redirects };
        clients.set(client.id, client);
        return json(res, 201, { client_id: client.id, redirect_uris: redirects, token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] });
      }
      if (url.pathname === "/authorize") {
        const form = new URLSearchParams(raw);
        const params = method === "POST" ? form : url.searchParams;
        const client = clients.get(params.get("client_id") ?? "");
        const redirect = params.get("redirect_uri") ?? "";
        if (!client || !client.redirects.includes(redirect)) return json(res, 400, { error: "invalid_client" });
        if (params.get("code_challenge_method") !== "S256" || !params.get("code_challenge")) return json(res, 400, { error: "invalid_request" });
        const person = method === "POST" ? params.get("person") : null;
        if (!person || !config.people.includes(person)) {
          const hidden = ["client_id", "redirect_uri", "response_type", "scope", "state", "code_challenge", "code_challenge_method", "resource"]
            .map((n) => `<input type="hidden" name="${n}" value="${escape(params.get(n) ?? "")}">`)
            .join("");
          const choices = config.people.map((p) => `<button type="submit" name="person" value="${escape(p)}">Allow as ${escape(p)}</button>`).join("");
          res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
          res.end(`<!doctype html><title>Lab tracker sign-in</title><h1>Allow access to the lab tracker</h1><form method="post" action="/authorize">${hidden}${choices}</form>`);
          return;
        }
        const code = randomBytes(24).toString("base64url");
        grants.set(code, { client: client.id, redirect, challenge: params.get("code_challenge")!, person, expires: Date.now() + 60_000 });
        const back = new URL(redirect);
        back.searchParams.set("code", code);
        if (params.get("state")) back.searchParams.set("state", params.get("state")!);
        res.writeHead(302, { location: back.toString() });
        res.end();
        return;
      }
      if (url.pathname === "/token" && method === "POST") {
        const form = new URLSearchParams(raw);
        if (form.get("grant_type") === "authorization_code") {
          const grant = grants.get(form.get("code") ?? "");
          grants.delete(form.get("code") ?? "");
          const challenge = createHash("sha256").update(form.get("code_verifier") ?? "").digest("base64url");
          if (!grant || grant.client !== form.get("client_id") || grant.redirect !== form.get("redirect_uri") || grant.expires < Date.now() || grant.challenge !== challenge) {
            return json(res, 400, { error: "invalid_grant" });
          }
          return issueTokens(res, grant.person, grant.client);
        }
        if (form.get("grant_type") === "refresh_token") {
          const held = refresh.get(form.get("refresh_token") ?? "");
          refresh.delete(form.get("refresh_token") ?? "");
          if (!held || held.client !== form.get("client_id")) return json(res, 400, { error: "invalid_grant" });
          return issueTokens(res, held.person, held.client);
        }
        return json(res, 400, { error: "unsupported_grant_type" });
      }
      json(res, 404, { error: "not_found" });
    });
  });
  return new Promise((resolve) => server.listen(config.port, "127.0.0.1", () => resolve()));
}

/** Run as `lab.mjs mcp-oauth <config.json>`: the stand-in lives until down.sh stops it. */
export async function mcpOauthMain(file: string): Promise<void> {
  const config = JSON.parse(readFileSync(file, "utf8")) as McpOauthConfig;
  await startMcpOauth(config);
  appendFileSync(config.log, `mcp server listening on 127.0.0.1:${config.port}\n`);
}
