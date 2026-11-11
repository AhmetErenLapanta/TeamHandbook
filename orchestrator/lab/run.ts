import { execFileSync } from "node:child_process";
import type { ExecFileSyncOptions } from "node:child_process";

/**
 * Every process the lab starts gets an environment built here from nothing, never a copy of
 * the caller's: a developer's own tokens, HOME, model credentials or forge sign-in never reach
 * an orchestrator, a forge or a stand-in teammate. PATH is the lab's own, which holds a stand-in
 * claude and no gh, glab or opencode.
 */
export function labEnv(path: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    PATH: path,
    LANG: "C",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    ANTHROPIC_API_KEY: "",
    CLAUDE_CODE_OAUTH_TOKEN: "",
    GITLAB_TOKEN: "",
    GITHUB_TOKEN: "",
    GH_TOKEN: "",
    ...extra,
  };
}

export interface Identity {
  name: string;
  email: string;
}

/** git with no global or system config, as the identity given for both author and committer. */
export function labGit(path: string, args: string[], cwd: string, options: { input?: string; who?: Identity; env?: Record<string, string> } = {}): string {
  const who = options.who ?? { name: "Lab Seed", email: "seed@lab.example.invalid" };
  const exec: ExecFileSyncOptions = {
    cwd,
    encoding: "utf8",
    input: options.input,
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["pipe", "pipe", "pipe"],
    env: labEnv(path, {
      HOME: cwd,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_AUTHOR_NAME: who.name,
      GIT_AUTHOR_EMAIL: who.email,
      GIT_COMMITTER_NAME: who.name,
      GIT_COMMITTER_EMAIL: who.email,
      ...options.env,
    }),
  };
  return (execFileSync("git", args, exec) as string).trim();
}

/** The same git, with a missing object or ref as null rather than an exception. */
export function labGitMaybe(path: string, args: string[], cwd: string): string | null {
  try {
    return labGit(path, args, cwd);
  } catch {
    return null;
  }
}
