// A stand-in for `opencode serve` (1.x) as a real process, for the tests: it listens where it is
// told, answers only with the password in its environment, records its pid and each session it is
// asked to make in its HOME (the person's, as a run as them has it), and runs each prompt as one turn. `stand-in: ask <tool> <target>`
// in the prompt asks first and waits for the answer; its MCP servers are notebook and atlassian; `stand-in: wait <n> seconds` waits before
// it writes. A turn writes opencode-note.md in its working folder, says so and goes idle.
import { appendFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";

const [command, ...args] = process.argv.slice(2);
if (command !== "serve") {
  process.stderr.write("the stand-in only serves\n");
  process.exit(2);
}
const port = Number(args.find((a) => a.startsWith("--port="))?.slice(7));
const expected = `Basic ${Buffer.from(`opencode:${process.env.OPENCODE_SERVER_PASSWORD}`).toString("base64")}`;
const session = "ses_standin1";
const streams = new Set();
const replies = new Map();
const send = (type, properties) => {
  for (const res of streams) res.write(`data: ${JSON.stringify({ type, properties })}\n\n`);
};
const record = (entry) => appendFileSync(join(process.env.HOME, "opencode-seen.jsonl"), `${JSON.stringify(entry)}\n`);
writeFileSync(join(process.env.HOME, "opencode-serve.pid"), String(process.pid));

async function turn(text) {
  const ask = /^stand-in: ask (\S+) (.+)$/m.exec(text);
  if (ask) {
    const answered = new Promise((resolve) => replies.set("per_standin1", resolve));
    send("permission.asked", { id: "per_standin1", sessionID: session, permission: ask[1], patterns: [ask[2]], metadata: {} });
    const reply = await answered;
    if (reply !== "once") {
      send("message.part.updated", { part: { sessionID: session, id: "t0", type: "text", text: "Declined; nothing written.", time: { start: 1, end: 2 } } });
      return send("session.idle", { sessionID: session });
    }
  }
  const wait = /^stand-in: wait (\d+) seconds?$/m.exec(text);
  if (wait) await new Promise((r) => setTimeout(r, Number(wait[1]) * 1000));
  writeFileSync(join(process.cwd(), "opencode-note.md"), "Written by the stand-in OpenCode.\n");
  send("message.part.updated", { part: { sessionID: session, id: "t1", type: "text", text: "Wrote opencode-note.md.", time: { start: 1, end: 2 } } });
  send("session.idle", { sessionID: session });
}

const server = createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    if (req.headers.authorization !== expected) return void res.writeHead(401).end();
    const body = raw ? JSON.parse(raw) : null;
    record({ method: req.method, path: req.url, body });
    if (req.method === "POST" && req.url === "/session") {
      return void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ id: session }));
    }
    if (req.method === "GET" && req.url === "/mcp") {
      return void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ notebook: { status: "connected" }, atlassian: { status: "connected" } }));
    }
    if (req.method === "GET" && req.url === "/event") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ type: "server.connected", properties: {} })}\n\n`);
      streams.add(res);
      return void res.on("close", () => streams.delete(res));
    }
    if (req.method === "POST" && req.url === `/session/${session}/prompt_async`) {
      res.writeHead(204).end();
      return void turn(body.parts.map((p) => p.text).join("\n"));
    }
    const replied = /^\/permission\/([\w-]+)\/reply$/.exec(req.url ?? "");
    if (req.method === "POST" && replied) {
      replies.get(replied[1])?.(body.reply);
      return void res.writeHead(200, { "content-type": "application/json" }).end("true");
    }
    if (req.method === "POST" && req.url === `/session/${session}/abort`) return void res.writeHead(200).end("true");
    res.writeHead(404).end();
  });
});
server.listen(port, "127.0.0.1", () => process.stdout.write(`opencode server listening on http://127.0.0.1:${port}\n`));
