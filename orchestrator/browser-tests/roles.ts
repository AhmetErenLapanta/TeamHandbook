import { join } from "node:path";

/** The accounts global-setup.ts creates: the first account (an owner), an admin, two team owners who are members, and a member. */
export const PASSWORD = "e2e password long enough";

export const ROLES = {
  admin: { email: "ada@example.invalid", name: "Ada Admin" },
  orgAdmin: { email: "gus@example.invalid", name: "Gus Admin", role: "admin", teams: [] },
  paymentsOwner: { email: "pat@example.invalid", name: "Pat Payments", role: "member", teams: ["Payments"] },
  platformOwner: { email: "lin@example.invalid", name: "Lin Platform", role: "member", teams: ["Platform"] },
  member: { email: "max@example.invalid", name: "Max Member", role: "member", teams: [] },
} as const;

export type RoleName = keyof typeof ROLES;

export function stateFor(role: RoleName): string {
  return join(process.env.ORCHESTRATOR_E2E_STATE_DIR!, `${role}.json`);
}
