import { RUNNER_PATHS, RUNNER_PROTOCOL } from "../shared/runner-wire.js";
import { ORG_NAME, addressProblem, cleanAddress, machineKey, runnerUrl, saveProfile } from "./profile.js";
import type { Fetch, RunnerProfile } from "./profile.js";

export interface ConnectInput {
  address: string;
  code: string;
  dataDir: string;
  name: string;
  platform: string;
  fetch?: Fetch;
}

/** Thrown with a sentence the person reads, and nothing of the code or a token in it. */
export class ConnectRefused extends Error {}

async function errorOf(response: Response): Promise<string> {
  const body = (await response.json().catch(() => null)) as { error?: unknown } | null;
  return typeof body?.error === "string" ? body.error : `the orchestrator answered ${response.status}`;
}

/**
 * Pairs this machine with the organization whose one-time code it was given. The orchestrator is
 * asked who it is before anything is sent to it, the key is made here and only its public half
 * leaves, and the token that comes back is kept with the key in a file only this user reads.
 */
export async function connect({ address, code, dataDir, name, platform, fetch: fetchImpl = fetch }: ConnectInput): Promise<RunnerProfile> {
  const problem = addressProblem(address);
  if (problem) throw new ConnectRefused(problem);
  const base = cleanAddress(address);

  const hello = await fetchImpl(runnerUrl(base, RUNNER_PATHS.hello), { redirect: "error" }).catch(() => null);
  if (!hello?.ok) throw new ConnectRefused(`no orchestrator answered at ${base}; check the address and that this machine reaches it`);
  const who = (await hello.json().catch(() => null)) as { protocol?: unknown; org?: unknown } | null;
  if (typeof who?.org !== "string" || typeof who.protocol !== "number") throw new ConnectRefused(`${base} does not answer as an orchestrator`);
  // The name becomes a folder of this machine's: one that is not a plain short name is not taken, before any code is sent.
  if (!ORG_NAME.test(who.org)) throw new ConnectRefused(`${base} answers with an organization name this machine does not take`);
  // The address names its organization; one that answers as another is not where the code was made.
  const named = /\/api\/orgs\/([^/]+)$/.exec(new URL(base).pathname)?.[1];
  if (named !== undefined && decodeURIComponent(named) !== who.org) throw new ConnectRefused(`${base} answers as another organization; copy the command from Settings again`);
  if (who.protocol > RUNNER_PROTOCOL) throw new ConnectRefused("this machine's handbook-orchestrator is older than the orchestrator; update it, then connect again");
  if (who.protocol < RUNNER_PROTOCOL) throw new ConnectRefused("the orchestrator is older than this machine's handbook-orchestrator; ask its operator to update it");

  const key = machineKey();
  const claimed = await fetchImpl(runnerUrl(base, RUNNER_PATHS.claim), {
    method: "POST",
    redirect: "error",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code, name, platform, publicKey: key.publicKey }),
  });
  if (!claimed.ok) throw new ConnectRefused(await errorOf(claimed));
  const { machineId, token } = (await claimed.json()) as { machineId?: unknown; token?: unknown };
  if (typeof machineId !== "string" || typeof token !== "string") throw new ConnectRefused("the orchestrator did not hand this machine its identity");

  const profile: RunnerProfile = { address: base, org: who.org, machineId, token, privateKey: key.privateKey };
  saveProfile(dataDir, profile);
  return profile;
}
