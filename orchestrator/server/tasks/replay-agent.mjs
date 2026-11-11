// Plays a transcript (transcript.ts) back as the agent CLI it was recorded from. It reads no model,
// no network and nothing but the transcript named in ORCHESTRATOR_REPLAY_TRANSCRIPT and its own stdin.
import { existsSync, mkdirSync, readFileSync, rmSync, watch, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { createInterface } from "node:readline";

const MISMATCH = 97;
// How long a stdin step waits for the client's line; a client that never writes it fails rather than hangs.
const STDIN_WAIT_MS = Number(process.env.ORCHESTRATOR_REPLAY_TIMEOUT_MS ?? 10_000);
const lines = readFileSync(process.env.ORCHESTRATOR_REPLAY_TRANSCRIPT, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
const expected = lines.find((l) => l.expect_outbound)?.expect_outbound ?? { args: [], stdin: [] };
const args = process.argv.slice(2);
// A transcript with stdin steps is a two-way run: the client keeps stdin open and writes as it goes.
const twoWay = lines.some((l) => "stdin" in l);

const refuse = (why) => {
  process.stderr.write(`replay: ${why}\n`);
  process.exit(MISMATCH);
};
const unmet = (stdin) => [
  ...expected.args.filter((flag) => !args.includes(flag)).map((flag) => `flag ${flag}`),
  ...expected.stdin.filter((text) => !stdin.includes(text) && !args.some((a) => a.includes(text))).map((text) => `prompt text ${JSON.stringify(text)}`),
];

let received = [];
let nextLine = null;
if (twoWay) {
  const reader = createInterface({ input: process.stdin })[Symbol.asyncIterator]();
  nextLine = () =>
    new Promise((done, fail) => {
      const timer = setTimeout(() => fail(new Error(`no line on stdin within ${STDIN_WAIT_MS} ms`)), STDIN_WAIT_MS);
      reader.next().then((r) => (clearTimeout(timer), r.done ? fail(new Error("stdin ended")) : done(r.value)), fail);
    });
} else {
  let stdin = "";
  try {
    stdin = readFileSync(0, "utf8");
  } catch {
    // An agent started with no stdin reads none.
  }
  const missing = unmet(stdin);
  if (missing.length) refuse(`started without what the transcript expects: ${missing.join(", ")}`);
}

// A step writes or removes only inside the checkout it was started in, the checkout itself included:
// a wrong transcript must not delete anything of the machine running the tests.
const inCheckout = (path) => {
  const rel = relative(process.cwd(), resolve(path));
  if (isAbsolute(path) || rel.startsWith("..") || isAbsolute(rel)) refuse(`a step names ${JSON.stringify(path)}, outside the checkout; nothing is written or removed`);
  return resolve(path);
};

// Resolves once the file exists; a watch on its folder rather than a poll, so nothing waits on a clock.
const until = (file) =>
  new Promise((done) => {
    mkdirSync(dirname(file), { recursive: true });
    const watcher = watch(dirname(file), () => existsSync(file) && (watcher.close(), done()));
    if (existsSync(file)) (watcher.close(), done());
  });

// Two frames are the same when they parse to the same value, whatever the key order or spacing.
const canonical = (value) =>
  value && typeof value === "object"
    ? Array.isArray(value)
      ? `[${value.map(canonical).join(",")}]`
      : `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(",")}}`
    : JSON.stringify(value);
const parsed = (line) => {
  try {
    return JSON.parse(line);
  } catch {
    return line;
  }
};

for (const step of lines) {
  if ("emit_inbound" in step) process.stdout.write((typeof step.emit_inbound === "string" ? step.emit_inbound : JSON.stringify(step.emit_inbound)) + "\n");
  else if ("stdin" in step) {
    const line = await nextLine().catch((err) => refuse(`waited for ${JSON.stringify(step.stdin)}: ${err.message}`));
    received.push(line);
    if (canonical(parsed(line)) !== canonical(step.stdin)) refuse(`expected on stdin ${JSON.stringify(step.stdin)}, got ${JSON.stringify(line)}`);
  } else if ("write" in step) {
    const target = inCheckout(step.write.path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, step.write.content);
  } else if ("remove" in step) rmSync(inCheckout(step.remove), { recursive: true, force: true });
  else if ("wait" in step) await new Promise((done) => setTimeout(done, step.wait));
  else if ("until" in step) await until(resolve(step.until));
}
if (twoWay) {
  const missing = unmet(received.join("\n"));
  if (missing.length) refuse(`ran without what the transcript expects: ${missing.join(", ")}`);
  process.stdin.destroy();
}
process.exitCode = lines.find((l) => "exit" in l)?.exit ?? 0;
