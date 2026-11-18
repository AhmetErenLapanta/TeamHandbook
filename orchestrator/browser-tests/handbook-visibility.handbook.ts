import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";
import { DOCS, MARKET, PAYMENTS, PLANTED, standInCalls } from "./handbook-home.js";
import { finished, handbooksOf, send, server, signIn, startTask } from "./handbook-helpers.js";

/**
 * The handbook visibility scenario (Ek 26), from the person's side, on a stand-in Claude Code home: list what the
 * setup holds, edit one's own skill, update a plugin and see what changed, switch a plugin, a skill and a server off by
 * default and for one task only, read on the task page what it used, and remove a server. Each step runs at 1440 and at
 * 390. The default level is the person's own Claude Code: a plugin switch runs Claude Code's own command and reaches the
 * terminal; a skill or server switch is the person's list here, applied to each task, and the terminal keeps it. The
 * orchestrator writes no setting file of Claude Code's.
 */
const launches = () => standInCalls(server()).filter((c) => c.call === "launch") as unknown as { loaded: { skills: { name: string; call: string; source: string }[]; servers: { name: string }[]; plugins: string[] } }[];
const calledSkills = (launch: { loaded: { skills: { call: string }[] } }) => launch.loaded.skills.map((s) => s.call);
const digest = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");
const files = () => [join(server().home, ".claude", "settings.json"), join(server().home, ".claude.json"), join(server().home, ".stand-in", "state.json"), join(server().home, ".claude", "plugins", "installed_plugins.json")];
const NOTHING_OFF = { skills: [], commands: [], mcpServers: [] };

/** What the person's terminal would load now: the stand-in started by hand, with no setting of the orchestrator's. */
function terminalSees(): { plugins: { id: string; enabled: boolean; version: string }[]; skills: string[]; servers: string[] } {
  const h = server();
  const env = { HOME: h.home, PATH: process.env.PATH ?? "" };
  const plugins = JSON.parse(spawnSync(h.claude, ["plugin", "list", "--json"], { env, encoding: "utf8" }).stdout) as { id: string; enabled: boolean; version: string }[];
  const frame = JSON.stringify({ type: "user", message: { role: "user", content: "terminal" } });
  spawnSync(h.claude, ["-p", "--input-format", "stream-json", "--output-format", "stream-json"], { env, cwd: h.folder, input: `${frame}\n`, encoding: "utf8" });
  const last = launches().at(-1)!.loaded;
  return { plugins, skills: last.skills.map((s) => s.name), servers: last.servers.map((s) => s.name) };
}

/** The default list as the orchestrator keeps it for the person, so a step can leave it as it found it. */
async function resetDefaults(page: Page): Promise<void> {
  expect((await send(page, "PUT", "/api/handbook/defaults", { off: NOTHING_OFF })).status()).toBe(200);
}

const handbook = (page: Page, name: string | RegExp): Locator => handbooksOf(page).locator("li.handbook").filter({ has: page.locator(".handbook-line .handbook-name").filter({ hasText: name }) });
const itemOf = (within: Locator, name: string): Locator => within.locator("li.handbook-row").filter({ has: within.page().locator(".handbook-name", { hasText: new RegExp(`^/?${name}$`) }) });
async function openHandbook(page: Page, name: string | RegExp): Promise<Locator> {
  const list = handbook(page, name);
  const head = list.locator(".handbook-line .handbook-name").first();
  if ((await head.getAttribute("aria-expanded")) !== "true") await head.click();
  return list;
}

test.describe("handbook visibility", () => {
  test("given plugins that bring hooks and servers, when a task starts, then the person's setup and both plugins load with no click, and the Team page says what runs without holding anything back", async ({ page }) => {
    // given
    await signIn(page);

    const form = page.getByRole("form", { name: "New task" });
    const docsNotice = page.locator(".handbook-news").filter({ hasText: "docs-kit" });
    const noticeLine = "2 plugins run hooks or servers: payments-skills, docs-kit.";
    await expect(docsNotice).toContainText(noticeLine);

    // when
    const first = await startTask(page, "Add a note to the payments API");

    // then the person's own setup and both plugins load, with no click and none held back
    const loaded = launches().at(-1)!;
    expect(((await (await page.request.get(`/api/tasks/${first}`)).json()) as { task: { status: string; error: string | null } }).task).toMatchObject({ status: "needs-review", error: null });
    expect(calledSkills(loaded)).toEqual(expect.arrayContaining(["review-checklist", "release-notes", "add-endpoint", "docs-kit:write-docs", "payments-skills:changelog"]));
    expect(calledSkills(loaded)).not.toContain("folder-checklist");
    expect(loaded.loaded.servers.map((s) => s.name)).toEqual(expect.arrayContaining(["postgres", "jira", "ledger-sandbox", "docs-search"]));
    expect(loaded.loaded.servers.map((s) => s.name)).not.toContain("ledger");
    expect([...loaded.loaded.plugins].sort()).toEqual([DOCS, PAYMENTS].sort());

    // and the form said so once and closes it, the page shows on what the session loaded
    await page.goto("/");
    await expect(docsNotice).toContainText(noticeLine);
    await page.getByRole("button", { name: "Got it" }).click();
    await expect(docsNotice).toHaveCount(0);
    await page.reload();
    await expect(form.getByLabel("What needs doing?")).toBeVisible();
    await expect(docsNotice).toHaveCount(0);
    await page.goto("/default/team");
    const switches = handbooksOf(page).getByRole("switch", { name: /^Use / });
    await expect(switches.first()).toBeVisible();
    const shownOn = await switches.evaluateAll((all) => all.filter((x) => x.getAttribute("aria-checked") === "true").map((x) => x.getAttribute("aria-label")!.slice("Use ".length).split(" ")[0]!));
    expect(shownOn.sort()).toEqual(loaded.loaded.plugins.map((id) => id.slice(0, id.indexOf("@"))).sort());
  });

  test("given the setup, when Your handbooks is opened, then each handbook has a line with its version, a plugin behind its marketplace says so, and a skill name two handbooks share shows in both", async ({ page }) => {
    // given
    await signIn(page);
    await page.goto("/default/team");

    // when
    const section = handbooksOf(page);
    await expect(section).toBeVisible();
    await expect(section.getByText("How agents started here begin. Turning a plugin off turns it off in your terminal too.")).toBeVisible();

    // then
    await expect(handbook(page, "payments-skills")).toContainText("1.4.0 → 1.5.0");
    await expect(handbook(page, "docs-kit")).toContainText("2.0.0");
    await expect(handbook(page, "payments-skills")).toContainText(/\d+ of \d+ on/);
    const yours = await openHandbook(page, "Yours");
    await expect(itemOf(yours, "add-endpoint")).toContainText("Skill");
    await expect(itemOf(yours, "standup")).toContainText("Command");
    const payments = await openHandbook(page, "payments-skills");
    await expect(itemOf(payments, "add-endpoint")).toContainText("Skill");
    await expect(itemOf(payments, "changelog")).toContainText("Skill");
    const docs = await openHandbook(page, "docs-kit");
    await expect(itemOf(docs, "write-docs")).toContainText("Skill");
    await expect(itemOf(docs, "docs-lint")).toContainText("Command");
    const named = (await (await page.request.get("/api/handbook/sources")).json()) as { sources: { id: string; skills: { name: string }[] }[] };
    expect(named.sources.filter((s) => s.skills.some((k) => k.name === "add-endpoint")).map((s) => s.id).sort()).toEqual([`plugin:${PAYMENTS}`, "yours"]);
  });

  test("given a skill of the person's own, when it is opened, saved and saved again from a stale copy, then the file on disk is the saved one, the stale save is refused, and a plugin's skill is not editable", async ({ page }) => {
    // given
    await signIn(page);
    const file = join(server().home, ".claude", "skills", "release-notes", "SKILL.md");
    const opened = (await (await page.request.get("/api/handbook/file?source=yours&kind=skill&name=release-notes")).json()) as { content: string; digest: string };
    const edited = opened.content.replace("Group by user-facing area.", "Group by user-facing area, then by risk.");

    // when
    const saved = await send(page, "PUT", "/api/handbook/file", { source: "yours", kind: "skill", name: "release-notes", content: edited, expectedDigest: opened.digest });
    const stale = await send(page, "PUT", "/api/handbook/file", { source: "yours", kind: "skill", name: "release-notes", content: opened.content, expectedDigest: opened.digest });
    const plugin = await page.request.get(`/api/handbook/file?source=${encodeURIComponent(`plugin:${PAYMENTS}`)}&kind=skill&name=changelog`);
    const pluginWrite = await send(page, "PUT", "/api/handbook/file", { source: `plugin:${PAYMENTS}`, kind: "skill", name: "changelog", content: "x", expectedDigest: null });

    // then
    expect(saved.status()).toBe(200);
    expect(readFileSync(file, "utf8")).toContain("then by risk");
    expect(stale.status()).toBeGreaterThanOrEqual(400);
    expect(readFileSync(file, "utf8")).toContain("then by risk");
    expect(plugin.status()).toBeGreaterThanOrEqual(400);
    expect(plugin.status()).toBeLessThan(500);
    expect(pluginWrite.status()).toBeGreaterThanOrEqual(400);
    expect(pluginWrite.status()).toBeLessThan(500);
    await page.goto("/default/team");
    const yours = await openHandbook(page, "Yours");
    await itemOf(yours, "release-notes").locator(".handbook-name").click();
    await expect(yours.locator("pre")).toContainText("then by risk");
    const back = (await (await page.request.get("/api/handbook/file?source=yours&kind=skill&name=release-notes")).json()) as { digest: string };
    expect((await send(page, "PUT", "/api/handbook/file", { source: "yours", kind: "skill", name: "release-notes", content: opened.content, expectedDigest: back.digest })).status()).toBe(200);
  });

  test("given a skill of the person's own, when it is edited, then Save… shows the change first and only Save writes its file", async ({ page }) => {
    await signIn(page);
    await page.goto("/default/team");
    const handbooks = page.getByRole("region", { name: /Your handbooks/ });
    const file = join(server().home, ".claude", "skills", "review-checklist", "SKILL.md");
    await handbooks.getByRole("button", { name: "Yours", exact: true }).click();
    await handbooks.getByRole("button", { name: "review-checklist", exact: true }).first().click();
    await handbooks.getByRole("button", { name: "Edit review-checklist" }).click();
    await handbooks.getByRole("textbox", { name: "SKILL.md of review-checklist" }).fill("---\nname: review-checklist\ndescription: My checklist before I ask for a review\n---\n\nRead the diff three times.\n");
    // Save… shows the change first; only Save writes the file.
    await handbooks.getByRole("button", { name: "Save…" }).click();
    await expect(handbooks.getByText("+Read the diff three times.")).toBeVisible();
    expect(readFileSync(file, "utf8")).not.toContain("three times");
    await handbooks.getByRole("button", { name: "Save", exact: true }).click();
    await expect.poll(() => readFileSync(file, "utf8")).toContain("three times");
  });

  test("given a skill a plugin carries, when it is opened, then it is read only, says where it changes and offers Copy to Yours", async ({ page }) => {
    await signIn(page);
    await page.goto("/default/team");
    const handbooks = page.getByRole("region", { name: /Your handbooks/ });
    await handbooks.getByRole("button", { name: "docs-kit", exact: true }).click();
    await handbooks.getByRole("button", { name: "write-docs", exact: true }).click();
    await expect(handbooks.getByRole("button", { name: /^Edit / })).toHaveCount(0);
    await expect(handbooks.getByText("It changes in docs-kit")).toBeVisible();
    await handbooks.getByRole("button", { name: "Copy to Yours" }).click();
    await expect(handbooks.getByText("Copied to ~/.claude/skills/write-docs.")).toBeVisible();
    const copied = join(server().home, ".claude", "skills", "write-docs");
    expect(readFileSync(join(copied, "SKILL.md"), "utf8")).toContain("name: write-docs");
    // The scenarios after this one read the home as it was built.
    rmSync(copied, { recursive: true, force: true });
  });

  test("given a plugin with a newer version in its marketplace, when the person opens Update, then the page lists what it adds, changes and removes first, nothing ran before the click, and the click runs Claude Code's own command", async ({ page }) => {
    // given
    await signIn(page);
    await page.goto("/default/team");
    const payments = await openHandbook(page, "payments-skills");
    const ranBefore = standInCalls(server()).filter((c) => c.call === "plugin update").length;

    // when
    await payments.getByRole("button", { name: "Update to 1.5.0…" }).click();
    const ask = payments.getByRole("group", { name: "Update payments-skills" });

    // then
    await expect(ask).toContainText("Adds");
    await expect(ask).toContainText("rate-limits");
    await expect(ask).toContainText("Changes");
    await expect(ask).toContainText("add-endpoint");
    await expect(ask).toContainText("Removes");
    await expect(ask).toContainText("review-notes");
    await expect(ask).toContainText(`claude plugin update payments-skills@${MARKET}`);
    expect(standInCalls(server()).filter((c) => c.call === "plugin update")).toHaveLength(ranBefore);
    await ask.getByRole("button", { name: "Update to 1.5.0" }).click();
    await expect(handbooksOf(page).getByRole("status")).toContainText("plugin update");
    expect(standInCalls(server()).filter((c) => c.call === "plugin update").map((c) => c.args.includes(PAYMENTS))).toEqual([true]);
    await expect(handbook(page, "payments-skills")).toContainText("1.5.0");
    await expect(handbook(page, "payments-skills")).not.toContainText("→");
    expect(terminalSees().plugins.find((p) => p.id === PAYMENTS)!.version).toBe("1.5.0");
  });

  test("given a plugin switched off, when a new task starts, then it does not load, Claude Code's own disable command ran so the terminal shows it off too, and the orchestrator wrote no setting file", async ({ page }) => {
    // given
    await signIn(page);
    await page.goto("/default/team");
    const settings = join(server().home, ".claude", "settings.json");
    const before = digest(settings);

    // when
    await handbook(page, "docs-kit").getByRole("switch", { name: /^Use docs-kit/ }).click();

    // then
    await expect(handbook(page, "docs-kit")).toContainText("off");
    expect(standInCalls(server()).filter((c) => c.call === "plugin disable").map((c) => c.args.includes(DOCS))).toEqual([true]);
    expect(terminalSees().plugins.find((p) => p.id === DOCS)!.enabled).toBe(false);
    expect(digest(settings)).toBe(before);
    await page.goto("/");
    await startTask(page, "A second note for the payments API");
    expect(calledSkills(launches().at(-1)!)).not.toContain("docs-kit:write-docs");
    await page.goto("/default/team");
    await handbooksOf(page).locator("li.handbook-off > .handbook-line .handbook-name").click();
    await handbook(page, "docs-kit").getByRole("switch", { name: /^Use docs-kit/ }).click();
    await expect(handbook(page, "docs-kit")).not.toContainText("off");
    expect(standInCalls(server()).filter((c) => c.call === "plugin enable").map((c) => c.args.includes(DOCS))).toEqual([true]);
  });

  test("given one of the person's own skills switched off, when a new task starts, then the agent started here does not load it, the terminal still has it, and no file of Claude Code's changed", async ({ page }) => {
    // given
    await signIn(page);
    await page.goto("/default/team");
    const touched = files();
    const before = touched.map(digest);
    const callsBefore = standInCalls(server()).length;
    const yours = await openHandbook(page, "Yours");

    // when
    await itemOf(yours, "release-notes").getByRole("switch", { name: "Use release-notes" }).click();

    // then
    await yours.locator("details.handbooks-off summary").click();
    await expect(itemOf(yours, "release-notes")).toContainText("Off for agents started here. Your terminal still has it.");
    expect(touched.map(digest)).toEqual(before);
    expect(standInCalls(server()).slice(callsBefore).filter((c) => /^(plugin|mcp)/.test(c.call) && c.call !== "plugin list")).toEqual([]);
    await page.goto("/");
    await startTask(page, "Draft the release notes");
    expect(calledSkills(launches().at(-1)!)).not.toContain("release-notes");
    expect(terminalSees().skills).toContain("release-notes");
    await page.goto("/default/team");
    const again = await openHandbook(page, "Yours");
    await again.locator("details.handbooks-off summary").click();
    await expect(itemOf(again, "release-notes").getByRole("switch", { name: "Use release-notes" })).not.toBeChecked();
    await resetDefaults(page);
  });

  test("given an MCP server switched off, when a new task starts, then it is not handed to the agent, the person's own config is untouched, and no scope control is offered", async ({ page }) => {
    // given
    await signIn(page);
    await page.goto("/default/team");
    const config = join(server().home, ".claude.json");
    const before = digest(config);
    const yours = await openHandbook(page, "Yours");

    // when
    await itemOf(yours, "postgres").getByRole("switch", { name: "Use postgres" }).click();

    // then
    await yours.locator("details.handbooks-off summary").click();
    await expect(itemOf(yours, "postgres")).toContainText("Off for agents started here. Your terminal still has it.");
    await expect(itemOf(yours, "postgres").getByRole("button", { name: /scope/i })).toHaveCount(0);
    expect(digest(config)).toBe(before);
    expect(standInCalls(server()).filter((c) => c.call === "mcp remove")).toEqual([]);
    await page.goto("/");
    await startTask(page, "Look at the payments tables");
    expect(launches().at(-1)!.loaded.servers.map((s) => s.name)).not.toContain("postgres");
    expect(launches().at(-1)!.loaded.servers.map((s) => s.name)).toContain("jira");
    expect(terminalSees().servers).toContain("postgres");
    await resetDefaults(page);
  });

  test("given a skill a plugin carries, when its switch is turned off, then the row says the agent cannot call it though its name still shows, and the agent does not call it", async ({ page }) => {
    // given
    await signIn(page);
    await page.goto("/default/team");
    const payments = await openHandbook(page, "payments-skills");

    // when
    await itemOf(payments, "changelog").getByRole("switch", { name: "Use changelog" }).click();

    // then
    await payments.locator("details.handbooks-off summary").click();
    await expect(itemOf(payments, "changelog")).toContainText("the agent cannot call it; its name still shows");
    await page.goto("/");
    const id = await startTask(page, "stand-in: use-skill payments-skills:changelog");
    expect(calledSkills(launches().at(-1)!)).not.toContain("payments-skills:changelog");
    const task = ((await (await page.request.get(`/api/tasks/${id}`)).json()) as { task: { used?: { skills: { name: string }[] } } }).task;
    expect((task.used?.skills ?? []).map((k) => k.name)).not.toContain("changelog");
    await resetDefaults(page);
  });

  test("given a skill closed for one task only, when that task runs and the next one does, then the first does not load it, the next does, and nothing of the person's setup changed", async ({ page }) => {
    // given
    await signIn(page);
    const touched = files();
    const before = touched.map(digest);
    const form = page.getByRole("form", { name: "New task" });
    await form.getByLabel("What needs doing?").fill("Tidy the payments API");
    const setup = page.locator("section.task-setup");
    await expect(setup).toContainText(/Your default setup: \d+ of \d+ on/);

    // when: narrow, the list is a fold under the form; wide, it already stands open
    const fold = setup.locator(":scope > details");
    if (await fold.count()) await fold.locator(":scope > summary").click();
    await setup.locator("li.handbook").filter({ has: page.locator(".handbook-name", { hasText: "Yours" }) }).locator(".handbook-name").first().click();
    await setup.getByRole("switch", { name: "Use review-checklist" }).click();

    // then
    await expect(setup).toContainText("1 change from your default");
    await expect(page.getByRole("button", { name: "Reset" })).toBeVisible();
    await expect(page.getByText("Turn anything off for this task only; your default stays the same.")).toBeVisible();
    await form.getByRole("button", { name: "Start task" }).click();
    await page.waitForURL(/\/tasks\/tsk_/);
    await finished(page, new URL(page.url()).pathname.split("/").pop()!);
    expect(calledSkills(launches().at(-1)!)).not.toContain("review-checklist");
    expect(touched.map(digest)).toEqual(before);
    expect(((await (await page.request.get("/api/handbook/defaults")).json()) as { off: { skills?: unknown[] } }).off.skills ?? []).toEqual([]);
    await page.goto("/");
    await startTask(page, "Tidy the payments API again");
    expect(calledSkills(launches().at(-1)!)).toContain("review-checklist");
  });

  test("given a finished task that called skills, when its page is read, then it names each with its source and says what was only loaded", async ({ page }) => {
    // given
    await signIn(page);
    const id = await startTask(page, "stand-in: use-skill payments-skills:add-endpoint\nstand-in: use-skill review-checklist");

    // when
    const recorded = ((await (await page.request.get(`/api/tasks/${id}`)).json()) as { task: { used?: { skills: { name: string; source: string }[] } } }).task.used?.skills ?? [];
    expect(recorded.map((k) => `${k.source}/${k.name}`).sort()).toEqual([`plugin:${PAYMENTS}/add-endpoint`, "yours/review-checklist"]);
    await page.goto(`/default/tasks/${id}`);
    const started = page.getByRole("region", { name: "Started with" });
    await expect(started).toContainText(/\d+ skills, 2 plugins, \d+ MCP servers, CLAUDE\.md/);

    // then
    const usedLines = started.locator(":scope > ul > li.started-line");
    await expect(usedLines).toHaveCount(2);
    await expect(usedLines.filter({ hasText: "review-checklist" })).toContainText("from yours");
    await expect(usedLines.filter({ hasText: "add-endpoint" })).toContainText(/from payments-skills \d/);
    await expect(usedLines.filter({ hasText: "add-endpoint" })).not.toContainText("yours");
    const loaded = started.locator("details").filter({ has: page.locator("summary", { hasText: /^Loaded \(\d+\)$/ }) });
    await loaded.locator("summary").click();
    await expect(loaded.locator("li.started-line").filter({ hasText: "release-notes" })).toContainText("Loaded");
    await expect(usedLines.filter({ hasText: "release-notes" })).toHaveCount(0);
  });

  test("given the planted secrets of the setup, when every answer of the handbook routes and the pages are read, then no value is there, only names, a hook's command is shown without its secret, and a path out of the skill folders is refused", async ({ page }) => {
    await signIn(page);
    const bodies: string[] = [];
    const read = async (url: string) => {
      const answer = await page.request.get(url);
      bodies.push(await answer.text());
      return answer;
    };
    const listed = await read(`/api/handbook/sources?folder=${encodeURIComponent(server().folder)}`);
    const sources = (await listed.json()) as { available: boolean; sources: { id: string; kind: string; skills: { name: string }[]; hooks: { name: string; commands: string[] }[] }[] };
    expect(sources.available).toBe(true);
    expect(sources.sources.map((s) => s.kind).sort()).toEqual(["folder", "plugin", "plugin", "yours"]);
    for (const source of sources.sources) for (const skill of source.skills) expect((await read(`/api/handbook/skill?source=${encodeURIComponent(source.id)}&name=${encodeURIComponent(skill.name)}`)).status()).toBe(200);
    for (const bad of ["../../.credentials", "..%2F..%2F.claude.json", "/etc/passwd", "settings.json", "review-checklist/../../settings.json"]) {
      expect((await read(`/api/handbook/skill?source=yours&name=${bad}`)).status(), `skill name ${bad}`).toBe(404);
    }
    expect((await read("/api/handbook/skill?source=folder:/etc&name=passwd")).status()).toBe(404);
    expect((await read("/api/handbook/skill?source=plugin:nothing@nowhere&name=x")).status()).toBe(404);
    const stop = sources.sources.find((s) => s.kind === "yours")!.hooks.find((h) => h.name === "Stop");
    expect(JSON.stringify(stop?.commands ?? [])).not.toContain(PLANTED.hookCommand);
    await page.goto("/default/team");
    bodies.push(await page.content());
    for (const [name, value] of Object.entries(PLANTED)) for (const body of bodies) expect(body, `the planted ${name}`).not.toContain(value);
  });

  test("given a server of the user scope, when the person removes it, then Claude Code's own mcp command ran, the config lost it, and its secret values were never in the answer", async ({ page }) => {
    // given
    await signIn(page);

    // when
    const removed = await send(page, "DELETE", "/api/me/claude-mcp/jira?scope=user");

    // then
    const body = await removed.text();
    expect(removed.status(), body).toBeLessThan(300);
    expect(standInCalls(server()).filter((c) => c.call === "mcp remove").map((c) => c.args.at(-1))).toEqual(["jira"]);
    expect(JSON.parse(readFileSync(join(server().home, ".claude.json"), "utf8")).mcpServers.jira).toBeUndefined();
    for (const value of Object.values(PLANTED)) expect(body).not.toContain(value);
  });
});
