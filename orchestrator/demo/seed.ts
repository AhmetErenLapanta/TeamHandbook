import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { orchestratorDataDir, holdDataDir } from "../server/data-lock.js";
import { git } from "../server/git.js";
import { skeletonFiles } from "../server/plugin.js";
import plugin from "../../package.json" with { type: "json" };

/**
 * Two team repositories the way /handbook:init leaves them, filled with what a team shares
 * over a few weeks, plus the orchestrator.json that connects them. Every name is a stand-in.
 * The repositories are bare, under the demo directory, and reached by file:// - nothing
 * here talks to a forge.
 */

interface SeedSkill {
  slug: string;
  description: string;
  body: string;
  extra?: Record<string, string>;
}

interface SeedTeam {
  id: string;
  team: string;
  commitPrefix: string;
  reviewers: string[];
  labels: string[];
  skills: SeedSkill[];
  mcp: Record<string, unknown>;
  commands: Record<string, string>;
}

const TEAMS: SeedTeam[] = [
  {
    id: "payments-skills",
    team: "Payments",
    commitPrefix: "PAY",
    reviewers: ["ada", "grace"],
    labels: ["skills"],
    skills: [
      {
        slug: "add-ledger-migration",
        description: "Use when a change adds or alters a ledger table: write the migration, the rollback and the reconciliation check together.",
        body: "1. Write the forward migration.\n2. Write the rollback in the same change.\n3. Add the nightly reconciliation query.\n",
        extra: { "check.sql": "SELECT count(*) FROM ledger_entries WHERE amount IS NULL;\n" },
      },
      {
        slug: "release-checklist",
        description: "Use before tagging a payments release: the five checks that caught real incidents.",
        body: "- Feature flags default off\n- Idempotency keys on every new endpoint\n- Dashboards updated\n- Runbook linked\n- On-call told\n",
      },
    ],
    mcp: {
      postgres: { command: "npx", args: ["-y", "@modelcontextprotocol/server-postgres", "${PAYMENTS_DB_URL}"] },
      docs: { type: "http", url: "https://docs.example.com/mcp" },
    },
    commands: {
      "deploy-check": "---\ndescription: Run the pre-deploy checks for the payments service\n---\nRun the checks in release-checklist and report each one.\n",
    },
  },
  {
    id: "platform-skills",
    team: "Platform",
    commitPrefix: "",
    reviewers: ["linus"],
    labels: [],
    skills: [
      {
        slug: "rotate-service-certificate",
        description: "Use when a service certificate is within 14 days of expiry: rotate it without dropping connections.",
        body: "1. Issue the new certificate.\n2. Load it alongside the old one.\n3. Drain, then remove the old one.\n",
      },
    ],
    mcp: {
      kubernetes: { command: "kubectl-mcp", args: ["--read-only"], env: { KUBECONFIG: "${KUBECONFIG}" } },
    },
    commands: {},
  },
];

function skillMarkdown(skill: SeedSkill): string {
  return `---\nname: ${skill.slug}\ndescription: ${skill.description}\n---\n\n${skill.body}`;
}

function write(dir: string, files: Record<string, string>): void {
  for (const [path, content] of Object.entries(files)) {
    const target = join(dir, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
}

function commitAll(work: string, subject: string): void {
  git(["add", "-A"], work);
  git(["commit", "--quiet", "-m", subject], work);
}

/** `defaultBranch` is the team repositories' default branch; a team's own is often `master`. */
export function seed(demoDir: string, defaultBranch = "main"): { configFile: string } {
  const root = resolve(demoDir);
  rmSync(join(root, "repos"), { recursive: true, force: true });
  rmSync(join(root, "work"), { recursive: true, force: true });
  const repos = [];
  for (const team of TEAMS) {
    const bare = join(root, "repos", `${team.id}.git`);
    const work = join(root, "work", team.id);
    mkdirSync(bare, { recursive: true });
    mkdirSync(work, { recursive: true });
    git(["init", "--bare", "--quiet", `--initial-branch=${defaultBranch}`], bare);
    git(["init", "--quiet", `--initial-branch=${defaultBranch}`], work);
    git(["config", "maintenance.auto", "false"], work);
    const url = `file://${bare}`;
    write(
      work,
      // Stamped with the plugin release in this tree, as /handbook:init stamps the scaffold it
      // writes, so the demo shows what a current team repository records.
      skeletonFiles(team.id, url, null, team.commitPrefix, false, undefined, { reviewers: team.reviewers, labels: team.labels }, plugin.version),
    );
    commitAll(work, "chore: scaffold team skill base");
    for (const skill of team.skills) {
      write(work, {
        [`skills/${skill.slug}/SKILL.md`]: skillMarkdown(skill),
        ...Object.fromEntries(Object.entries(skill.extra ?? {}).map(([f, c]) => [`skills/${skill.slug}/${f}`, c])),
      });
      commitAll(work, `feat(skill): add ${skill.slug}`);
    }
    if (Object.keys(team.mcp).length) {
      write(work, { ".mcp.json": JSON.stringify({ mcpServers: team.mcp }, null, 2) + "\n" });
      commitAll(work, `feat(mcp): add ${Object.keys(team.mcp).join(", ")}`);
    }
    for (const [name, md] of Object.entries(team.commands)) {
      write(work, { [`commands/${name}.md`]: md });
      commitAll(work, `feat(command): add /${name}`);
    }
    // The bare repository fetches from the work tree, the same move a merge makes on a
    // forge, so the demo never needs a remote that accepts writes.
    git(["fetch", "--quiet", work, `${defaultBranch}:${defaultBranch}`], bare);
    repos.push({ id: team.id, team: team.team, name: team.id, url, memberUrl: url });
  }
  const configFile = join(root, "orchestrator.json");
  writeFileSync(configFile, JSON.stringify({ tenant: "demo", repos }, null, 2) + "\n");
  return { configFile };
}

/**
 * The data directory the demo is seeded for: ORCHESTRATOR_DATA_DIR when set, as the image sets it,
 * and otherwise one of its own under the system's temporary folder, never the person's own
 * orchestrator's data, which a local start would otherwise read from the system's application place.
 */
export function demoDataDir(env: NodeJS.ProcessEnv = process.env, temp: string = tmpdir()): string {
  return env.ORCHESTRATOR_DATA_DIR ? orchestratorDataDir(env) : join(temp, "teamhandbook-orchestrator-demo");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  // The demo lives inside the data directory of the orchestrator that serves it, which is where
  // the image puts it (/data/demo): the seed then takes that orchestrator's own lock first, so it
  // never rewrites repositories a running orchestrator is serving.
  const dataDir = demoDataDir();
  const target = resolve(process.argv[2] ?? join(dataDir, "demo"));
  if (target === dataDir || target.startsWith(dataDir + sep)) {
    try {
      holdDataDir(dataDir, `an orchestrator is running on ${dataDir}; the demo repositories it serves are left as they are`);
    } catch (err) {
      console.error((err as Error).message);
      process.exit(1);
    }
  } else {
    console.error(`${target} is outside ORCHESTRATOR_DATA_DIR (${dataDir}): an orchestrator serving it from another data directory is not detected, so stop that one first`);
  }
  const { configFile } = seed(target);
  const given = Boolean(process.env.ORCHESTRATOR_DATA_DIR);
  console.log(`Seeded two team repositories. Start the orchestrator with ${given ? "" : `ORCHESTRATOR_DATA_DIR=${dataDir} `}ORCHESTRATOR_CONFIG=${configFile}`);
}
