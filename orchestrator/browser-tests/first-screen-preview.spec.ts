import { mkdirSync } from "node:fs";
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { overflows } from "./layout.js";

// The first screen of the project-first welcome, drawn from the design's class map with made-up
// folders before the screen that fills it with real ones exists: the target its builders work to.
// Opt-in, like the other screens drawn for a look over.
const SHOTS = process.env.ORCHESTRATOR_DESIGN_SHOTS;
const PROMISE = "Give a team of agents any folder on this machine: say what needs doing, and review every change before you keep it.";

/** A suggestion: its row picks it, and its path says where it is, since suggestions come from anywhere under home. */
const folder = (name: string, path: string, selected = false) => `
  <li><button type="button" class="folder-row" aria-selected="${selected}">
    <span><span class="folder-name">${name}</span><span class="folder-path">${path}</span></span>
    <span></span>
  </button></li>`;

/** A browsing row: the row goes into the folder; the place line above already says where the list is, so the row names only the folder. */
const browse = (name: string, selected = false) => `
  <li><button type="button" class="folder-row" aria-selected="${selected}">
    <span><span class="folder-name">${name}</span></span>
    <span class="folder-into" aria-hidden="true"></span>
  </button></li>`;

const LIST = `
  <h2 class="folder-group">Suggested</h2>
  <ul class="folder-list" aria-label="Suggested folders">
    ${folder("payments-api", "~/code/payments-api", true)}
    ${folder("checkout-web", "~/code/checkout-web")}
    ${folder("release-notes", "~/Documents/release-notes")}
  </ul>
  <h2 class="folder-group">Folders</h2>
  <ul class="folder-list" aria-label="Folders in your home folder">
    ${browse("code")}
    ${browse("Documents")}
  </ul>`;

const INSIDE = `
  <h2 class="folder-group">Folders</h2>
  <ul class="folder-list" aria-label="Folders in ~/code">
    ${browse("on-call-notes", true)}
    ${browse("experiments")}
  </ul>`;

const STATES: Record<string, string> = {
  list: LIST,
  inside: INSIDE,
  loading: `<div class="loading"><p class="muted" role="status">Loading your folders…</p><div class="skeleton" aria-hidden="true"><span class="skeleton-line"></span><span class="skeleton-line"></span><span class="skeleton-line"></span></div></div>`,
  empty: `<p class="muted">No folder under home is named like “ledgr”. Paste its path instead.</p>`,
  error: `<div class="problem" role="alert"><p class="error">Couldn't load your folders. The orchestrator could not read your home folder.</p><button type="button" class="secondary small">Retry your folders</button></div>`,
};

/** Where the list stands: the machine as a plain label, the path whole in mono, and the way up. */
const place = (path: string, up: boolean) => `<p class="folder-place"><span class="folder-machine">On this computer</span><span class="folder-at">${path}</span>${up ? '<button type="button" class="ghost small folder-up">Up one folder</button>' : ""}</p>`;

function picker(state: string, query = ""): string {
  const open = state === "list" ? "payments-api" : state === "inside" ? "on-call-notes" : "";
  return `
  <div class="folder-picker" role="group" aria-label="Pick a folder">
    <div class="folder-picker-bar"><label>Folder name or path<input type="text" data-page-search placeholder="~/code/shop" value="${query}"></label></div>
    ${state === "inside" ? place("~/code", true) : state === "empty" ? "" : place("~", false)}
    ${STATES[state]}
    <div class="folder-picker-foot">${open ? `<button type="button">Open ${open}</button>` : ""}<button type="button" class="link">Clone from GitHub or GitLab</button></div>
  </div>`;
}

const TASK = `
  <form class="task-box" aria-label="First task">
    <p class="task-box-where"><strong>payments-api</strong><span class="folder-at">~/code/payments-api</span><button type="button" class="link">Change</button></p>
    <label>What should the agent do here?<textarea placeholder="Describe a change, a fix or a question"></textarea></label>
    <div class="actions"><button type="submit">Start</button><p class="muted"><span class="state ok">ready</span> Claude Code, signed in on this machine</p></div>
  </form>`;

const SCREENS: { name: string; body: string }[] = [
  { name: "pick", body: picker("list") },
  { name: "inside", body: picker("inside") },
  { name: "task", body: TASK },
  { name: "loading", body: picker("loading") },
  { name: "empty", body: picker("empty", "ledgr") },
  { name: "error", body: picker("error") },
];

async function drawn(page: Page, body: string): Promise<void> {
  await page.goto("/demo/activity");
  // Drawn once the page has settled, so a section that lands late does not draw over it.
  await expect(page.getByText(/^Loading/).filter({ visible: true })).toHaveCount(0, { timeout: 30_000 });
  await page.waitForTimeout(300);
  await page.evaluate(([promise, inner]) => {
    document.querySelector("main")!.innerHTML = `<section class="first-screen"><h1 class="first-promise">${promise}</h1>${inner}</section>`;
  }, [PROMISE, body] as const);
}

test.describe("the first screen's design, drawn for a look over", () => {
  test.skip(!SHOTS, "Set ORCHESTRATOR_DESIGN_SHOTS to a directory to take the screenshots.");
  for (const theme of ["light", "dark"] as const) {
    for (const width of [1440, 390] as const) {
      test.describe(`at ${width} pixels in the ${theme} theme`, () => {
        test.use({ colorScheme: theme, viewport: { width, height: 900 } });

        test(`given the first screen's class map with made-up folders, when each of its faces is drawn ${width} pixels wide in the ${theme} theme, then it is saved and nothing sticks out`, async ({ page }) => {
          const dir = `${SHOTS}/first-screen/${theme}`;
          mkdirSync(dir, { recursive: true });
          const found: string[] = [];
          for (const screen of SCREENS) {
            await drawn(page, screen.body);
            for (const o of await overflows(page)) found.push(`${screen.name}: ${o.where} ${o.why}`);
            await page.screenshot({ path: `${dir}/${width}-${screen.name}.png`, fullPage: true });
          }
          expect(found).toEqual([]);
        });
      });
    }
  }
});

const HOME = "/home/ada";
const entry = (name: string, path: string, git: "none" | "repo" | "origin" = "none") => ({ name, path: `${HOME}/${path}`, git, markers: [] });
const FOLDERS = {
  under: HOME, parent: null, truncated: false,
  suggestions: [entry("payments-api", "code/payments-api", "origin"), entry("checkout-web", "code/checkout-web", "repo"), entry("release-notes", "Documents/release-notes")],
  folders: [entry("code", "code"), entry("Documents", "Documents"), entry("notes", "notes")],
};

/** One person's orchestrator, its folders made up, each read answered as the face drawn asks. */
const INSIDE_CODE = { under: `${HOME}/code`, parent: HOME, truncated: false, suggestions: [], folders: [entry("on-call-notes", "code/on-call-notes"), entry("experiments", "code/experiments")] };

async function picking(page: Page, face: "list" | "inside" | "loading" | "empty" | "error"): Promise<void> {
  await page.route(/\/api\/(orgs\/demo\/)?me$/, async (route) => {
    const res = await route.fetch();
    const body = await res.json();
    await route.fulfill({ response: res, json: { ...body, user: { ...body.user, mode: "local" } } });
  });
  await page.route(/\/api\/local\/folders/, (route) => {
    if (face === "loading") return new Promise<void>(() => undefined);
    if (face === "error") return route.fulfill({ status: 500, json: { error: "The orchestrator could not read your home folder.", code: "folders" } });
    if (new URL(route.request().url()).searchParams.get("under")) return route.fulfill({ json: INSIDE_CODE });
    return route.fulfill({ json: face === "empty" ? { ...FOLDERS, suggestions: [], folders: [] } : FOLDERS });
  });
  await page.route(/\/api\/projects$/, (route) => route.request().method() === "GET" ? route.fulfill({ json: { projects: [], last: null } }) : route.fallback());
  await page.goto("/demo/welcome");
  if (face === "loading") await page.waitForTimeout(600);
  else if (face === "list") await expect(page.locator(".folder-row").first()).toBeVisible();
  else if (face === "inside") {
    await page.locator("button.folder-row").filter({ has: page.locator(".folder-name", { hasText: /^code$/ }) }).first().click();
    await expect(page.locator(".folder-up")).toBeVisible();
  }
  else await expect(page.locator(".folder-picker .loading")).toHaveCount(0);
}

test.describe("the first screen as built, drawn for a look over", () => {
  test.skip(!SHOTS, "Set ORCHESTRATOR_DESIGN_SHOTS to a directory to take the screenshots.");
  for (const theme of ["light", "dark"] as const) {
    for (const width of [1440, 390] as const) {
      test.describe(`at ${width} pixels in the ${theme} theme`, () => {
        test.use({ colorScheme: theme, viewport: { width, height: 900 } });

        test(`given the folder picker and the first task fed made-up folders, when each face is drawn ${width} pixels wide in the ${theme} theme, then it is saved and nothing sticks out`, async ({ page }) => {
          const dir = `${SHOTS}/first-screen-built/${theme}`;
          mkdirSync(dir, { recursive: true });
          const found: string[] = [];
          for (const face of ["list", "inside", "loading", "empty", "error"] as const) {
            await picking(page, face);
            for (const o of await overflows(page)) found.push(`${face}: ${o.where} ${o.why}`);
            await page.screenshot({ path: `${dir}/${width}-pick-${face}.png`, fullPage: true });
            await page.unrouteAll({ behavior: "ignoreErrors" });
          }
          // The task box, for a person who opened a folder before: the demo's own project, with no Git.
          const { repos } = await (await page.request.get("/api/repos")).json();
          const opened = { ...repos[0], name: "release-notes", url: `file://${HOME}/Documents/release-notes`, facts: { git: "none", origin: null, name: "release-notes", kind: "code" } };
          await page.route(/\/api\/(orgs\/demo\/)?me$/, async (route) => {
            const res = await route.fetch();
            const body = await res.json();
            await route.fulfill({ response: res, json: { ...body, user: { ...body.user, mode: "local" } } });
          });
          await page.route(/\/api\/projects$/, (route) => route.fulfill({ json: { projects: [opened], last: opened.id } }));
          await page.goto("/demo/welcome");
          await expect(page.locator(".task-box")).toBeVisible();
          for (const o of await overflows(page)) found.push(`task: ${o.where} ${o.why}`);
          await page.screenshot({ path: `${dir}/${width}-task.png`, fullPage: true });
          expect(found).toEqual([]);
        });
      });
    }
  }
});
