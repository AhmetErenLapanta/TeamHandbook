// src/lib/pipeline.ts
import {
  appendFileSync as appendFileSync2,
  existsSync as existsSync3,
  mkdirSync as mkdirSync4,
  readdirSync as readdirSync3,
  readFileSync as readFileSync7,
  renameSync,
  rmSync,
  writeFileSync as writeFileSync4
} from "node:fs";
import { basename as basename2, join as join8 } from "node:path";

// src/lib/session-state.ts
import { homedir } from "node:os";
import { join } from "node:path";
function handbookHome() {
  return process.env.TEAMHANDBOOK_HOME ?? join(homedir(), ".teamhandbook");
}

// src/lib/signals.ts
import { existsSync, appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { join as join2 } from "node:path";
function signalsFile(home = handbookHome()) {
  return join2(home, "signals.jsonl");
}
function ledgerFingerprintCounts(home = handbookHome()) {
  const counts = /* @__PURE__ */ new Map();
  let raw;
  try {
    raw = readFileSync(signalsFile(home), "utf8");
  } catch {
    return counts;
  }
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line);
      if (typeof parsed?.fingerprint === "string") {
        counts.set(parsed.fingerprint, (counts.get(parsed.fingerprint) ?? 0) + 1);
      }
    } catch {
    }
  }
  return counts;
}

// src/lib/gate.ts
import { mkdirSync as mkdirSync2, readFileSync as readFileSync2, writeFileSync } from "node:fs";
import { join as join3 } from "node:path";

// src/lib/secrets.ts
var SECRET_PATTERNS = [
  { name: "private-key", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: "aws-access-key", re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { name: "jwt", re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/ },
  { name: "github-token", re: /\b(?:gh[pousr]|github_pat)_[A-Za-z0-9_]{20,}\b/ },
  { name: "gitlab-token", re: /\bglpat-[A-Za-z0-9_-]{20,}\b/ },
  { name: "slack-token", re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  { name: "bearer-token", re: /\bBearer\s+[A-Za-z0-9._~+/-]{20,}=*/i },
  { name: "url-credentials", re: /\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:[^\s@/]{3,}@/i },
  {
    name: "assigned-secret",
    re: /\b(?:api[_-]?key|secret|token|passw(?:or)?d)["']?\s*[=:]\s*["']?[A-Za-z0-9+/_.-]{8,}/i
  }
];
function detectSecret(text) {
  for (const { name, re } of SECRET_PATTERNS) {
    if (re.test(text)) return name;
  }
  return null;
}

// src/lib/gate.ts
var defaultGateConfig = {
  repeatThreshold: 2,
  maxErrorChars: 4e3,
  maxCommandChars: 1e3,
  maxEditCount: 10
};
function drop(signal, reason, detail) {
  return { signal, pass: false, reason, detail };
}
function sieveSignal(signal, occurrences, config = defaultGateConfig) {
  if (signal.kind !== "candidate") return drop(signal, "not-candidate");
  const secret = detectSecret(
    [signal.command, signal.error, signal.resolvedCommand ?? "", ...signal.edits].join("\n")
  );
  if (secret) return drop(signal, "secret", secret);
  if (signal.edits.length === 0) return drop(signal, "no-file-change");
  if (occurrences < config.repeatThreshold) {
    return drop(signal, "below-repeat-threshold", `${occurrences}/${config.repeatThreshold}`);
  }
  if (signal.error.length > config.maxErrorChars) return drop(signal, "oversized", "error");
  if (signal.command.length > config.maxCommandChars) return drop(signal, "oversized", "command");
  if (signal.edits.length > config.maxEditCount) return drop(signal, "oversized", "edits");
  return { signal, pass: true };
}
function runRuleSieves(signals, home = handbookHome(), config = defaultGateConfig) {
  const counts = ledgerFingerprintCounts(home);
  const decisions = signals.map((s) => sieveSignal(s, counts.get(s.fingerprint) ?? 0, config));
  const secretDrops = decisions.filter((d) => d.reason === "secret").length;
  if (secretDrops > 0) incrementRedactionBlocked(home, secretDrops);
  return {
    passed: decisions.filter((d) => d.pass).map((d) => d.signal),
    dropped: decisions.filter((d) => !d.pass)
  };
}
function countersFile(home = handbookHome()) {
  return join3(home, "counters.json");
}
function readCounters(home = handbookHome()) {
  try {
    const parsed = JSON.parse(readFileSync2(countersFile(home), "utf8"));
    return { redactionBlocked: Number(parsed?.redactionBlocked) || 0 };
  } catch {
    return { redactionBlocked: 0 };
  }
}
function incrementRedactionBlocked(home = handbookHome(), by = 1) {
  const counters = readCounters(home);
  counters.redactionBlocked += by;
  mkdirSync2(home, { recursive: true });
  writeFileSync(countersFile(home), JSON.stringify(counters, null, 2));
  return counters;
}

// src/lib/score.ts
import { execFile } from "node:child_process";
import { readFileSync as readFileSync3 } from "node:fs";
import { join as join4 } from "node:path";
import { promisify } from "node:util";
var execFileAsync = promisify(execFile);
var CRITERIA = [
  "recurrence",
  "unfindability",
  "generality",
  "durability",
  "costOfError"
];
var defaultScoreConfig = {
  model: "haiku",
  threshold: 7,
  timeoutMs: 6e4
};
function loadScoreConfig(home = handbookHome()) {
  try {
    const parsed = JSON.parse(readFileSync3(join4(home, "config.json"), "utf8"));
    const gate = parsed?.gate;
    return {
      model: typeof gate?.model === "string" ? gate.model : defaultScoreConfig.model,
      threshold: typeof gate?.threshold === "number" && gate.threshold >= 0 && gate.threshold <= 10 ? gate.threshold : defaultScoreConfig.threshold,
      timeoutMs: typeof gate?.timeoutMs === "number" && gate.timeoutMs > 0 ? gate.timeoutMs : defaultScoreConfig.timeoutMs
    };
  } catch {
    return { ...defaultScoreConfig };
  }
}
function buildScorePrompt(signal, occurrences, existingSkills = []) {
  const dedupSection = existingSkills.length === 0 ? [] : [
    "Existing skills already available to the team:",
    ...existingSkills.map((s) => `- ${s.name}: ${s.description}`),
    "",
    'If the candidate is substantially covered by one of these, add "duplicateOf":',
    '"<existing skill name>" to your JSON; otherwise set "duplicateOf" to null.',
    ""
  ];
  return [
    "You are the promotion gate of TeamHandbook, a tool that turns real error-to-fix moments",
    "from coding sessions into reusable team skills. Decide whether this candidate deserves",
    "to become a skill by scoring five criteria, each from 0 (no) to 2 (clearly yes):",
    "",
    '- "recurrence": has this problem plausibly happened before and will it happen again?',
    '- "unfindability": is the fix NOT derivable from code, tests, README, or type signatures?',
    '- "generality": does it apply to a class of problems rather than one specific file?',
    '- "durability": will the fix survive refactors rather than evaporate?',
    '- "costOfError": how costly is it when someone hits this without the knowledge?',
    "",
    "Candidate:",
    `- failed command: ${signal.command}`,
    `- error (normalized): ${signal.error}`,
    `- resolving command: ${signal.resolvedCommand ?? "(none recorded)"}`,
    `- files edited for the fix: ${signal.edits.join(", ") || "(none)"}`,
    `- times this fingerprint was seen in the local ledger: ${occurrences}`,
    `- occurrences within the session: ${signal.count}`,
    "",
    ...dedupSection,
    "Reply with ONLY a JSON object, no prose, in exactly this shape:",
    '{"scores": {"recurrence": 0, "unfindability": 0, "generality": 0, "durability": 0, "costOfError": 0}, "rationale": "one short sentence", "duplicateOf": null}'
  ].join("\n");
}
function parseScoreResponse(text, threshold) {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  let parsed;
  try {
    parsed = JSON.parse(match[0]);
  } catch {
    return null;
  }
  const rawScores = parsed?.scores;
  if (typeof rawScores !== "object" || rawScores === null) return null;
  const scores = {};
  for (const criterion of CRITERIA) {
    const value = rawScores[criterion];
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 2) {
      return null;
    }
    scores[criterion] = value;
  }
  const total = CRITERIA.reduce((sum, c) => sum + scores[c], 0);
  const rationale = parsed.rationale;
  const duplicateOf = parsed.duplicateOf;
  const isDuplicate = typeof duplicateOf === "string" && duplicateOf.trim() !== "";
  return {
    scores,
    total,
    pass: !isDuplicate && total >= threshold,
    ...typeof rationale === "string" ? { rationale } : {},
    ...isDuplicate ? { duplicateOf: duplicateOf.trim() } : {}
  };
}
var runClaudeCli = async (prompt, model, timeoutMs) => {
  const args = ["-p", prompt];
  if (model) args.push("--model", model);
  const { stdout } = await execFileAsync("claude", args, {
    timeout: timeoutMs,
    maxBuffer: 1024 * 1024
  });
  return stdout;
};
async function scoreSignal(signal, occurrences, config = defaultScoreConfig, runner = runClaudeCli, existingSkills = []) {
  let response;
  try {
    response = await runner(
      buildScorePrompt(signal, occurrences, existingSkills),
      config.model,
      config.timeoutMs
    );
  } catch (err) {
    return { signal, outcome: "error", error: `claude invocation failed: ${String(err)}` };
  }
  const result = parseScoreResponse(response, config.threshold);
  if (!result) return { signal, outcome: "error", error: "unparseable score response" };
  return { signal, outcome: result.pass ? "promote" : "reject", result };
}

// src/lib/distill.ts
import { execFileSync } from "node:child_process";
import { existsSync as existsSync2, mkdirSync as mkdirSync3, readFileSync as readFileSync5, writeFileSync as writeFileSync2 } from "node:fs";
import { join as join6 } from "node:path";

// src/lib/skill-index.ts
import { readdirSync, readFileSync as readFileSync4 } from "node:fs";
import { join as join5 } from "node:path";
function candidatesDir(home = handbookHome()) {
  return join5(home, "candidates");
}
function defaultSkillDirs(home = handbookHome(), cwd = process.cwd()) {
  return [candidatesDir(home), join5(cwd, ".claude", "skills")];
}
function parseSkillFrontmatter(md) {
  const match = md.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return null;
  const fields = /* @__PURE__ */ new Map();
  for (const line of match[1].split("\n")) {
    const kv = line.match(/^([A-Za-z-]+):\s*(.*)$/);
    if (!kv) continue;
    let value = kv[2].trim();
    if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
      value = value.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
    }
    fields.set(kv[1], value);
  }
  const name = fields.get("name");
  const description = fields.get("description");
  if (!name || !description) return null;
  const scope = fields.get("scope");
  return { name, description, ...scope ? { scope } : {} };
}
function listExistingSkills(dirs) {
  const byName = /* @__PURE__ */ new Map();
  for (const dir of dirs) {
    let entries;
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      let raw;
      try {
        raw = readFileSync4(join5(dir, entry, "SKILL.md"), "utf8");
      } catch {
        continue;
      }
      const summary = parseSkillFrontmatter(raw);
      if (summary && !byName.has(summary.name)) byName.set(summary.name, summary);
    }
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

// src/lib/distill.ts
var defaultDistillConfig = {
  model: "",
  timeoutMs: 12e4
};
function loadDistillConfig(home = handbookHome()) {
  try {
    const parsed = JSON.parse(readFileSync5(join6(home, "config.json"), "utf8"));
    const distill = parsed?.distill;
    return {
      model: typeof distill?.model === "string" ? distill.model : defaultDistillConfig.model,
      timeoutMs: typeof distill?.timeoutMs === "number" && distill.timeoutMs > 0 ? distill.timeoutMs : defaultDistillConfig.timeoutMs
    };
  } catch {
    return { ...defaultDistillConfig };
  }
}
function normalizeRemoteUrl(raw) {
  let s = raw.trim();
  if (!s) return null;
  const hadProtocol = /^[a-z][a-z0-9+.-]*:\/\//i.test(s);
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "");
  s = s.replace(/^[^@/]+@/, "");
  if (!hadProtocol) {
    const colon = s.indexOf(":");
    const slash2 = s.indexOf("/");
    if (colon > 0 && (slash2 === -1 || colon < slash2)) {
      s = s.slice(0, colon) + "/" + s.slice(colon + 1);
    }
  }
  s = s.replace(/\.git$/i, "").replace(/\/+$/, "");
  const slash = s.indexOf("/");
  if (slash <= 0 || slash === s.length - 1) return null;
  return s.slice(0, slash).toLowerCase() + s.slice(slash);
}
function gitRemoteUrl(cwd) {
  try {
    const out = execFileSync("git", ["-C", cwd, "remote", "get-url", "origin"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    }).trim();
    return out || null;
  } catch {
    return null;
  }
}
function resolveScope(generality, normalizedRemote) {
  if (generality >= 2 || !normalizedRemote) return "team";
  return normalizedRemote;
}
function slugifySkillName(name) {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64).replace(/-+$/g, "");
  return slug || null;
}
function buildDistillPrompt(signal, occurrences) {
  return [
    "You are the distiller of TeamHandbook, a tool that turns real error-to-fix moments from",
    "coding sessions into reusable team skills. This candidate already passed the promotion",
    "gate. Write a spec-compliant Agent Skill from it, in English.",
    "",
    "Case:",
    `- failed command: ${signal.command}`,
    `- error (normalized): ${signal.error}`,
    `- resolving command: ${signal.resolvedCommand ?? "(none recorded)"}`,
    `- files edited for the fix: ${signal.edits.join(", ") || "(none)"}`,
    `- times this fingerprint was seen in the local ledger: ${occurrences}`,
    "",
    "Reply with ONLY a JSON object, no prose, in exactly this shape:",
    '{"name": "kebab-case-skill-name", "description": "one line: what this covers and when to use it", "body": "markdown body", "expect": "one sentence"}',
    "",
    "Rules:",
    "- name: short kebab-case identifier, max 64 chars",
    "- description: single line, max 1024 chars, must state the trigger situation",
    "- body: the SKILL.md markdown body WITHOUT frontmatter \u2014 cover the symptom (how the",
    "  error presents), the root cause, and the fix procedure step by step; generalize beyond",
    "  this one occurrence but do not invent facts not supported by the case",
    "- expect: the observable behavior that proves the fix worked (used as a regression gate)"
  ].join("\n");
}
function parseDistillResponse(text) {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  let parsed;
  try {
    parsed = JSON.parse(match[0]);
  } catch {
    return null;
  }
  const draft = parsed;
  for (const field of [draft.name, draft.description, draft.body, draft.expect]) {
    if (typeof field !== "string" || field.trim() === "") return null;
  }
  const slug = slugifySkillName(draft.name);
  if (!slug) return null;
  return {
    slug,
    description: draft.description.replace(/\s+/g, " ").trim().slice(0, 1024),
    body: draft.body.trim(),
    expect: draft.expect.replace(/\s+/g, " ").trim()
  };
}
function yamlQuote(value) {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}
function assembleSkillMd(draft, scope) {
  return [
    "---",
    `name: ${draft.slug}`,
    `description: ${yamlQuote(draft.description)}`,
    `scope: ${yamlQuote(scope)}`,
    "---",
    "",
    draft.body,
    "",
    "## Grounded case",
    "",
    "This skill was distilled from a real error-to-fix session. The originating case and its",
    "expected behavior live in [grounded-case.json](grounded-case.json) and serve as the",
    "regression gate whenever this skill is edited or challenged.",
    ""
  ].join("\n");
}
function relativizeEdits(edits, cwd) {
  const prefix = cwd.endsWith("/") ? cwd : cwd + "/";
  return edits.map((e) => e.startsWith(prefix) ? e.slice(prefix.length) : e);
}
function buildGroundedCase(signal, verdict, expect) {
  return {
    fingerprint: signal.fingerprint,
    capturedAt: signal.ts,
    command: signal.command,
    error: signal.error,
    resolvedCommand: signal.resolvedCommand ?? null,
    edits: relativizeEdits(signal.edits, signal.cwd),
    expect,
    gate: verdict.result ? { total: verdict.result.total, scores: verdict.result.scores } : null
  };
}
async function distillVerdict(verdict, occurrences, config = defaultDistillConfig, runner = runClaudeCli, remoteUrl = gitRemoteUrl) {
  const signal = verdict.signal;
  if (verdict.outcome !== "promote") {
    return { signal, outcome: "error", error: "signal was not promoted by the gate" };
  }
  let response;
  try {
    response = await runner(
      buildDistillPrompt(signal, occurrences),
      config.model,
      config.timeoutMs
    );
  } catch (err) {
    return { signal, outcome: "error", error: `claude invocation failed: ${String(err)}` };
  }
  const draft = parseDistillResponse(response);
  if (!draft) return { signal, outcome: "error", error: "unparseable distill response" };
  const generality = verdict.result?.scores.generality ?? 0;
  const scope = resolveScope(generality, normalizeRemoteUrl(remoteUrl(signal.cwd) ?? ""));
  return {
    signal,
    outcome: "distilled",
    artifact: {
      slug: draft.slug,
      scope,
      skillMd: assembleSkillMd(draft, scope),
      groundedCase: buildGroundedCase(signal, verdict, draft.expect)
    }
  };
}
function writeCandidate(artifact, home = handbookHome()) {
  const base = candidatesDir(home);
  let slug = artifact.slug;
  for (let i = 2; existsSync2(join6(base, slug)); i++) {
    slug = `${artifact.slug}-${i}`;
  }
  const dir = join6(base, slug);
  mkdirSync3(dir, { recursive: true });
  writeFileSync2(join6(dir, "SKILL.md"), artifact.skillMd);
  writeFileSync2(join6(dir, "grounded-case.json"), JSON.stringify(artifact.groundedCase, null, 2) + "\n");
  return dir;
}

// src/lib/queue.ts
import { readdirSync as readdirSync2, readFileSync as readFileSync6, writeFileSync as writeFileSync3 } from "node:fs";
import { basename, join as join7 } from "node:path";
function candidateMetaFile(dir) {
  return join7(dir, "candidate.json");
}
function writeCandidateMeta(dir, meta) {
  writeFileSync3(candidateMetaFile(dir), JSON.stringify(meta, null, 2) + "\n");
}
function candidateMetaFromArtifact(slug, artifact, verdict, createdAt) {
  return {
    slug,
    status: "pending",
    createdAt,
    scope: artifact.scope,
    description: parseSkillFrontmatter(artifact.skillMd)?.description ?? "",
    fingerprint: artifact.groundedCase.fingerprint,
    sessionId: verdict.signal.sessionId,
    gate: verdict.result ? {
      total: verdict.result.total,
      scores: verdict.result.scores,
      ...verdict.result.rationale ? { rationale: verdict.result.rationale } : {}
    } : null
  };
}

// src/lib/pipeline.ts
function pendingDir(home = handbookHome()) {
  return join8(home, "pending");
}
function drainPendingSignals(home = handbookHome()) {
  let entries;
  try {
    entries = readdirSync3(pendingDir(home));
  } catch {
    return [];
  }
  const signals = [];
  for (const entry of entries.filter((e) => e.endsWith(".json")).sort()) {
    const file = join8(pendingDir(home), entry);
    const claimed = `${file}.claimed-${process.pid}`;
    try {
      renameSync(file, claimed);
    } catch {
      continue;
    }
    try {
      const parsed = JSON.parse(readFileSync7(claimed, "utf8"));
      if (Array.isArray(parsed)) signals.push(...parsed);
    } catch {
    }
    rmSync(claimed, { force: true });
  }
  return signals;
}
function pipelineLogFile(home = handbookHome()) {
  return join8(home, "pipeline.log");
}
function appendPipelineLog(summary, home, ts) {
  mkdirSync4(home, { recursive: true });
  appendFileSync2(pipelineLogFile(home), JSON.stringify({ ts, ...summary }) + "\n");
}
async function runPipeline(signals, home = handbookHome(), deps = {}, now = () => (/* @__PURE__ */ new Date()).toISOString()) {
  const runner = deps.runner ?? runClaudeCli;
  const remoteUrl = deps.remoteUrl ?? gitRemoteUrl;
  const listSkills = deps.listSkills ?? listExistingSkills;
  const scoreConfig = loadScoreConfig(home);
  const distillConfig = loadDistillConfig(home);
  const { passed, dropped } = runRuleSieves(signals, home);
  const counts = ledgerFingerprintCounts(home);
  const summary = {
    received: signals.length,
    sievedOut: dropped.length,
    scored: 0,
    rejected: 0,
    errored: 0,
    written: []
  };
  for (const signal of passed) {
    const occurrences = counts.get(signal.fingerprint) ?? 0;
    const existing = listSkills(defaultSkillDirs(home, signal.cwd));
    const verdict = await scoreSignal(signal, occurrences, scoreConfig, runner, existing);
    summary.scored += 1;
    if (verdict.outcome === "reject") {
      summary.rejected += 1;
      continue;
    }
    if (verdict.outcome === "error") {
      summary.errored += 1;
      continue;
    }
    const outcome = await distillVerdict(verdict, occurrences, distillConfig, runner, remoteUrl);
    if (outcome.outcome !== "distilled" || !outcome.artifact) {
      summary.errored += 1;
      continue;
    }
    const dir = writeCandidate(outcome.artifact, home);
    const slug = basename2(dir);
    writeCandidateMeta(dir, candidateMetaFromArtifact(slug, outcome.artifact, verdict, now()));
    summary.written.push(slug);
  }
  appendPipelineLog(summary, home, now());
  return summary;
}

// src/cli/run-pipeline.ts
async function main() {
  const signals = drainPendingSignals();
  if (signals.length === 0) return;
  await runPipeline(signals);
}
main().then(
  () => process.exit(0),
  () => process.exit(1)
);
