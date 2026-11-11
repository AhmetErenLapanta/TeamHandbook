import { mkdirSync } from "node:fs";
import { request } from "@playwright/test";
import type { FullConfig } from "@playwright/test";
import { PASSWORD, ROLES, stateFor } from "./roles.js";
import type { RoleName } from "./roles.js";

async function signedIn(baseURL: string, email: string) {
  const ctx = await request.newContext({ baseURL });
  const res = await ctx.post("/api/auth/login", { data: { email, password: PASSWORD } });
  if (!res.ok()) throw new Error(`signing in ${email} failed: ${res.status()} ${await res.text()}`);
  return ctx;
}

export default async function globalSetup(config: FullConfig): Promise<void> {
  const baseURL = config.projects[0]!.use.baseURL!;
  mkdirSync(process.env.ORCHESTRATOR_E2E_STATE_DIR!, { recursive: true });
  const setup = await request.newContext({ baseURL });
  const created = await setup.post("/api/auth/setup", {
    data: { code: process.env.ORCHESTRATOR_E2E_SETUP_TOKEN, email: ROLES.admin.email, name: ROLES.admin.name, password: PASSWORD },
  });
  if (!created.ok()) throw new Error(`creating the first owner failed: ${created.status()} ${await created.text()}`);
  const { csrf } = await (await setup.get("/api/me")).json();
  for (const role of ["orgAdmin", "paymentsOwner", "platformOwner", "member"] as const) {
    const { email, name, role: kind, teams } = ROLES[role];
    const res = await setup.post("/api/users", { data: { email, name, role: kind, teams, password: PASSWORD }, headers: { "x-csrf-token": csrf } });
    if (!res.ok()) throw new Error(`creating ${email} failed: ${res.status()} ${await res.text()}`);
  }
  for (const role of Object.keys(ROLES) as RoleName[]) {
    const ctx = await signedIn(baseURL, ROLES[role].email);
    await ctx.storageState({ path: stateFor(role) });
    await ctx.dispose();
  }
  await setup.dispose();
}
