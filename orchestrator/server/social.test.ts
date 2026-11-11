import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MICROSOFT_WORK_TENANT, SIGN_IN_PEOPLE, signInClients } from "../lab/cloud.js";
import { startSignInProviders } from "../lab/sign-in-providers.js";
import type { ProviderClient, ProviderName } from "../lab/sign-in-providers.js";
import { socialClientsFromEnv } from "./social.js";
import type { SocialClient, SocialProvider } from "./social.js";

/** Holds a refusal until the test reads it: a rejection not yet awaited while the test awaits something else is reported as unhandled. */
function later<T>(promise: Promise<T>): Promise<T> {
  promise.catch(() => undefined);
  return promise;
}

const ORCHESTRATOR = "http://127.0.0.1:18999";

/** The lab's people, and a work account whose directory set an address Microsoft does not vouch for. */
const PEOPLE = { ...SIGN_IN_PEOPLE, microsoft: [...SIGN_IN_PEOPLE.microsoft, { id: "5c7e9a1b-3d5f-4a7c-8e9b-1a3c5e7f9b2d", name: "Eve Unvouched", email: "eve@aydin-works.example.invalid", verified: false, domain: MICROSOFT_WORK_TENANT }] };

let providers: { base: string; close: () => Promise<void> };
let clients: Record<ProviderName, ProviderClient[]>;
let env: NodeJS.ProcessEnv;

beforeAll(async () => {
  clients = signInClients([ORCHESTRATOR]);
  providers = await startSignInProviders({ port: 0, people: PEOPLE, clients, log: join(mkdtempSync(join(tmpdir(), "sign-in-")), "log") });
  const { base } = providers;
  env = {
    ORCHESTRATOR_SIGN_IN_GOOGLE_CLIENT_ID: clients.google[0]!.id,
    ORCHESTRATOR_SIGN_IN_GOOGLE_CLIENT_SECRET: clients.google[0]!.secret,
    ORCHESTRATOR_SIGN_IN_GOOGLE_ISSUER: `${base}/google`,
    ORCHESTRATOR_SIGN_IN_MICROSOFT_CLIENT_ID: clients.microsoft[0]!.id,
    ORCHESTRATOR_SIGN_IN_MICROSOFT_CLIENT_SECRET: clients.microsoft[0]!.secret,
    ORCHESTRATOR_SIGN_IN_MICROSOFT_ISSUER: `${base}/microsoft/common/v2.0`,
    ORCHESTRATOR_SIGN_IN_GITHUB_CLIENT_ID: clients.github[0]!.id,
    ORCHESTRATOR_SIGN_IN_GITHUB_CLIENT_SECRET: clients.github[0]!.secret,
    ORCHESTRATOR_SIGN_IN_GITHUB_URL: `${base}/github`,
    ORCHESTRATOR_SIGN_IN_GITHUB_API_URL: `${base}/github/api`,
  };
});

afterAll(() => providers.close());

/** The person picks an account on the provider's page, and the provider sends back a code for the state it was given. */
async function consent(client: SocialClient, person: string): Promise<{ code: string; state: string; login: Awaited<ReturnType<SocialClient["start"]>>["login"] }> {
  const { url, login } = await client.start();
  const page = new URL(url);
  const answer = await fetch(`${page.origin}${page.pathname}`, { method: "POST", body: new URLSearchParams({ ...Object.fromEntries(page.searchParams), person }), redirect: "manual" });
  const back = new URL(answer.headers.get("location")!);
  return { code: back.searchParams.get("code")!, state: back.searchParams.get("state")!, login };
}

const person = (provider: SocialProvider, name: string) => PEOPLE[provider].find((p) => p.name === name)!;

async function signIn(provider: SocialProvider, name: string) {
  const client = socialClientsFromEnv(env, ORCHESTRATOR).get(provider)!;
  const { code, state, login } = await consent(client, person(provider, name).id);
  expect(state).toBe(login.state);
  return client.finish(code, login);
}

describe("signing in with a provider", () => {
  it("given a Google account with a verified Workspace address and one Google has not verified, when each signs in, then the first is known by its subject and domain and the second is refused", async () => {
    // when
    const ada = await signIn("google", "Ada Okafor");
    const gus = later(signIn("google", "Gus Unverified"));

    // then
    expect(ada).toEqual({ provider: "google", subject: "104857600123456789012", email: "ada@okafor-labs.example.invalid", name: "Ada Okafor", domain: "okafor-labs.example.invalid" });
    await expect(gus).rejects.toMatchObject({ status: 403, message: expect.stringContaining("has not verified") });
  });

  it("given a work Microsoft account Microsoft vouches for, one whose address it does not, and a personal one, when each signs in, then the first is known by its directory and object id and the others are refused", async () => {
    // when
    const cem = await signIn("microsoft", "Cem Aydin");
    const eve = later(signIn("microsoft", "Eve Unvouched"));
    const dee = later(signIn("microsoft", "Dee Personal"));

    // then
    expect(cem).toEqual({ provider: "microsoft", subject: `${MICROSOFT_WORK_TENANT}:${person("microsoft", "Cem Aydin").id}`, email: "cem@aydin-works.example.invalid", name: "Cem Aydin", domain: MICROSOFT_WORK_TENANT });
    await expect(eve).rejects.toMatchObject({ status: 403, message: expect.stringContaining("does not vouch") });
    await expect(dee).rejects.toMatchObject({ status: 403, message: expect.stringContaining("not personal ones") });
  });

  it("given a GitHub account with a verified primary address and one without, when each signs in, then the first is known by its numeric id with no domain and the second is refused", async () => {
    // when
    const ben = await signIn("github", "Ben Ortiz");
    const nia = later(signIn("github", "Nia Private"));

    // then
    expect(ben).toEqual({ provider: "github", subject: "4401", email: "ben@ortiz-builds.example.invalid", name: "Ben Ortiz", domain: null });
    await expect(nia).rejects.toMatchObject({ status: 403, message: expect.stringContaining("no verified primary address") });
  });

  it("given a code the provider gave out, when it is redeemed with another sign-in's verifier or a second time, then each is refused", async () => {
    // given
    const client = socialClientsFromEnv(env, ORCHESTRATOR).get("google")!;
    const first = await consent(client, person("google", "Ada Okafor").id);
    const other = await client.start();
    const second = await consent(client, person("google", "Ada Okafor").id);

    // when
    const wrongVerifier = later(client.finish(first.code, { nonce: first.login.nonce, verifier: other.login.verifier }));
    await client.finish(second.code, second.login);
    const again = later(client.finish(second.code, second.login));

    // then
    await expect(wrongVerifier).rejects.toMatchObject({ status: 403 });
    await expect(again).rejects.toMatchObject({ status: 403 });
  });

  it("given a provider's id with no secret, an issuer over plain http elsewhere, or none at all, when the orchestrator reads them, then the first two stop it and the last offers no button", () => {
    expect(() => socialClientsFromEnv({ ORCHESTRATOR_SIGN_IN_GOOGLE_CLIENT_ID: "id" }, ORCHESTRATOR)).toThrow("needs ORCHESTRATOR_SIGN_IN_GOOGLE_CLIENT_SECRET");
    expect(() => socialClientsFromEnv({ ORCHESTRATOR_SIGN_IN_GOOGLE_CLIENT_ID: "id", ORCHESTRATOR_SIGN_IN_GOOGLE_CLIENT_SECRET: "s", ORCHESTRATOR_SIGN_IN_GOOGLE_ISSUER: "http://idp.example.invalid" }, ORCHESTRATOR)).toThrow("has to be https");
    expect(socialClientsFromEnv({}, ORCHESTRATOR).size).toBe(0);
  });
});
