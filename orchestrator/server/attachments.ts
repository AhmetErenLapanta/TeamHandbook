import { createHash, timingSafeEqual } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { principalOf } from "./accounts.js";
import { suspended } from "./scim.js";
import type { OrchestratorContext } from "./app.js";
import type { AttachmentRecord } from "./attachment-store.js";
import { canEditTeam } from "./auth.js";
import type { OrchestratorEnv } from "./auth.js";
import { newId } from "./ids.js";
import { detectSecret } from "./plugin.js";
import { route } from "./route-scopes.js";
import { seesTask } from "./tasks/guards.js";
import type { TaskRecord } from "./tasks/types.js";

export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export const ATTACHMENT_LIMITS = { perTask: 20, tenantBytes: 1024 * 1024 * 1024 };
/** A signed address lasts long enough for the browser that asked for it to fetch it, and no longer. */
export const URL_LIFETIME_MS = 15 * 60_000;
const PURPOSE = "task-attachment-url";

/** The types a task takes, each known by its first bytes as well as by what the upload says it is. */
const TYPES: Record<string, (bytes: Buffer) => boolean> = {
  "image/png": (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  "image/jpeg": (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  "image/gif": (b) => b.subarray(0, 6).toString("latin1") === "GIF87a" || b.subarray(0, 6).toString("latin1") === "GIF89a",
  "image/webp": (b) => b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP",
  "application/pdf": (b) => b.subarray(0, 5).toString("latin1") === "%PDF-",
  "text/plain": () => true,
  "application/json": () => true,
};
const TEXT = new Set(["text/plain", "application/json"]);

/** A name cleaned of any folder, control characters and quotes, kept to 120 characters. */
export function cleanAttachmentName(raw: string): string {
  const base = raw.split(/[\\/]/).pop() ?? "";
  // eslint-disable-next-line no-control-regex
  const clean = base.replace(/[\u0000-\u001f\u007f"]/g, "").trim().slice(0, 120);
  return clean || "attachment";
}

/** Why these bytes are not taken as an attachment of this type, or null when they are. */
export function attachmentProblem(mime: string, bytes: Buffer): string | null {
  const recognised = TYPES[mime];
  if (!recognised) return `an attachment is a PNG, JPEG, GIF or WebP image, a PDF, plain text or JSON; ${mime || "no type"} is none of them`;
  if (bytes.length === 0) return "the attachment is empty";
  if (bytes.length > MAX_ATTACHMENT_BYTES) return "an attachment is at most 10 MB";
  if (!recognised(bytes)) return `the file does not start the way a ${mime} file does`;
  if (TEXT.has(mime)) {
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      return "a text attachment is UTF-8";
    }
    if (mime === "application/json") {
      try {
        JSON.parse(text);
      } catch {
        return "a JSON attachment is JSON that parses";
      }
    }
    const secret = detectSecret(text);
    if (secret) return `the attachment holds what looks like a ${secret}; take it out and attach it again`;
  }
  return null;
}

/** Where an attachment's bytes are kept: the data directory, the organization's folder, closed to all but the orchestrator's user. */
export function attachmentPath(dataDir: string, tenant: string, id: string): string {
  return join(dataDir, "attachments", encodeURIComponent(tenant), id);
}

function signed(ctx: Pick<OrchestratorContext, "vault" | "tenant">, a: AttachmentRecord, userId: string, expires: number): string {
  return ctx.vault!.mac(PURPOSE, [ctx.tenant, a.id, a.sha256, a.size, userId, expires].join("\n"));
}

/** The header that names a download: an ASCII name for old browsers and the exact one in RFC 5987 form, with no CR, LF or quote in either. */
export function contentDisposition(name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)}`;
}

/** The byte range a Range header asks for, within the file; null for the whole file, "unsatisfiable" for one outside it. */
export function byteRange(header: string | undefined, size: number): { start: number; end: number } | null | "unsatisfiable" {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || (match[1] === "" && match[2] === "")) return "unsatisfiable";
  const start = match[1] === "" ? Math.max(0, size - Number(match[2])) : Number(match[1]);
  const end = match[1] === "" || match[2] === "" ? size - 1 : Math.min(Number(match[2]), size - 1);
  return start <= end && start < size ? { start, end } : "unsatisfiable";
}

const SERVED_HEADERS = {
  "cache-control": "no-store",
  "content-security-policy": "default-src 'none'; sandbox",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "accept-ranges": "bytes",
};

/**
 * A task's attachments: added and removed by whoever started the task or edits its team, listed
 * and handed out as a fifteen-minute signed address to whoever reads the task. The address is
 * signed for the person who asked, so it stops working once they leave the organization, and
 * for the file's digest, so a file changed on disk does not verify. Attachments are kept no
 * longer than the organization keeps task logs, and are not part of a backup.
 */
export function attachmentRoutes(ctx: OrchestratorContext): Hono<OrchestratorEnv> {
  const app = new Hono<OrchestratorEnv>();
  const taskOf = async (id: string): Promise<TaskRecord | null> => ctx.store.getTask(ctx.tenant, id);
  const edits = (user: OrchestratorEnv["Variables"]["user"], task: TaskRecord) => task.createdBy === user.email || task.createdBy === user.id || canEditTeam(user, task.team);

  // The body is cut at the limit as it streams in, so an upload without a length, or with a false one, is not read whole first.
  route(app, "POST /api/tasks/:id/attachments", bodyLimit({ maxSize: MAX_ATTACHMENT_BYTES, onError: (c) => c.json({ error: "an attachment is at most 10 MB" }, 413) }), async (c) => {
    const user = c.get("user");
    const task = await taskOf(c.req.param("id") ?? "");
    if (!task || !seesTask(user, task)) return c.json({ error: "unknown task" }, 404);
    if (!edits(user, task)) return c.json({ error: "only whoever started the task or edits its team attaches files to it" }, 403);
    if (!ctx.vault) return c.json({ error: "attachments need ORCHESTRATOR_SECRET_KEY, which signs their addresses" }, 409);
    if (Number(c.req.header("content-length") ?? 0) > MAX_ATTACHMENT_BYTES) return c.json({ error: "an attachment is at most 10 MB" }, 413);
    const bytes = Buffer.from(await c.req.arrayBuffer());
    const mime = (c.req.header("content-type") ?? "").split(";")[0]!.trim();
    const problem = attachmentProblem(mime, bytes);
    if (problem) return c.json({ error: problem }, bytes.length > MAX_ATTACHMENT_BYTES ? 413 : 400);
    const attachment: AttachmentRecord = { tenant: ctx.tenant, id: newId("att"), taskId: task.id, name: cleanAttachmentName(decodeURIComponent(c.req.header("x-attachment-name") ?? "")), mime, size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), createdBy: user.email, createdAt: new Date().toISOString() };
    const path = attachmentPath(ctx.dataDir, ctx.tenant, attachment.id);
    mkdirSync(join(path, ".."), { recursive: true, mode: 0o700 });
    writeFileSync(path, bytes, { mode: 0o600 });
    chmodSync(path, 0o600);
    const kept = await ctx.store.insertAttachment(attachment, ATTACHMENT_LIMITS);
    if (kept !== "kept") {
      rmSync(path, { force: true });
      return c.json({ error: kept === "task-full" ? `a task holds at most ${ATTACHMENT_LIMITS.perTask} attachments` : "the organization's attachments are at their limit; remove some first" }, 409);
    }
    return c.json({ attachment }, 201);
  });

  route(app, "GET /api/tasks/:id/attachments", async (c) => {
    const task = await taskOf(c.req.param("id") ?? "");
    if (!task || !seesTask(c.get("user"), task)) return c.json({ error: "unknown task" }, 404);
    return c.json({ attachments: await ctx.store.taskAttachments(ctx.tenant, task.id) });
  });

  route(app, "GET /api/tasks/:id/attachments/:att/url", async (c) => {
    const user = c.get("user");
    const task = await taskOf(c.req.param("id") ?? "");
    const attachment = task && seesTask(user, task) ? await ctx.store.getAttachment(ctx.tenant, c.req.param("att") ?? "") : null;
    if (!task || !attachment || attachment.taskId !== task.id) return c.json({ error: "unknown attachment" }, 404);
    if (!ctx.vault) return c.json({ error: "attachments need ORCHESTRATOR_SECRET_KEY, which signs their addresses" }, 409);
    const expires = Date.now() + URL_LIFETIME_MS;
    const query = new URLSearchParams({ u: user.id, exp: String(expires), sig: signed(ctx, attachment, user.id, expires) });
    return c.json({ url: `${ctx.webBase ?? "/"}api/attachments/${attachment.id}?${query}`.replace(/^\/\//, "/"), expiresAt: new Date(expires).toISOString() });
  });

  route(app, "DELETE /api/tasks/:id/attachments/:att", async (c) => {
    const user = c.get("user");
    const task = await taskOf(c.req.param("id") ?? "");
    const attachment = task && seesTask(user, task) ? await ctx.store.getAttachment(ctx.tenant, c.req.param("att") ?? "") : null;
    if (!task || !attachment || attachment.taskId !== task.id) return c.json({ error: "unknown attachment" }, 404);
    if (!edits(user, task)) return c.json({ error: "only whoever started the task or edits its team removes its attachments" }, 403);
    await ctx.store.deleteAttachment(ctx.tenant, attachment.id);
    rmSync(attachmentPath(ctx.dataDir, ctx.tenant, attachment.id), { force: true });
    return c.json({ removed: attachment.id });
  });

  return app;
}

/** The signed address itself: no session, only a signature for this organization, file and person that has not run out. */
export function attachmentDownloadRoutes(ctx: OrchestratorContext): Hono<OrchestratorEnv> {
  const app = new Hono<OrchestratorEnv>();
  route(app, "GET /api/attachments/:att", async (c) => {
    const gone = () => c.json({ error: "unknown attachment" }, 404);
    const expires = Number(c.req.query("exp"));
    const userId = c.req.query("u") ?? "";
    const given = c.req.query("sig") ?? "";
    if (!ctx.vault || !Number.isSafeInteger(expires) || expires < Date.now()) return gone();
    const attachment = await ctx.store.getAttachment(ctx.tenant, c.req.param("att") ?? "");
    if (!attachment) return gone();
    const wanted = signed(ctx, attachment, userId, expires);
    if (given.length !== wanted.length || !timingSafeEqual(Buffer.from(given), Buffer.from(wanted))) return gone();
    // The person it was signed for is still in the organization, not turned off by the directory,
    // and still reads the task: a team they left takes the address with it.
    const person = await ctx.store.getUser(ctx.tenant, userId);
    const task = await ctx.store.getTask(ctx.tenant, attachment.taskId);
    if (!person || !task || (await suspended(ctx.store, ctx.tenant, userId)) || !seesTask(await principalOf(ctx.store, person), task)) return gone();
    let bytes: Buffer;
    try {
      bytes = readFileSync(attachmentPath(ctx.dataDir, ctx.tenant, attachment.id));
    } catch {
      return gone();
    }
    if (bytes.length !== attachment.size || createHash("sha256").update(bytes).digest("hex") !== attachment.sha256) return gone();
    const range = byteRange(c.req.header("range"), bytes.length);
    const headers = { ...SERVED_HEADERS, "content-type": attachment.mime, "content-disposition": contentDisposition(attachment.name) };
    if (range === "unsatisfiable") return c.body(null, 416, { ...headers, "content-range": `bytes */${bytes.length}` });
    if (range) return c.body(new Uint8Array(bytes.subarray(range.start, range.end + 1)), 206, { ...headers, "content-range": `bytes ${range.start}-${range.end}/${bytes.length}` });
    return c.body(new Uint8Array(bytes), 200, headers);
  });
  return app;
}

/** Removes an organization's attachments made before `before`, rows and files; says how many. */
export async function purgeAttachments(ctx: Pick<OrchestratorContext, "store" | "tenant" | "dataDir">, before: string): Promise<number> {
  const old = await ctx.store.attachmentsBefore(ctx.tenant, before);
  for (const attachment of old) {
    await ctx.store.deleteAttachment(ctx.tenant, attachment.id);
    rmSync(attachmentPath(ctx.dataDir, ctx.tenant, attachment.id), { force: true });
  }
  return old.length;
}
