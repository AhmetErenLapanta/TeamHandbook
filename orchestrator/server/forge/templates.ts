import type { OrchestratorContext } from "../app.js";
import { mirrorDir } from "../app.js";
import { gitAsyncMaybe } from "../git.js";
import type { RepoRecord } from "../store.js";
import { CAPABILITIES } from "./read-model.js";
import type { HostedForge } from "./read-model.js";

/**
 * The template a team keeps for a request's description, read from the orchestrator's own copy of the
 * repository at the commit it last read, never from a checkout: whoever pushes to the repository
 * writes it, so it is cut at a size that cannot crowd an agent's prompt, and the caller fences it
 * as data like any repository text.
 */
export const TEMPLATE_MAX = 8 * 1024;

/** Larger than this, a template file is not read at all: cutting it would need the whole blob in memory first. */
const BLOB_MAX = 256 * 1024;

export interface RequestTemplate {
  path: string;
  text: string;
  truncated: boolean;
}

/** A path from the forge's list that names one file, or a folder of templates (`dir/*.md`) to take the first of by name. */
function candidates(entries: string[], patterns: string[]): string[] {
  const lower = new Map(entries.map((e) => [e.toLowerCase(), e]));
  const out: string[] = [];
  for (const pattern of patterns) {
    if (!pattern.endsWith("/*.md")) {
      const found = lower.get(pattern.toLowerCase());
      if (found) out.push(found);
      continue;
    }
    const dir = pattern.slice(0, -"*.md".length).toLowerCase();
    out.push(...entries.filter((e) => e.toLowerCase().startsWith(dir) && !e.slice(dir.length).includes("/") && e.toLowerCase().endsWith(".md")).sort());
  }
  return [...new Set(out)];
}

/** The repository's request template for its forge; a repository with no forge tries GitLab's places, then GitHub's. Null when it has none. */
export async function readRequestTemplate(ctx: OrchestratorContext, repo: RepoRecord, forge: HostedForge | null): Promise<RequestTemplate | null> {
  if (!repo.head) return null;
  const dir = mirrorDir(ctx, repo.id);
  const patterns = forge ? CAPABILITIES[forge].templates : [...CAPABILITIES.gitlab.templates, ...CAPABILITIES.github.templates];
  // Only regular files: a symbolic link in the tree would name a path the orchestrator never reads.
  const listing = await gitAsyncMaybe(["ls-tree", "-r", "--full-tree", "-z", repo.head, "--", ".github", ".gitlab", "docs", "pull_request_template.md", "PULL_REQUEST_TEMPLATE.md"], dir);
  if (!listing) return null;
  const files = new Map<string, string>();
  for (const line of listing.split("\0").filter(Boolean)) {
    const match = /^(100644|100755) blob ([0-9a-f]{40,64})\t(.+)$/.exec(line);
    if (match) files.set(match[3]!, match[2]!);
  }
  for (const path of candidates([...files.keys()], patterns)) {
    const blob = files.get(path)!;
    const size = Number(await gitAsyncMaybe(["cat-file", "-s", blob], dir));
    if (!Number.isFinite(size) || size > BLOB_MAX) continue;
    const text = await gitAsyncMaybe(["cat-file", "blob", blob], dir);
    if (text === null || !text.trim()) continue;
    const cut = Buffer.byteLength(text) > TEMPLATE_MAX;
    // Cut on a character, not a byte, so a template in any script ends on a whole letter.
    const kept = cut ? Buffer.from(text).subarray(0, TEMPLATE_MAX).toString("utf8").replace(/�+$/, "") : text;
    return { path, text: kept, truncated: cut };
  }
  return null;
}
