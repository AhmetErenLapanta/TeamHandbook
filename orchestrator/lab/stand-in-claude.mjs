// The lab's stand-in for the Claude Code CLI. It answers the version question, and run the way a
// orchestrator runs Claude Code for a task (`-p`, the prompt on stdin, stream-json out) it makes the
// change the task's issue asks for in every directory it is given: the checkout it starts in and
// each `--add-dir`. It knows three repository shapes by their layout - a gateway with a JSON file
// per route under endpoints/, a backend-for-frontend with a controller per resource under
// src/controllers/, and a service with an endpoint per call under src/endpoints/ - and adds the
// endpoint named by "Expose the <name> endpoint" to each it finds. A line
// `stand-in: break the checks of the gateway|bff|service` in the prompt leaves a file there that
// the repository's checks refuse. It reads no model and no network, and reports a fixed cost so
// a budget sees one. Asked to plan a task over several repositories, it names them by the layout
// each README describes. Anything else is refused, as before: the lab never runs a real claude.
// Started for a two-way session (`--input-format stream-json`) it reads the person's first turn as
// a stream-json line and keeps stdin open for the answers to what it asks.
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";

const args = process.argv.slice(2);
const SIGNED_IN_AS = { email: "solo@person.example.invalid", orgName: "Solo Person's Organization" };
if (args[0] === "--version") {
  console.log("2.1.309 (Claude Code)");
  process.exit(0);
}
// The sign-in probe, answered as Claude Code answers it for an account signed in through its own
// login: with the account's address and organization, which the orchestrator keeps none of.
if (args[0] === "auth" && args[1] === "status" && args.includes("--json")) {
  console.log(JSON.stringify({ loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty", email: SIGNED_IN_AS.email, orgName: SIGNED_IN_AS.orgName }));
  process.exit(0);
}
if (!args.includes("-p")) {
  console.error("the lab's stand-in claude runs nothing but a task");
  process.exit(1);
}

// What a Claude Code session started with these arguments, in this directory and with this home,
// loads by Claude Code's documented rules, written down when the lab asks for it: the settings
// files, the MCP servers with where each comes from, the hooks and the allowed tools. The setting
// sources default to user, project and local, and a settings file given with --settings always
// counts. Without --strict-mcp-config the user's servers load beside the given ones, and in -p
// the project's .mcp.json loads without asking whenever project settings are read (the docs list
// leaving project settings out with --setting-sources as one way to keep those servers out);
// a server any loaded settings file names in disabledMcpjsonServers stays out. It is the lab's
// reading of those rules, which shows what the orchestrator hands Claude Code, not what Claude Code does.
const valueOf = (flag) => args.flatMap((arg, i) => (arg === flag && args[i + 1] ? [args[i + 1]] : []));
let session = null;
/** The settings files loaded, in the order Claude Code merges them, a later one over an earlier: user, project, local, then --settings. */
let layers = [];
if (process.env.LAB_CLAUDE_LOADS) {
  const readJson = (file) => {
    try {
      return JSON.parse(readFileSync(file, "utf8"));
    } catch {
      return null;
    }
  };
  const sources = (valueOf("--setting-sources")[0] ?? "user,project,local").split(",").map((s) => s.trim());
  const configDir = process.env.CLAUDE_CONFIG_DIR || join(process.env.HOME ?? "", ".claude");
  const files = [
    ...(sources.includes("user") ? [{ from: "user", file: join(configDir, "settings.json") }] : []),
    ...(sources.includes("project") ? [{ from: "project", file: join(process.cwd(), ".claude", "settings.json") }] : []),
    ...(sources.includes("local") ? [{ from: "local", file: join(process.cwd(), ".claude", "settings.local.json") }] : []),
    ...valueOf("--settings").map((file) => ({ from: "flag", file })),
  ];
  const loaded = files.map((f) => ({ ...f, settings: readJson(f.file) })).filter((f) => f.settings);
  const disabled = new Set(loaded.flatMap((f) => f.settings.disabledMcpjsonServers ?? []));
  const servers = [
    ...valueOf("--mcp-config").flatMap((file) => Object.keys(readJson(file)?.mcpServers ?? {}).map((name) => ({ name, from: "mcp-config" }))),
    ...(args.includes("--strict-mcp-config")
      ? []
      : [
          ...Object.keys(readJson(process.env.CLAUDE_CONFIG_DIR ? join(configDir, ".claude.json") : join(process.env.HOME ?? "", ".claude.json"))?.mcpServers ?? {}).map((name) => ({ name, from: "user" })),
          ...(sources.includes("project") ? Object.keys(readJson(join(process.cwd(), ".mcp.json"))?.mcpServers ?? {}).filter((name) => !disabled.has(name)).map((name) => ({ name, from: "project" })) : []),
        ]),
  ];
  const hooks = loaded.flatMap((f) => Object.entries(f.settings.hooks ?? {}).flatMap(([event, groups]) => groups.flatMap((g) => (g.hooks ?? []).map((h) => ({ from: f.from, event, command: h.command })))));
  const allow = loaded.flatMap((f) => (f.settings.permissions?.allow ?? []).map((rule) => ({ from: f.from, rule })));
  const present = [".mcp.json", ".claude/settings.json"].filter((file) => existsSync(join(process.cwd(), file)));
  const deny = [
    ...loaded.flatMap((f) => (f.settings.permissions?.deny ?? []).map((rule) => ({ rule, base: f.from === "flag" ? dirname(f.file) : process.cwd() }))),
    ...valueOf("--disallowedTools").flatMap((list) => list.split(",")).map((rule) => ({ rule: rule.trim(), base: process.cwd() })),
  ];
  const blockOutside = loaded.some((f) => f.settings.permissions?.blockWritesOutsideWorkingDirectories === true);
  // The skills a session finds: the person's own under their config folder, the project's when its settings are read, and each --plugin-dir's.
  const skillDirs = [
    ...(sources.includes("user") ? [{ from: "user", dir: join(configDir, "skills") }] : []),
    ...(sources.includes("project") ? [{ from: "project", dir: join(process.cwd(), ".claude", "skills") }] : []),
    ...valueOf("--plugin-dir").map((dir) => ({ from: "plugin-dir", dir: join(dir, "skills") })),
  ];
  const skills = skillDirs.flatMap(({ from, dir }) => (existsSync(dir) ? readdirSync(dir).filter((name) => existsSync(join(dir, name, "SKILL.md"))).map((name) => ({ name, from })) : []));
  layers = loaded;
  session = { cwd: process.cwd(), present, sources, settings: loaded.map((f) => f.from), servers, skills, hooks, allow, deny, blockOutside, flagFiles: valueOf("--settings") };
}

const twoWay = valueOf("--input-format")[0] === "stream-json";
if (process.env.LAB_STANDIN_HOLD) appendFileSync(join(process.env.LAB_STANDIN_HOLD, "launched.log"), `${JSON.stringify(args)}\n`);
const frames = twoWay ? createInterface({ input: process.stdin })[Symbol.asyncIterator]() : null;
const nextFrame = async () => {
  const read = await frames.next();
  if (read.done) throw new Error("stdin ended before the stand-in had its answer");
  return JSON.parse(read.value);
};
const textOf = (content) => (typeof content === "string" ? content : Array.isArray(content) ? content.map((part) => part?.text ?? "").join("\n") : "");
const prompt = twoWay ? textOf((await nextFrame()).message?.content) : readFileSync(0, "utf8");
const session_id = "stand-in-session";

// `stand-in: write <path>` asks the agent's Write tool for a file: under ~/, beside the settings
// file the session was given (`<settings>/`), or from the working directory. The documented rules
// decide it: an Edit deny rule (`//` from the root, `/` from its settings file) refuses it, so does
// blockWritesOutsideWorkingDirectories outside the working directory and --add-dir, and a write in
// a .claude directory is never pre-approved in print mode short of bypassPermissions, the settings
// file given excepted. A write is checked against Edit rules alone, from settings files and from
// --disallowedTools; a Write(path) rule matches nothing. Otherwise a bare Edit or Write in
// --allowedTools approves it, wherever it is: the docs say a tool name alone matches every path and
// say no more, which is the lab's reading.
if (session) {
  const within = (path, dir) => path === dir || path.startsWith(dir.endsWith("/") ? dir : `${dir}/`);
  const anchored = ({ rule, base }) => {
    const m = /^Edit\((\/\/?)(.*)\)$/.exec(rule);
    if (!m) return null;
    const tree = m[2] === "**" || m[2].endsWith("/**");
    const rest = tree ? m[2].slice(0, -2).replace(/\/$/, "") : m[2];
    return { path: m[1] === "//" ? `/${rest}` : join(base, rest), tree };
  };
  const allowed = (valueOf("--allowedTools")[0] ?? "").split(",").map((t) => t.trim());
  const mode = valueOf("--permission-mode")[0] ?? "default";
  const roots = [process.cwd(), ...args.flatMap((arg, i) => (arg === "--add-dir" && args[i + 1] ? [args[i + 1]] : []))];
  const writes = [...prompt.matchAll(/^stand-in: write (\S+)$/gm)].map(([, target]) => {
    const path = target.startsWith("~/") ? join(process.env.HOME ?? "", target.slice(2)) : target.startsWith("<settings>/") ? join(dirname(session.flagFiles[0] ?? process.cwd()), target.slice("<settings>/".length)) : join(process.cwd(), target);
    const denied = session.deny.map(anchored).find((d) => d && (d.tree ? within(path, d.path) : path === d.path));
    const outside = !roots.some((root) => within(path, root));
    let why = null;
    if (denied) why = "an Edit deny rule";
    else if (session.blockOutside && outside) why = "blockWritesOutsideWorkingDirectories";
    else if (path.split("/").includes(".claude") && mode !== "bypassPermissions" && !session.flagFiles.includes(path)) why = "a .claude path is never pre-approved";
    else if (!allowed.includes("Write") && !allowed.includes("Edit")) why = "no allowed tool writes";
    if (!why) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, "// changed by the lab's stand-in agent\n");
    }
    return { target, path, outside, written: !why, refused: why };
  });
  // `stand-in: call <tool>` asks for a tool by its full name, mcp__<server>__<tool> for an MCP one.
  // Each PreToolUse hook whose matcher takes the name runs as Claude Code runs it, the call on its
  // stdin; one that answers permissionDecision "deny", or exits 2, refuses it. A layer's
  // disableAllHooks switches every hook off, the last layer that names it deciding.
  const hooksOff = layers.reduce((off, f) => (typeof f.settings.disableAllHooks === "boolean" ? f.settings.disableAllHooks : off), false);
  const decide = (tool) => {
    if (hooksOff) return { decision: "allow", reason: "every hook is switched off" };
    for (const f of layers) {
      for (const group of f.settings.hooks?.PreToolUse ?? []) {
        if (group.matcher && !new RegExp(`^(?:${group.matcher})$`).test(tool)) continue;
        for (const h of group.hooks ?? []) {
          const ran = spawnSync("/bin/sh", ["-c", h.command], { input: JSON.stringify({ hook_event_name: "PreToolUse", tool_name: tool, tool_input: {}, cwd: process.cwd() }), encoding: "utf8" });
          if (ran.status === 2) return { decision: "deny", reason: ran.stderr.trim() };
          let said = null;
          try {
            said = JSON.parse(ran.stdout.trim().split("\n").pop() ?? "");
          } catch {}
          if (said?.hookSpecificOutput?.permissionDecision === "deny") return { decision: "deny", reason: said.hookSpecificOutput.permissionDecisionReason ?? "" };
        }
      }
    }
    return { decision: "allow", reason: null };
  };
  const calls = [...prompt.matchAll(/^stand-in: call (\S+)$/gm)].map(([, tool]) => ({ tool, ...decide(tool) }));
  writeFileSync(process.env.LAB_CLAUDE_LOADS, JSON.stringify({ ...session, writes, calls }) + "\n", { flag: "a" });
}

// Asked whether a task's review teaches a rule, it turns the first thing the person said into one,
// as the demo agent does (demo/fake-agent.mjs), or answers none after `stand-in: no lesson`.
if (prompt.includes("Decide whether what the person said while reviewing an agent's work on this task teaches a rule")) {
  const said = prompt.match(/^### (?:Follow-up|Refused tool call) 1[^\n]*\n\n```text\n([\s\S]*?)\n```/m)?.[1]?.split("\n")[0] ?? "";
  const name = said.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").split("-").slice(0, 5).join("-") || "follow-the-review";
  const lesson = { name, description: `Use when changing this project: ${said}`, body: `## Rule\n\n${said}\n\n## Check\n\n- The change follows the rule above.`, expect: "the change follows the rule" };
  const answer = /^stand-in: no lesson$/m.test(prompt) ? "NO LESSON" : JSON.stringify(lesson);
  process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: answer, num_turns: 1, total_cost_usd: 0.01, usage: { input_tokens: 400, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 40 }, permission_denials: [] }) + "\n");
  process.exit(0);
}

// The planning step of a task over several repositories gives no checkout and asks for one
// "TARGET: <id>: <why>" line per repository to change. Each candidate is known by the layout its
// README describes, and the one the others depend on comes first: the service, then the
// backend-for-frontend, then the gateway. When the prompt quotes the team's add-endpoint skill,
// each line names it as the skill the reason rests on.
if (prompt.includes("## Candidate repositories")) {
  const rank = { service: 0, bff: 1, gateway: 2 };
  const why = { service: "answers the new call", bff: "calls the service for the customers' apps", gateway: "routes the customers' path to the backend-for-frontend" };
  // Only the candidates: the team's skills, quoted before them, carry headings of the same level.
  const candidates = prompt.slice(prompt.indexOf("## Candidate repositories"));
  const skill = /^### add-endpoint \(from /m.test(prompt) ? " (skill: add-endpoint)" : "";
  const sections = candidates.split(/^### /m).slice(1).map((section) => {
    const id = section.split("\n")[0].trim();
    const shape = section.includes("src/endpoints/") ? "service" : section.includes("src/controllers/") ? "bff" : section.includes("under endpoints/") ? "gateway" : null;
    return { id, shape };
  });
  const plan = sections.filter((s) => s.shape).sort((a, b) => rank[a.shape] - rank[b.shape]).map((s) => `TARGET: ${s.id}: it ${why[s.shape]}${skill}`);
  const answer = plan.join("\n") || "No candidate repository is one this change reaches.";
  process.stdout.write(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: answer }] } }) + "\n");
  process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: answer, num_turns: 1, total_cost_usd: 0.05, usage: { input_tokens: 800, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 60 }, permission_denials: [] }) + "\n");
  process.exit(0);
}
// "stand-in: wait <n> seconds" keeps the agent working that long first, so a scenario sees tasks run side by side.
const wait = prompt.match(/^stand-in: wait (\d+) seconds?$/m);
if (wait) await new Promise((resolve) => setTimeout(resolve, Math.min(120, Number(wait[1])) * 1000));
const dirs = [process.cwd(), ...args.flatMap((arg, i) => (arg === "--add-dir" && args[i + 1] ? [args[i + 1]] : []))];
const say = (event) => process.stdout.write(JSON.stringify(event) + "\n");
const named = prompt.match(/Expose the ([a-z0-9][a-z0-9-]*) endpoint/i)?.[1]?.toLowerCase();
const broken = new Set([...prompt.matchAll(/^stand-in: break the checks of the (gateway|bff|service)$/gm)].map((m) => m[1]));

const words = (named ?? "").split("-");
const pascal = words.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join("");
const camel = pascal.charAt(0).toLowerCase() + pascal.slice(1);

const shapeOf = (dir) => (existsSync(join(dir, "endpoints")) ? "gateway" : existsSync(join(dir, "src", "controllers")) ? "bff" : existsSync(join(dir, "src", "endpoints")) ? "service" : null);
const written = [];
// `stand-in: ask before writing`, in a two-way session whose questions go over stdio
// (`--permission-prompt-tool stdio`), asks before each write as Claude Code does in a mode that
// asks, in the frames its recorded transcripts hold, and writes only what it is allowed.
const asks = twoWay && valueOf("--permission-prompt-tool")[0] === "stdio" && /^stand-in: ask before writing$/m.test(prompt);
const denials = [];
let questions = 0;
const write = async (dir, file, content) => {
  const input = { file_path: join(dir, file), content };
  const tool_use_id = `toolu-${written.length + denials.length + 1}`;
  say({ type: "assistant", message: { content: [{ type: "tool_use", id: tool_use_id, name: "Write", input }] }, session_id });
  if (asks) {
    const request_id = `request-${++questions}`;
    say({ type: "control_request", request_id, request: { subtype: "can_use_tool", tool_name: "Write", display_name: "Write", input, description: file, tool_use_id } });
    let answer = await nextFrame();
    while (answer.type !== "control_response" || answer.response?.request_id !== request_id) answer = await nextFrame();
    if (answer.response?.response?.behavior !== "allow") {
      denials.push({ tool_name: "Write", tool_use_id, tool_input: input });
      return;
    }
  }
  mkdirSync(dirname(join(dir, file)), { recursive: true });
  writeFileSync(join(dir, file), content);
  written.push(file);
};

say({ type: "system", subtype: "init", cwd: process.cwd(), tools: ["Read", "Edit", "Write"], permissionMode: valueOf("--permission-mode")[0] ?? "default", session_id });
for (const dir of dirs) {
  const shape = shapeOf(dir);
  if (!shape || !named) continue;
  if (shape === "gateway") await write(dir, `endpoints/${named}.json`, JSON.stringify({ endpoint: `/v1/${named}`, method: "GET", backend: { service: "customer-bff", path: `/${named}` } }, null, 2) + "\n");
  if (shape === "bff") await write(dir, `src/controllers/${pascal}Controller.ts`, `export class ${pascal}Controller {\n  readonly path = "/${named}";\n\n  async get(): Promise<unknown> {\n    return fetch("http://shipment-service/${named}");\n  }\n}\n`);
  if (shape === "service") await write(dir, `src/endpoints/${named}.ts`, `export const ${camel} = { method: "GET", path: "/${named}" };\n`);
  if (broken.has(shape)) await write(dir, "BROKEN.md", "LAB-BROKEN: the stand-in left this, as the task asked.\n");
}

// The demo kit's repository (lab/demo/parcel-pricer): asked to make its failing test pass, the
// agent fixes the tier check; asked in a follow-up that the index is not needed, it loops over the
// tiers themselves. Each edit is made only where the kit's own line still stands.
const KIT = { file: "src/price.js", buggy: "if (weightKg < TIERS[i].upToKg) return TIERS[i].eur;", fixed: "if (weightKg <= TIERS[i].upToKg) return TIERS[i].eur;" };
const LOOP = { from: `  for (let i = 0; i < TIERS.length; i++) {\n    ${KIT.fixed}\n  }`, to: "  for (const tier of TIERS) {\n    if (weightKg <= tier.upToKg) return tier.eur;\n  }" };
const kitNotes = [];
// The kit's work is done as a person would watch an agent do it: a plan, the test read and run, the
// edit, the test again. Each tool call is a stream-json tool_use and its tool_result, so the task's
// live run shows each line; LAB_STANDIN_PACE_MS spaces them for a recording, and is 0 by default.
const pace = () => new Promise((resolve) => setTimeout(resolve, Number(process.env.LAB_STANDIN_PACE_MS ?? 0)));
// A two-way session as Claude Code keeps it: stdin is read for as long as the session lives, so a
// follow-up sent while the agent works is taken into the turn it is in, an interrupt ends that turn,
// and an answer to a permission question (a plan put to its person) arrives when the person gives it.
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const followUps = [];
const answers = new Map();
let stdinClosed = false;
if (twoWay) {
  void (async () => {
    for (;;) {
      const read = await frames.next();
      if (read.done) break;
      const frame = JSON.parse(read.value);
      if (frame.type === "control_request" && frame.request?.subtype === "interrupt") {
        say({ type: "result", subtype: "error_during_execution", is_error: true, result: "Request interrupted by user", num_turns: 1, total_cost_usd: 0.05, usage: { input_tokens: 600, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 80 }, terminal_reason: "aborted_streaming", session_id });
        process.exit(0);
      }
      if (frame.type === "control_response") answers.set(frame.response?.request_id, frame.response?.response ?? {});
      if (frame.type === "user" && typeof frame.message?.content === "string") followUps.push(frame.message.content);
    }
    stdinClosed = true;
  })();
}
// LAB_STANDIN_HOLD names a directory: the agent writes reached-<point> there on arriving at a point of its
// work and stays while a file named <point> is in it, so a scenario can act at that very moment.
const hold = async (point) => {
  const dir = process.env.LAB_STANDIN_HOLD;
  if (!dir) return;
  writeFileSync(join(dir, `reached-${point}`), "");
  while (existsSync(join(dir, point))) await sleep(200);
};
// In Claude Code's plan mode the agent reads and plans, changes nothing, and puts its plan to the
// person through ExitPlanMode: a permission question that waits for as long as the person takes. A
// no ends the agent's work there.
if (twoWay && valueOf("--permission-mode")[0] === "plan") {
  const request_id = "stand-in-plan-1";
  const plan = "## Plan\n\n1. Run the failing test\n2. Fix the tier check so a parcel at a limit takes that tier\n3. Run the tests again";
  say({ type: "control_request", request_id, request: { subtype: "can_use_tool", tool_name: "ExitPlanMode", input: { plan }, tool_use_id: "toolu-plan-1" } });
  while (!answers.has(request_id)) await sleep(200);
  if (answers.get(request_id).behavior !== "allow") {
    say({ type: "result", subtype: "success", is_error: false, result: "Understood, nothing was changed.", num_turns: 1, total_cost_usd: 0.05, usage: { input_tokens: 600, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 80 }, permission_denials: [], terminal_reason: "completed", session_id });
    while (!stdinClosed) await sleep(200);
    process.exit(0);
  }
}
let calls = 0;
const tool = async (name, input, act) => {
  const tool_use_id = `toolu-kit-${++calls}`;
  say({ type: "assistant", message: { content: [{ type: "tool_use", id: tool_use_id, name, input }] }, session_id });
  await pace();
  const content = await act();
  say({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id, content }] }, session_id });
  await pace();
};
const plan = (done) => tool("TodoWrite", { todos: ["Run the failing test", "Fix the tier check", "Run the tests again"].map((content, i) => ({ content, activeForm: content, status: i < done ? "completed" : i === done ? "in_progress" : "pending" })) }, () => "Todos updated");
// The test run is a real one, in the folder, so the output the run shows is the kit's own.
const npmTest = (dir) => tool("Bash", { command: "npm test", description: "Run the tests" }, () => {
  const ran = spawnSync("npm", ["test", "--silent"], { cwd: dir, encoding: "utf8" });
  return `${ran.stdout ?? ""}${ran.stderr ?? ""}`.trim() || `exit ${ran.status}`;
});
const edit = (dir, from, to) => tool("Edit", { file_path: join(dir, KIT.file), old_string: from, new_string: to }, () => {
  const at = join(dir, KIT.file);
  writeFileSync(at, readFileSync(at, "utf8").replace(from, to));
  written.push(KIT.file);
  return `The file ${join(dir, KIT.file)} has been updated.`;
});
for (const dir of dirs) {
  const at = join(dir, KIT.file);
  if (!existsSync(at)) continue;
  const text = readFileSync(at, "utf8");
  if (/failing test/i.test(prompt) && text.includes(KIT.buggy)) {
    say({ type: "assistant", message: { content: [{ type: "text", text: "I'll run the failing test first, then fix the tier check." }] }, session_id });
    await plan(0);
    await tool("Read", { file_path: join(dir, "test", "price.test.js") }, () => readFileSync(join(dir, "test", "price.test.js"), "utf8"));
    await npmTest(dir);
    await plan(1);
    await hold("before-edit");
    await edit(dir, KIT.buggy, KIT.fixed);
    await hold("after-edit");
    await plan(2);
    await npmTest(dir);
    await plan(3);
    kitNotes.push("A parcel at a tier's limit was priced at the next tier; the check now takes the limit itself.");
  } else if (/the index is not needed/i.test(prompt) && text.includes(LOOP.from)) {
    await edit(dir, LOOP.from, LOOP.to);
    await npmTest(dir);
    kitNotes.push("The loop goes over the tiers themselves now.");
  }
}

// LAB_STANDIN_SESSION=open keeps the session as Claude Code does: it takes in the words sent while it worked into
// the turn it is in, answers once, and lives until stdin closes.
if (twoWay && process.env.LAB_STANDIN_SESSION === "open") {
  await sleep(1000);
  if (followUps.length) kitNotes.push(`Took in ${followUps.length} message(s) sent while it worked.`);
}
const summary = kitNotes.length ? kitNotes.join(" ") : named ? `Added the ${named} endpoint: ${written.join(", ") || "no repository of a known shape was given"}.` : "The task names no endpoint to expose, so nothing was changed.";
say({ type: "assistant", message: { content: [{ type: "text", text: summary }] }, session_id });
say({
  type: "result",
  subtype: "success",
  is_error: false,
  result: summary,
  num_turns: written.length + 1,
  total_cost_usd: 0.42,
  usage: { input_tokens: 1200, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 300 },
  permission_denials: denials,
  terminal_reason: "completed",
  session_id,
});
// A two-way session's stdin stays open after the result; the run is over all the same.
if (twoWay && process.env.LAB_STANDIN_SESSION === "open") while (!stdinClosed) await sleep(200);
if (twoWay) process.exit(0);
