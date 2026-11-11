import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

/** The stand-ins started by a test file; it closes them after each test with `closeStandIns`. */
const standIns: Server[] = [];

export async function closeStandIns(): Promise<void> {
  await Promise.all(standIns.splice(0).map((s) => new Promise((resolve) => s.close(resolve))));
}

/**
 * An MCP server on this machine that signs people in the way the MCP authorization spec says:
 * protected resource metadata, an authorization server with client registration, PKCE, and an
 * MCP endpoint that answers only the access token it issued last.
 */
/** The tools the stand-in lists unless a test names its own: a reading one, a writing one, and two whose marks and names disagree. */
const TOOLS = [{ name: "get_ticket", description: "Reads a ticket" }, { name: "close_ticket", description: "Closes a ticket" }, { name: "ticket_summary", description: "Sums up a ticket", annotations: { readOnlyHint: true } }, { name: "getAndArchive", description: "Reads and archives", annotations: { readOnlyHint: true, destructiveHint: true } }];

export async function signedInServer(options: { expiresIn?: number; refuseRefresh?: boolean; issue?: { summary: string; status: string; description?: string; comments?: { author: string; created: string; body: string }[] } | "fails"; tools?: { name: string; description: string; annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean } }[]; path?: string } = {}) {
  // Where the MCP endpoint is served: /mcp, or a service's own path such as GitLab's /api/v4/mcp.
  const mcp = options.path ?? "/mcp";
  const state = { issued: 0, access: "", refresh: "", challenge: "", clientId: "", calls: [] as string[] };
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      const url = new URL(req.url!, base);
      state.calls.push(`${req.method} ${url.pathname}`);
      const json = (status: number, body: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      };
      if (url.pathname === `/.well-known/oauth-protected-resource${mcp}`) return json(200, { resource: `${base}${mcp}`, authorization_servers: [base] });
      if (url.pathname === "/.well-known/oauth-authorization-server") {
        return json(200, { issuer: base, authorization_endpoint: `${base}/authorize`, token_endpoint: `${base}/token`, registration_endpoint: `${base}/register`, code_challenge_methods_supported: ["S256"] });
      }
      if (url.pathname === "/register") {
        state.clientId = `client-${randomBytes(4).toString("hex")}`;
        return json(201, { client_id: state.clientId });
      }
      if (url.pathname === "/authorize") {
        state.challenge = url.searchParams.get("code_challenge") ?? "";
        const back = new URL(url.searchParams.get("redirect_uri")!);
        back.searchParams.set("code", "code-1");
        back.searchParams.set("state", url.searchParams.get("state")!);
        res.writeHead(302, { location: back.toString() });
        return res.end();
      }
      if (url.pathname === "/token") {
        const form = new URLSearchParams(raw);
        const issue = () => {
          state.issued++;
          state.access = `access-${state.issued}-${randomBytes(6).toString("hex")}`;
          state.refresh = `refresh-${state.issued}`;
          return json(200, { access_token: state.access, refresh_token: state.refresh, token_type: "Bearer", expires_in: options.expiresIn ?? 3600 });
        };
        // A client it did not register, or has forgotten, is refused as a server forgets one.
        if (form.get("client_id") !== state.clientId) return json(401, { error: "invalid_client" });
        if (form.get("grant_type") === "authorization_code") {
          const verified = createHash("sha256").update(form.get("code_verifier") ?? "").digest("base64url") === state.challenge;
          if (form.get("code") !== "code-1" || !verified) return json(400, { error: "invalid_grant" });
          return issue();
        }
        if (form.get("grant_type") === "refresh_token") {
          if (options.refuseRefresh || form.get("refresh_token") !== state.refresh) return json(400, { error: "invalid_grant" });
          return issue();
        }
        return json(400, { error: "unsupported_grant_type" });
      }
      if (url.pathname === mcp) {
        if (req.headers.authorization !== `Bearer ${state.access}` || !state.access) return json(401, { error: "sign in" });
        const message = JSON.parse(raw);
        if (message.id === undefined) return res.writeHead(202).end();
        if (message.method === "initialize") return json(200, { jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "tickets", version: "1" } } });
        if (message.method === "tools/list") return json(200, { jsonrpc: "2.0", id: message.id, result: { tools: options.tools ?? TOOLS } });
        // Atlassian's reading tools, for a server that stands in for theirs: the sites an account reaches, then one issue.
        if (message.method === "tools/call") {
          state.calls.push(`tools/call ${message.params.name}`);
          const text = (value: unknown) => json(200, { jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: JSON.stringify(value) }] } });
          if (message.params.name === "getAccessibleAtlassianResources") return text([{ id: "cloud-1", url: "https://acme.atlassian.example", name: "acme" }]);
          if (message.params.name === "getJiraIssue" && options.issue && options.issue !== "fails") return text({ key: message.params.arguments.issueIdOrKey, fields: { summary: options.issue.summary, status: { name: options.issue.status }, ...(options.issue.description === undefined ? {} : { description: options.issue.description }), ...(options.issue.comments ? { comment: { comments: options.issue.comments.map((c) => ({ author: { displayName: c.author }, created: c.created, body: c.body })) } } : {}) } });
          return json(200, { jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: "no such issue" }], isError: true } });
        }
      }
      json(404, {});
    });
  });
  standIns.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { base, state };
}

