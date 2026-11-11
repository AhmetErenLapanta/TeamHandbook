// A stand-in for an agent CLI, for the demo and the tests: it makes one change that depends
// only on the task title - a skill named after it - and prints the JSON lines the orchestrator's
// fake adapter reads. It reads no model, no network and nothing outside its working directory.
// A task from a template names the skill in its prompt, and the stand-in writes that one.
// Lines in the task's description change how it behaves, so a demo or a test can show a slow,
// a failing, a talkative or a careless agent: `stand-in: wait <n> seconds`, `stand-in: fail`,
// `stand-in: print <n> lines`, `stand-in: write a <n> MB file`, `stand-in: write <n> files`,
// `stand-in: delete its directory`, `stand-in: leave the skill without frontmatter`,
// `stand-in: change a hook`, `stand-in: spend <usd>`, `stand-in: be refused <tool> <target>`, `stand-in: fail in <repository>`, `stand-in: print env <NAME>`, `stand-in: write env <NAME>` and `stand-in: work in <directory>`,
// one line a directory, each getting the same skill.
// Asked to plan a task over several repositories, it names every candidate in the order listed,
// or the ids after `stand-in: plan`, cites the first team skill it is shown, and changes nothing.
// Asked which folder a task belongs in, it names the first one the task's words name, or none.
// Asked to suggest team skills, it names the ones after `stand-in: suggest`.
// Asked whether a task's review teaches a rule, it drafts one from the person's first words, or none after `stand-in: no lesson`.
// With `--two-way` it holds a session instead: each stdin line is a message, an answer or an
// interrupt, and it prints a result line per turn; see twoWay() below.
import { closeSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { join, relative } from "node:path";
import { createInterface } from "node:readline";

const at = process.argv.indexOf("--title");
const title = at >= 0 ? process.argv[at + 1] ?? "" : "";
const say = (event) => process.stdout.write(JSON.stringify(event) + "\n");
// What it does also goes out as the live view's events, in the contract's own shapes: each call
// by an id of its own, the file it writes with its patch, a command's output and its to-do list.
let calls = 0;
const plan = (steps) => say({ type: "todos", todos: steps.map(([content, status]) => ({ content, status })) });
function wrote(path, content) {
  const id = `call-${++calls}`;
  say({ type: "tool_call", id, tool: "Write", target: path, status: "started" });
  writeFileSync(path, content);
  say({ type: "tool_call", id, tool: "Write", target: path, status: "done" });
  say({ type: "edit", id, path, patch: content.replace(/\n$/, "").split("\n").map((line) => `+${line}`).join("\n") });
}
function listed(dir) {
  const id = `call-${++calls}`;
  const command = `ls ${dir}`;
  say({ type: "tool_call", id, tool: "Bash", target: null, command, status: "started" });
  say({ type: "tool_output", id, lines: readdirSync(dir).sort() });
  say({ type: "tool_call", id, tool: "Bash", target: null, command, status: "done" });
}
if (process.argv.includes("--two-way")) {
  await twoWay();
  process.exit(0);
}
const prompt = readFileSync(0, "utf8");
const directive = (pattern) => prompt.match(new RegExp(`^stand-in: ${pattern}$`, "m"));

say({ type: "log", text: `reading the task: ${title}` });
if (prompt.includes("\n## Candidate repositories\n")) {
  const ids = directive("plan (.+)")?.[1].split(/\s+/) ?? [...prompt.matchAll(/^### ([a-z0-9-]+)$/gm)].map((m) => m[1]);
  // The first of the team's skills the prompt quotes is the one the reason cites, when there is one.
  const skill = prompt.match(/^## The team's skills\n\n### ([a-z0-9-]+) /m)?.[1] ?? "none";
  say({ type: "result", summary: ids.map((id) => `TARGET: ${id}: the stand-in plans a change here (skill: ${skill})`).join("\n") });
  process.exit(0);
}
// Asked which team skills fit, it names the ones after `stand-in: suggest`, or none, and changes nothing.
// Asked which folder a task belongs in, it names the first folder the task's words name, or none, so the person is asked.
if (prompt.includes("Pick the one folder this task belongs in.")) {
  const [task, folders] = prompt.split("The folders, by name");
  const named = [...(folders ?? "").matchAll(/^(\d+)\. ([^\s]+)/gm)].find((m) => task.toLowerCase().includes(m[2].toLowerCase()));
  say({ type: "result", summary: named ? `${named[1]}: the task names ${named[2]}` : "none of these folders" });
  process.exit(0);
}
if (prompt.includes("Decide which of the team's skills an agent doing this work should use first.")) {
  const named = directive("suggest (.+)")?.[1].split(/\s+/).filter((s) => s !== "none") ?? [];
  say({ type: "result", summary: named.map((skill) => `SKILL: ${skill}: the stand-in suggests it`).join("\n") });
  process.exit(0);
}
// Asked whether a task's review teaches a rule, it turns the first thing the person said into one, or answers none after `stand-in: no lesson`.
if (prompt.includes("Decide whether what the person said while reviewing an agent's work on this task teaches a rule")) {
  const said = prompt.match(/^### (?:Follow-up|Refused tool call|Why they undid the change) 1[^\n]*\n\n```text\n([\s\S]*?)\n```/m)?.[1]?.split("\n")[0] ?? "";
  const name = said.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").split("-").slice(0, 5).join("-") || "follow-the-review";
  const lesson = { name, description: `Use when changing this project: ${said}`, body: `## Rule\n\n${said}\n\n## Check\n\n- The change follows the rule above.`, expect: "the change follows the rule" };
  say({ type: "result", summary: directive("no lesson") ? "NO LESSON" : JSON.stringify(lesson) });
  process.exit(0);
}
const done = await work(prompt, title, true);
if (done.code) process.exit(done.code);
say({ type: "result", summary: done.summary, ...(done.refused.length ? { denied: done.refused } : {}) });


// A two-way session, as an agent with stream-json input holds one. A line `{"type":"user","text"}`
// starts a turn; in it, `stand-in: ask <tool> <target>` asks a question `{"type":"ask","id","tool","target"}`
// and waits for `{"type":"answer","id","decision"}` when started with `--asks` (a mode that asks),
// and otherwise goes ahead without a question, as an agent in Auto does; and `stand-in: wait <n> seconds` waits unless
// `{"type":"interrupt"}` comes first. The first turn does what a one-shot run does (`work`), its
// skill named after `--title` or, without one, the first message's first line past a "Task: ", so the
// task has a change to open a request for. Stdin closing ends the session.
async function twoWay() {
  const lines = createInterface({ input: process.stdin })[Symbol.asyncIterator]();
  // One read in flight at a time: a wait that times out leaves its read pending for the next caller.
  let pending = null;
  const take = () =>
    (pending ??= lines.next().then(({ value, done }) => {
      if (done) return null;
      try {
        return JSON.parse(value);
      } catch {
        return {};
      }
    }));
  const next = async () => {
    const line = await take();
    pending = null;
    return line;
  };
  let turns = 0;
  for (let message = await next(); message; message = await next()) {
    if (message.type !== "user" || typeof message.text !== "string") continue;
    const text = message.text;
    say({ type: "log", text: `reading the message: ${text.split("\n")[0]}` });
    let interrupted = false;
    let asked = 0;
    for (const line of text.split("\n")) {
      const ask = line.match(/^stand-in: ask (\S+) (.+)$/);
      if (ask && !process.argv.includes("--asks")) say({ type: "log", text: `allowed ${ask[1]} ${ask[2]} without a question` });
      else if (ask) {
        const id = `ask-${turns + 1}-${++asked}`;
        say({ type: "ask", id, tool: ask[1], target: ask[2] });
        let answer = await next();
        while (answer && !(answer.type === "answer" && answer.id === id) && answer.type !== "interrupt") answer = await next();
        if (!answer || answer.type === "interrupt") {
          interrupted = true;
          break;
        }
        say({ type: "log", text: `${answer.decision === "deny" ? "refused" : "allowed"} ${ask[1]} ${ask[2]}` });
      }
      const wait = line.match(/^stand-in: wait (\d+) seconds?$/);
      if (wait) {
        const woken = await Promise.race([take(), new Promise((r) => setTimeout(() => r("timeout"), Number(wait[1]) * 1000))]);
        if (woken !== "timeout") {
          pending = null;
          interrupted = true;
          break;
        }
      }
    }
    turns++;
    let refused = [];
    if (!interrupted && turns === 1) {
      const done = await work(text, title || text.split("\n")[0].replace(/^Task: /, ""), false);
      if (done.code) process.exit(done.code);
      refused = done.refused;
    }
    say({ type: "result", summary: interrupted ? "" : `Done with turn ${turns}.`, ...(interrupted ? { interrupted: true } : {}), ...(refused.length ? { denied: refused } : {}) });
  }
}

// The work a run does on its task, the same in a one-shot run and in a two-way session's first turn:
// `waits` is false in a session, which waits itself and can be interrupted.
async function work(prompt, title, waits) {
  const directive = (pattern) => prompt.match(new RegExp(`^stand-in: ${pattern}$`, "m"));
  const named = prompt.match(/^(?:Write a new skill named|Improve the existing skill) ([a-z0-9-]+)/m)?.[1];
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/, "") || "task";
  const first = prompt.match(/^## The team skills to use first\n[\s\S]*?```text\n([\s\S]*?)\n```/m)?.[1];
  if (first) say({ type: "log", text: `the stand-in was told to use first: ${first.split("\n").map((line) => line.split(":")[0]).join(", ")}` });
  const root = process.cwd();
  const into = [...prompt.matchAll(/^stand-in: work in (\S+)$/gm)].map((m) => m[1]);
  if (into.length) process.chdir(into[0]);
  const failIn = directive("fail in (\\S+)");
  if (failIn && prompt.includes(`checkout of the team repository ${failIn[1]}.`)) {
    say({ type: "log", text: `failing in ${failIn[1]}, as the task asked` });
    return { code: 1 };
  }
  // A turn that has spent this much so far, as the agent estimates it while it runs.
  const spend = directive("spend (\\d+(?:\\.\\d+)?)");
  if (spend) say({ type: "spend", usd: Number(spend[1]) });
  const wait = waits && directive("wait (\\d+) seconds?");
  if (wait) {
    say({ type: "log", text: `waiting ${wait[1]} seconds (pid ${process.pid})` });
    await new Promise((r) => setTimeout(r, Number(wait[1]) * 1000));
  }
  const print = directive("print (\\d+) lines?");
  if (print) for (let i = 1; i <= Number(print[1]); i++) say({ type: "log", text: `line ${i} of ${print[1]}` });
  const big = directive("write a (\\d+) MB file");
  if (big) {
    say({ type: "log", text: `writing a ${big[1]} MB file` });
    const fd = openSync("big.txt", "w");
    const megabyte = Buffer.alloc(1 << 20, "a");
    for (let i = 0; i < Number(big[1]); i++) writeSync(fd, megabyte);
    closeSync(fd);
  }
  const many = directive("write (\\d+) files");
  if (many) {
    mkdirSync("many", { recursive: true });
    for (let i = 1; i <= Number(many[1]); i++) writeFileSync(join("many", `file-${i}.txt`), `file ${i}\n`);
    say({ type: "log", text: `wrote ${many[1]} files` });
  }
  if (directive("delete its directory")) {
    rmSync(process.cwd(), { recursive: true, force: true });
    return { code: 0, summary: "Deleted its own directory.", refused: [] };
  }
  for (const [, name] of prompt.matchAll(/^stand-in: print env (\S+)$/gm)) say({ type: "log", text: `${name}=${process.env[name] ?? "(unset)"}` });
  for (const [, name] of prompt.matchAll(/^stand-in: write env (\S+)$/gm)) writeFileSync(`env-${name}.txt`, `${process.env[name] ?? "(unset)"}\n`);
  if (directive("fail")) {
    say({ type: "log", text: "failing, as the task asked" });
    return { code: 1 };
  }
  if (directive("change a hook")) {
    mkdirSync("hooks", { recursive: true });
    writeFileSync(join("hooks", "notice.mjs"), `// changed by the stand-in agent for the task "${title}"\n`);
    say({ type: "log", text: "changed hooks/notice.mjs" });
  }
  plan([["Read the task", "completed"], ["Write the skill", "in_progress"], ["Check the skill", "pending"]]);
  const dir = join("skills", named ?? slug);
  mkdirSync(dir, { recursive: true });
  const body = `Written by the stand-in agent for the task "${title}".\n`;
  const skill = directive("leave the skill without frontmatter")
    ? body
    : `---\nname: ${named ?? slug}\ndescription: Use when ${title.replace(/\s+/g, " ").trim() || "the task applies"}.\n---\n\n${body}`;
  wrote(join(dir, "SKILL.md"), skill);
  say({ type: "log", text: `wrote skills/${named ?? slug}/SKILL.md` });
  listed(dir);
  for (const other of into.slice(1)) {
    const there = relative(process.cwd(), join(root, other, dir));
    mkdirSync(there, { recursive: true });
    wrote(join(there, "SKILL.md"), skill);
    say({ type: "log", text: `wrote ${other}/skills/${named ?? slug}/SKILL.md` });
  }
  plan([["Read the task", "completed"], ["Write the skill", "completed"], ["Check the skill", "completed"]]);
  const refused = [...prompt.matchAll(/^stand-in: be refused (\S+) (.+)$/gm)].map((m) => ({ tool: m[1], target: m[2] }));
  return { code: 0, summary: `Added the skill ${named ?? slug}.`, refused };
}
