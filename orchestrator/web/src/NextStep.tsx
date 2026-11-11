import { here } from "./router";

/** Where a refusal is put right, by the code the orchestrator gives it. */
const WHERE: Record<string, { label: string; to: () => string }> = {
  "no-runner": { label: "See Agent readiness", to: () => here("settings", "agents") },
  "task-budget": { label: "See the task budgets", to: () => here("team") },
  "repo-access": { label: "See where tasks are allowed to run", to: () => here("team") },
  "agent-not-on-machine": { label: "See your machines", to: () => here("settings", "machines") },
};

/**
 * The step after a refusal: a link to the page that puts it right when there is one, and for
 * something only owners and admins may do, who to ask. Nothing when the message says it all.
 */
export function NextStep({ code, status }: { code?: string; status?: number }) {
  const where = code ? WHERE[code] : undefined;
  if (where) return <> <a href={where.to()}>{where.label}</a></>;
  if (status === 403) return <> <span className="muted">Ask an owner or an admin.</span></>;
  return null;
}
