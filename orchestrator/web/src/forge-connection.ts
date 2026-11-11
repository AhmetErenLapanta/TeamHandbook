import { useEffect, useState } from "react";
import { call } from "./api";
import type { RepoRecord } from "./api";

/** The forges an organization connects in one click; the server's own names. */
export const APP_FORGES = ["gitlab", "github"] as const;
export type AppForge = (typeof APP_FORGES)[number];
export const FORGE_LABEL: Record<AppForge, string> = { gitlab: "GitLab", github: "GitHub" };

/** `manageUrl`: on GitHub, the installation's page for choosing the repositories the app reaches. */
export interface ForgeConnection { via: "app" | "oauth"; account: string; by: string; at: string; repos: number; problem: string | null; manageUrl?: string | null }
/** The organization's connection to one forge, and whether the operator set that forge's app up at all. */
export interface ForgeConnectionState { connection: ForgeConnection | null; available: boolean; missing: string[] }
export interface ForgeRepo { fullName: string; url: string; connected: string | null; empty: boolean }
export type Visibility = "private" | "internal" | "public";
/** The organization's own GitLab application, where the operator registered none; the secret is never returned. */
export interface GitLabAppState { app: { webUrl: string; clientId: string; by: string; at: string } | null; redirectUri: string | null; operator: boolean }
export type TeamRepoInput = { name: string; team: string; visibility: Visibility; namespace?: string } | { existing: string; team: string };

export const forgeApi = {
  connection: (kind: AppForge) => call<ForgeConnectionState>("GET", `/api/forge/${kind}/connection`),
  /** From the welcome, the forge brings the browser back to it rather than to Integrations. */
  connect: (kind: AppForge, from?: "welcome") => call<{ authorizeUrl: string }>("POST", `/api/forge/${kind}/connect`, from ? { return: from } : {}),
  repos: (kind: AppForge) => call<{ repos: ForgeRepo[] }>("GET", `/api/forge/${kind}/repos`).then((b) => b.repos),
  connectRepo: (kind: AppForge, input: { fullName: string; team: string }) => call<{ repo: RepoRecord }>("POST", `/api/forge/${kind}/repos/connect`, input),
  gitlabApp: () => call<GitLabAppState>("GET", "/api/forge/gitlab/app"),
  setGitlabApp: (input: { url: string; clientId: string; clientSecret: string }) => call<{ app: GitLabAppState["app"] }>("PUT", "/api/forge/gitlab/app", input),
  teamRepo: (kind: AppForge, input: TeamRepoInput) => call<{ repo: RepoRecord; webhook: string }>("POST", `/api/forge/${kind}/team-repo`, input),
};

export type ForgeConnections = Record<AppForge, ForgeConnectionState | null>;

/** Both forges' connections, read only while `enabled`; a forge whose read fails counts as not connected. */
export function useForgeConnections(enabled: boolean): [ForgeConnections | null, () => void] {
  const [states, setStates] = useState<ForgeConnections | null>(null);
  const read = () => {
    if (!enabled) return;
    void Promise.all(APP_FORGES.map((k) => forgeApi.connection(k).catch(() => null))).then(([gitlab, github]) => setStates({ gitlab: gitlab ?? null, github: github ?? null }));
  };
  useEffect(read, [enabled]);
  return [states, read];
}

/** The forge the organization is connected to, GitLab first when both are. */
export function connectedForge(states: ForgeConnections | null): AppForge | null {
  return APP_FORGES.find((k) => states?.[k]?.connection) ?? null;
}
