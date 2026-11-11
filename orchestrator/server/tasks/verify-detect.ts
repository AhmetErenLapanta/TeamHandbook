import { createHash } from "node:crypto";
import type { CheckKind, DetectedCheck, DetectedStep, DetectedVerification } from "../../shared/verification.js";

/**
 * A file of the project by its path from the project's root, or null when there is none to read.
 * Asked only whether it is there, it answers for a file of any size: a lockfile's content is never
 * needed, and a large one is still the project's lockfile.
 */
export type ReadFile = (path: string, presence?: "presence") => Promise<string | null>;

const NETWORK = /\b(curl|wget|docker|podman|compose|npx|pnpx|bunx|dlx|install|fetch|deploy|playwright|cypress|puppeteer|selenium)\b|https?:\/\//i;
const LONG = /\b(e2e|playwright|cypress|selenium|docker|compose|integration)\b|--watch/i;
const PLACEHOLDER = /no test specified/i;
const KIND_ORDER: readonly CheckKind[] = ["test", "typecheck", "lint", "build"];
const NPM_SCRIPTS: Record<CheckKind, readonly string[]> = {
  test: ["test"],
  lint: ["lint"],
  build: ["build"],
  typecheck: ["typecheck", "type-check", "check-types"],
};
// npm runs these around an install, shown with the setup so the person sees what it runs.
const INSTALL_SCRIPTS = ["preinstall", "install", "postinstall", "preprepare", "prepare", "postprepare"];
// Files that change what a package manager runs or how: the shell scripts run in, the yarn binary, pnpm's install hooks.
const RC_FILES = [".npmrc", ".yarnrc", ".yarnrc.yml", ".pnpmfile.cjs"];
const SCRIPT_CALL = /\b(?:npm|pnpm|yarn|bun)\s+(?:run(?:-script)?\s+)?([A-Za-z0-9:._-]+)/g;

/** The scripts a script runs, itself and its pre and post first, then every script its bodies call, as far as they go. */
function calledScripts(scripts: Record<string, string>, first: string): string[] {
  const seen: string[] = [];
  const visit = (name: string) => {
    for (const each of [`pre${name}`, name, `post${name}`]) {
      if (scripts[each] === undefined || seen.includes(each)) continue;
      seen.push(each);
      for (const call of scripts[each]!.matchAll(SCRIPT_CALL)) visit(call[1]!);
    }
  };
  visit(first);
  return seen;
}

function digestOf(...parts: string[]): string {
  return createHash("sha256").update(parts.join("\0")).digest("hex");
}

function step(command: string, runs: string, source: string, material: string, flags?: { network?: boolean; long?: boolean }): DetectedStep {
  return {
    command,
    runs,
    source,
    network: flags?.network ?? NETWORK.test(runs),
    long: flags?.long ?? LONG.test(runs),
    digest: digestOf(source, command, material),
  };
}

type PackageManager = "npm" | "pnpm" | "yarn" | "bun";

async function packageManager(read: ReadFile, pkg: Record<string, unknown>): Promise<{ pm: PackageManager; lock: string | null }> {
  const named = typeof pkg.packageManager === "string" ? pkg.packageManager.split("@")[0] : null;
  const locks: [string, PackageManager][] = [["pnpm-lock.yaml", "pnpm"], ["yarn.lock", "yarn"], ["bun.lock", "bun"], ["bun.lockb", "bun"], ["package-lock.json", "npm"], ["npm-shrinkwrap.json", "npm"]];
  for (const [file, pm] of locks) {
    if ((named === null || named === pm) && (await read(file, "presence")) !== null) return { pm, lock: file };
  }
  return { pm: named === "pnpm" || named === "yarn" || named === "bun" ? named : "npm", lock: null };
}

function scriptCommand(pm: PackageManager, script: string): string {
  if (script === "test" && pm !== "bun") return `${pm} test`;
  return pm === "yarn" ? `yarn ${script}` : `${pm} run ${script}`;
}

function installCommand(pm: PackageManager, lock: string | null): string {
  if (pm === "npm") return lock ? "npm ci" : "npm install";
  return lock ? `${pm} install --frozen-lockfile` : `${pm} install`;
}

async function fromPackageJson(read: ReadFile): Promise<{ setup: DetectedStep | null; checks: DetectedCheck[] }> {
  const text = await read("package.json");
  if (text === null) return { setup: null, checks: [] };
  let pkg: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return { setup: null, checks: [] };
    pkg = parsed as Record<string, unknown>;
  } catch {
    return { setup: null, checks: [] };
  }
  const raw = typeof pkg.scripts === "object" && pkg.scripts !== null && !Array.isArray(pkg.scripts) ? (pkg.scripts as Record<string, unknown>) : {};
  const scripts = Object.fromEntries(Object.entries(raw).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  const { pm, lock } = await packageManager(read, pkg);
  const bodies = (names: string[]) => names.filter((name) => scripts[name] !== undefined).map((name) => `scripts.${name}: ${scripts[name]}`);
  // Every script and every rc file: a check's script can call any other, and an rc file can change what runs them.
  const shared = JSON.stringify([pm, scripts, await Promise.all(RC_FILES.map(async (name) => [name, await read(name)]))]);

  const checks: DetectedCheck[] = [];
  for (const kind of KIND_ORDER) {
    const script = NPM_SCRIPTS[kind].find((name) => scripts[name] !== undefined && !(kind === "test" && PLACEHOLDER.test(scripts[name]!)));
    if (!script) continue;
    const runs = bodies(calledScripts(scripts, script)).join("\n");
    checks.push({ kind, ...step(scriptCommand(pm, script), runs, `package.json scripts.${script}`, shared) });
  }

  const hasDeps = ["dependencies", "devDependencies", "optionalDependencies"].some((key) => {
    const deps = pkg[key];
    return typeof deps === "object" && deps !== null && Object.keys(deps).length > 0;
  });
  if (!hasDeps) return { setup: null, checks };
  const command = installCommand(pm, lock);
  const lifecycle = bodies(INSTALL_SCRIPTS);
  const runs = [`installs the dependencies${lock ? ` ${lock} pins` : " package.json names"}`, ...lifecycle].join("\n");
  const setup = step(command, runs, lock ?? "package.json", JSON.stringify([lock, shared]), { network: true, long: false });
  return { setup, checks };
}

const MAKEFILES = ["GNUmakefile", "makefile", "Makefile"];
const MAKE_TARGETS: Record<CheckKind, readonly string[]> = { test: ["test", "check"], lint: ["lint"], build: ["build"], typecheck: ["typecheck"] };

function recipeOf(text: string, target: string): string[] {
  const lines = text.split("\n");
  const at = lines.findIndex((line) => new RegExp(`^${target.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*:(?!=)`).test(line));
  if (at < 0) return [];
  const recipe: string[] = [];
  for (const line of lines.slice(at + 1)) {
    if (!line.startsWith("\t")) break;
    recipe.push(line.trim());
  }
  return [lines[at]!.trim(), ...recipe.map((line) => `  ${line}`)];
}

async function fromMakefile(read: ReadFile): Promise<DetectedCheck[]> {
  let file: string | null = null;
  let text: string | null = null;
  for (const name of MAKEFILES) {
    text = await read(name);
    if (text !== null) {
      file = name;
      break;
    }
  }
  if (file === null || text === null) return [];
  const targets = new Set([...text.matchAll(/^([A-Za-z0-9_.-]+)\s*:(?!=)/gm)].map((m) => m[1]!));
  // What an included file defines runs as much as the Makefile itself does.
  const included = [...text.matchAll(/^-?include\s+(.+)$/gm)].flatMap((m) => m[1]!.trim().split(/\s+/));
  const material = [text, ...(await Promise.all(included.map(async (name) => `${name}\0${(await read(name)) ?? ""}`)))].join("\0");
  const checks: DetectedCheck[] = [];
  for (const kind of KIND_ORDER) {
    const target = MAKE_TARGETS[kind].find((name) => targets.has(name));
    if (!target) continue;
    checks.push({ kind, ...step(`make ${target}`, recipeOf(text, target).join("\n"), `${file} target ${target}`, material) });
  }
  return checks;
}

async function fromPython(read: ReadFile): Promise<{ setup: DetectedStep | null; checks: DetectedCheck[] }> {
  const [pyproject, setupCfg, pytestIni, toxIni, requirements] = await Promise.all(["pyproject.toml", "setup.cfg", "pytest.ini", "tox.ini", "requirements-dev.txt"].map((name) => read(name)));
  const conftest = (await read("conftest.py", "presence")) !== null;
  const pytest = pytestIni !== null || conftest || /^\[tool\.pytest/m.test(pyproject ?? "") || /^\[tool:pytest\]/m.test(setupCfg ?? "") || /^\[pytest\]/m.test(toxIni ?? "") || /\bpytest\b/.test(`${pyproject ?? ""}\n${requirements ?? ""}`);
  if (pyproject === null && !pytest) return { setup: null, checks: [] };
  const uv = (await read("uv.lock", "presence")) !== null;
  const poetry = !uv && (await read("poetry.lock", "presence")) !== null;
  const prefix = uv ? "uv run " : poetry ? "poetry run " : "";
  const source = pyproject !== null ? "pyproject.toml" : pytestIni !== null ? "pytest.ini" : setupCfg !== null ? "setup.cfg" : toxIni !== null ? "tox.ini" : conftest ? "conftest.py" : "requirements-dev.txt";
  const network = uv || poetry;
  const checks: DetectedCheck[] = [];
  if (pytest) {
    const command = `${prefix}${prefix ? "pytest" : "python3 -m pytest"}`;
    checks.push({ kind: "test", ...step(command, command, source, "", { network, long: false }) });
  }
  if (/^\[tool\.mypy/m.test(pyproject ?? "")) checks.push({ kind: "typecheck", ...step(`${prefix}mypy .`, `${prefix}mypy .`, "pyproject.toml", "", { network, long: false }) });
  if (/^\[tool\.ruff/m.test(pyproject ?? "")) checks.push({ kind: "lint", ...step(`${prefix}ruff check .`, `${prefix}ruff check .`, "pyproject.toml", "", { network, long: false }) });
  const setup = uv ? step("uv sync", "installs the dependencies uv.lock pins, into the project's own .venv", "uv.lock", "", { network: true, long: false })
    : poetry ? step("poetry install", "installs the dependencies poetry.lock pins, into the project's own environment", "poetry.lock", "", { network: true, long: false })
    : null;
  return { setup, checks };
}

async function fromGo(read: ReadFile): Promise<DetectedCheck[]> {
  if ((await read("go.mod")) === null) return [];
  const go = (kind: CheckKind, command: string): DetectedCheck => ({ kind, ...step(command, command, "go.mod", "", { network: true, long: false }) });
  return [go("test", "go test ./..."), go("lint", "go vet ./..."), go("build", "go build ./...")];
}

async function fromCargo(read: ReadFile): Promise<DetectedCheck[]> {
  if ((await read("Cargo.toml")) === null) return [];
  const cargo = (kind: CheckKind, command: string): DetectedCheck => ({ kind, ...step(command, command, "Cargo.toml", "", { network: true, long: true }) });
  return [cargo("test", "cargo test"), cargo("typecheck", "cargo check"), cargo("build", "cargo build")];
}

/**
 * A wrapper script the repository carries runs as the command itself, and its properties name the
 * distribution it downloads: both are part of what is approved.
 */
async function wrapped(read: ReadFile, script: string, properties: string): Promise<string | null> {
  const body = await read(script);
  return body === null ? null : `${body}\0${(await read(properties)) ?? ""}`;
}

async function fromGradle(read: ReadFile): Promise<DetectedCheck[]> {
  const builds = await Promise.all(["build.gradle", "build.gradle.kts", "settings.gradle", "settings.gradle.kts"].map((name) => read(name)));
  if (builds.every((text) => text === null)) return [];
  const wrapper = await wrapped(read, "gradlew", "gradle/wrapper/gradle-wrapper.properties");
  const run = wrapper === null ? "gradle" : "./gradlew";
  const source = wrapper === null ? "build.gradle" : "gradlew";
  const gradle = (kind: CheckKind, task: string): DetectedCheck => ({ kind, ...step(`${run} ${task}`, `${run} ${task}`, source, wrapper ?? "", { network: true, long: true }) });
  return [gradle("test", "test"), gradle("build", "build")];
}

async function fromMaven(read: ReadFile): Promise<DetectedCheck[]> {
  if ((await read("pom.xml")) === null) return [];
  const wrapper = await wrapped(read, "mvnw", ".mvn/wrapper/maven-wrapper.properties");
  const run = wrapper === null ? "mvn" : "./mvnw";
  const source = wrapper === null ? "pom.xml" : "mvnw";
  const maven = (kind: CheckKind, goal: string): DetectedCheck => ({ kind, ...step(`${run} -q ${goal}`, `${run} -q ${goal}`, source, wrapper ?? "", { network: true, long: true }) });
  return [maven("test", "test"), maven("build", "-DskipTests package")];
}

/**
 * The setup and checks a project's own files name, read and never run: a package.json's scripts
 * first, then a Makefile's targets, then what a Python, Go, Rust, Gradle or Maven project runs by
 * convention. Within that order the checks go test, type check, lint, build, so the first is the one
 * a person is asked to approve.
 */
export async function detectVerification(read: ReadFile): Promise<DetectedVerification> {
  const [node, make, python, go, cargo, gradle, maven] = await Promise.all([fromPackageJson(read), fromMakefile(read), fromPython(read), fromGo(read), fromCargo(read), fromGradle(read), fromMaven(read)]);
  const found = [...node.checks, ...make, ...python.checks, ...go, ...cargo, ...gradle, ...maven];
  const checks = KIND_ORDER.flatMap((kind) => found.filter((check) => check.kind === kind));
  return { setup: node.setup ?? python.setup, checks };
}
