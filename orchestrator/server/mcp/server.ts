import { Hono } from "hono";
import type { Context } from "hono";
import type { OrchestratorContext } from "../app.js";
import { syncError } from "../app.js";
import type { Principal } from "../auth.js";
import { clientFrom } from "../accounts.js";
import { auditRequired, NoEventLog } from "../integrations/audit.js";
import { limitKeyCall, noteLimited, rateLimiter, tooMany, windowLimiter } from "../limits.js";
import { MCP_PATH } from "../integrations/orchestrator-mcp.js";
import { callSummary, refusalText, toolsFor } from "./tools.js";

/**
 * How often one caller is answered, per minute, beyond the budget every key spends through the
 * orchestrator's one key gate: the calls that open a request or start a task apart, since a leaked key
 * retrying those spends forge and model budget; and any client, signed in or not, so a flood of
 * made-up keys meets a limit before any is looked up.
 */
export const MCP_LIMITS = { writesPerCredential: 10, perClient: 300 };

/** The protocol revisions this server speaks, newest first; a client asking for another is offered the newest. */
export const PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26"];
export const SERVER_INFO = { name: "teamhandbook-orchestrator", title: "TeamHandbook Orchestrator", version: "1.0.0" };
/** A call carries arguments, not files; a larger body is refused before it is read as JSON. */
export const MAX_BODY_BYTES = 1_000_000;

const REPO_ID = /^[a-z0-9][a-z0-9-]{0,62}$/;
const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;
/** A server-defined error code, in the range JSON-RPC leaves to servers. */
const TOO_MANY = -32029;

/** What a caller is counted under: the key or token it came with, so two keys of one person count apart. */
const credentialOf = (user: Principal) => user.key?.id ?? user.id;

type Id = string | number;
interface Message {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: unknown;
}

function result(id: Id, value: unknown) {
  return { jsonrpc: "2.0", id, result: value };
}

function failure(id: Id | null, code: number, message: string) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

/** A refusal that also tells an MCP client where to sign in: the orchestrator's own authorization server, found from the resource's metadata. */
function unauthorized(c: Context, error: string, publicUrl?: string) {
  const metadata = publicUrl ? `, resource_metadata="${publicUrl.replace(/\/+$/, "")}/.well-known/oauth-protected-resource${MCP_PATH}"` : "";
  c.header("WWW-Authenticate", `Bearer realm="TeamHandbook Orchestrator"${metadata}`);
  return c.json({ error }, 401);
}

/**
 * The person or service account a call comes from, by the API key it carries and nothing else.
 * A session cookie is never read here: a browser attaches one to any site's request, and this
 * endpoint takes no CSRF token, so a cookie accepted here would let any page act as whoever had
 * the orchestrator open. An orchestrator started for a demo has no keys, and lets nobody in.
 */
async function caller(ctx: OrchestratorContext, c: Context): Promise<Principal | Response> {
  if (!ctx.apiKeys) return unauthorized(c, "API keys are not set up on this orchestrator, so its MCP server lets nobody in", ctx.publicUrl);
  const header = (c.req.header("authorization") ?? "").trim();
  const match = /^(?:Bearer\s+)?(\S+)$/i.exec(header);
  if (!match) return unauthorized(c, "sign in through the orchestrator's authorization server, or send an API key as Authorization: Bearer <key>", ctx.publicUrl);
  const user = await ctx.apiKeys.resolve(match[1]!);
  return user ?? unauthorized(c, "that key or token is not valid; it was revoked, expired or never issued", ctx.publicUrl);
}

/**
 * Whether a browser page may have sent this. A page re-resolving its own name to this machine
 * (DNS rebinding) sends its own Origin, so only the orchestrator's public address is taken; MCP
 * clients outside a browser send none.
 */
function originRefused(ctx: OrchestratorContext, origin: string | undefined): boolean {
  if (origin === undefined) return false;
  if (!ctx.publicUrl) return true;
  try {
    return new URL(ctx.publicUrl).origin !== origin;
  } catch {
    return true;
  }
}

async function answer(ctx: OrchestratorContext, user: Principal, message: Message, id: Id, writes: (key: string) => boolean): Promise<object> {
  const params = (message.params && typeof message.params === "object" && !Array.isArray(message.params) ? message.params : {}) as Record<string, unknown>;
  switch (message.method) {
    case "initialize": {
      const asked = typeof params.protocolVersion === "string" ? params.protocolVersion : "";
      return result(id, {
        protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions:
          "The TeamHandbook Orchestrator: team repositories, the requests waiting in them, and agent tasks. Every change opens a request a person reviews and merges; no tool merges. Before propose_change, call preview_change and have the person confirm the commit message.",
      });
    }
    case "ping":
      return result(id, {});
    case "tools/list": {
      const tools = await toolsFor(ctx, user);
      return result(id, { tools: tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })) });
    }
    case "tools/call": {
      const name = typeof params.name === "string" ? params.name : "";
      const args = (params.arguments && typeof params.arguments === "object" && !Array.isArray(params.arguments) ? params.arguments : {}) as Record<string, unknown>;
      const tool = (await toolsFor(ctx, user)).find((t) => t.name === name);
      if (!tool) return failure(id, INVALID_PARAMS, `no tool named ${JSON.stringify(name.slice(0, 64))} is offered to you`);
      if (tool.writes && !writes(credentialOf(user))) return failure(id, TOO_MANY, `at most ${MCP_LIMITS.writesPerCredential} changes and task starts a minute; wait and try again`);
      // Written before the tool runs: a call the log did not take is not made.
      try {
        await auditRequired(ctx, user, "mcp.call", { repoId: typeof args.repo === "string" && REPO_ID.test(args.repo) ? args.repo : null, subject: `tool:${name}`, detail: callSummary(name, args) });
      } catch (err) {
        return failure(id, INTERNAL_ERROR, err instanceof NoEventLog ? err.message : "the event log did not take this call, so it was not made");
      }
      try {
        const value = await tool.run(args, ctx, user);
        return result(id, { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] });
      } catch (err) {
        const refused = refusalText(err);
        if (refused === null) console.error(err);
        return result(id, { content: [{ type: "text", text: refused ?? `the orchestrator failed to do this: ${syncError(err)}` }], isError: true });
      }
    }
    default:
      return failure(id, METHOD_NOT_FOUND, `this server does not answer ${JSON.stringify(String(message.method).slice(0, 64))}`);
  }
}

/**
 * The orchestrator's MCP server, over Streamable HTTP: one POST per JSON-RPC message, answered with
 * JSON. It keeps no session and opens no event stream, since every tool answers at once. It sits
 * outside the browser's sign-in on purpose; who calls is decided by the API key alone.
 */
export function mcpRoutes(ctx: OrchestratorContext): Hono {
  const app = new Hono();
  const from = clientFrom(ctx.trustedProxies ?? []);
  const perClient = windowLimiter(MCP_LIMITS.perClient);
  const writes = rateLimiter(MCP_LIMITS.writesPerCredential);

  app.on(["GET", "DELETE"], MCP_PATH, (c) => {
    c.header("Allow", "POST");
    return c.json({ error: "this MCP server answers POST only; it keeps no session and opens no event stream" }, 405);
  });

  app.post(MCP_PATH, async (c) => {
    if (originRefused(ctx, c.req.header("origin"))) return c.json({ error: "this MCP server does not answer pages of another site" }, 403);
    const client = perClient(from(c));
    if (!client.ok) return tooMany(c, client, "too many calls from this address; wait and try again");
    const user = await caller(ctx, c);
    if (user instanceof Response) return user;
    // The one budget a key spends wherever it calls, the REST API's and this server's together.
    const keyId = credentialOf(user);
    const verdict = limitKeyCall({ tenant: ctx.tenant, keyId, owner: user.key?.owner ?? { kind: "user", id: user.id } });
    if (!verdict.ok) {
      await noteLimited(ctx, user, keyId, verdict.limit ?? "key").catch((err: Error) => console.error(`mcp: the event log did not take a rate limit: ${err.message}`));
      return tooMany(c, verdict, `this ${verdict.limit === "account" ? "account's keys have" : "key has"} made too many calls this minute; wait and try again`);
    }
    const version = c.req.header("mcp-protocol-version");
    if (version !== undefined && !PROTOCOL_VERSIONS.includes(version)) return c.json({ error: `this server speaks MCP ${PROTOCOL_VERSIONS.join(", ")}` }, 400);
    if (!(c.req.header("content-type") ?? "").toLowerCase().startsWith("application/json")) return c.json({ error: "send JSON-RPC as application/json" }, 415);
    const text = await c.req.text();
    if (Buffer.byteLength(text) > MAX_BODY_BYTES) return c.json(failure(null, INVALID_REQUEST, "the message is too large"), 413);
    let message: unknown;
    try {
      message = JSON.parse(text);
    } catch {
      return c.json(failure(null, PARSE_ERROR, "the body is not JSON"), 400);
    }
    if (Array.isArray(message)) return c.json(failure(null, INVALID_REQUEST, "send one message per request; batches are not taken"), 400);
    const m = (message ?? {}) as Message;
    if (m.jsonrpc !== "2.0" || typeof message !== "object") return c.json(failure(null, INVALID_REQUEST, "not a JSON-RPC 2.0 message"), 400);
    // A notification or a reply to the server is taken with nothing to say back.
    if (m.id === undefined || m.method === undefined) return c.body(null, 202);
    if ((typeof m.id !== "string" && typeof m.id !== "number") || typeof m.method !== "string") return c.json(failure(null, INVALID_REQUEST, "id is a string or a number, and method a string"), 400);
    return c.json(await answer(ctx, user, m, m.id, writes));
  });

  return app;
}
