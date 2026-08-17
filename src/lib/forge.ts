import { execFileSync } from "node:child_process";
import { normalizeRemoteUrl } from "./distill.js";
import { nonInteractiveEnv } from "./init.js";

// Everything that talks to a forge rather than to git: which host a URL belongs to, how
// to open a merge request there, and where to send someone when the CLI for it is
// missing. Shared by publish, which has always delivered skills this way, and by init,
// which now delivers the scaffold the same way.

export function hostFromUrl(url: string): string | null {
  const normalized = normalizeRemoteUrl(url);
  if (!normalized) return null;
  return normalized.slice(0, normalized.indexOf("/"));
}

export type ForgeRunner = (tool: "gh" | "glab", args: string[], cwd: string) => string;

export const FORGE_TIMEOUT_MS = 60_000;

export function runForge(tool: "gh" | "glab", args: string[], cwd: string): string {
  return execFileSync(tool, args, {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
    env: nonInteractiveEnv(),
    timeout: FORGE_TIMEOUT_MS,
  });
}

export function manualPrUrl(repoUrl: string, branch: string): string | null {
  const normalized = normalizeRemoteUrl(repoUrl);
  if (!normalized) return null;
  const host = hostFromUrl(repoUrl);
  if (host && host.includes("github")) {
    return `https://${normalized}/pull/new/${branch}`;
  }
  return `https://${normalized}/-/merge_requests/new?merge_request%5Bsource_branch%5D=${encodeURIComponent(branch)}`;
}

function extractUrl(output: string): string | null {
  return output.match(/https?:\/\/\S+/)?.[0] ?? null;
}

export function openPr(
  repoUrl: string,
  branch: string,
  title: string,
  body: string,
  repoDir: string,
  forge: ForgeRunner,
): { url: string | null; error?: string } {
  const host = hostFromUrl(repoUrl);
  try {
    const out =
      host && host.includes("github")
        ? forge("gh", ["pr", "create", "--head", branch, "--title", title, "--body", body], repoDir)
        : forge(
            "glab",
            ["mr", "create", "--source-branch", branch, "--title", title, "--description", body, "--yes"],
            repoDir,
          );
    return { url: extractUrl(out) };
  } catch (err) {
    // The branch is already pushed, so this is a soft failure (fall back to a manual
    // link) — but surface WHY, so the user isn't left guessing that gh/glab just
    // needs installing or `gh auth login`.
    const e = err as { code?: string; stderr?: string; message?: string };
    const tool = host && host.includes("github") ? "gh" : "glab";
    let reason: string;
    if (e?.code === "ENOENT") reason = `the ${tool} CLI is not installed`;
    else {
      const stderr = typeof e?.stderr === "string" ? e.stderr.trim() : "";
      reason = (stderr ? stderr.split("\n").at(-1)! : String(e?.message ?? err)).slice(0, 160);
    }
    return { url: null, error: reason };
  }
}

