import { describe, expect, it } from "vitest";
import type { Principal } from "./auth.js";
import { MOST } from "./keys.js";
import { SECRET_PROVIDERS } from "./secret-providers.js";
import { secretSettingValue } from "./secret-writes.js";

const OWNER: Principal = { id: "u1", name: "Ada", email: "ada@example.invalid", role: "owner", ownedTeams: [] };
const PAYMENTS = ["task.secret.team.Payments.", "task.secret.repo.payments-skills."];

const refusal = (run: () => unknown) => {
  try {
    run();
    return null;
  } catch (err) {
    return (err as { status: number }).status;
  }
};

describe("a secret a setting takes", () => {
  it("given an owner, when they set a value, an environment reference and a task secret of the setting's own team, then each is kept as written", () => {
    // when
    const kept = [
      secretSettingValue(OWNER, { literal: "npm_abc" }, PAYMENTS),
      secretSettingValue(OWNER, { provider: "env", reference: "TEAMHANDBOOK_SECRET_NPM_TOKEN" }, PAYMENTS),
      secretSettingValue(OWNER, { provider: "vault", reference: "task.secret.team.Payments.NPM_TOKEN" }, PAYMENTS),
    ];

    // then
    expect(kept).toEqual([{ literal: "npm_abc" }, { provider: "env", reference: "TEAMHANDBOOK_SECRET_NPM_TOKEN" }, { provider: "vault", reference: "task.secret.team.Payments.NPM_TOKEN" }]);
  });

  it("given writes that are not a setting's to keep, when each is checked, then a provider not loaded, a reference of the wrong shape, another team's or a non-task secret, a prefix cut mid-name, an extra field, a member and an API key are all refused", () => {
    // given
    const onlyVault = { vault: SECRET_PROVIDERS.vault };

    // when
    const answers = [
      refusal(() => secretSettingValue(OWNER, { provider: "aws", reference: "arn:x" }, PAYMENTS)),
      refusal(() => secretSettingValue(OWNER, { provider: "env", reference: "TEAMHANDBOOK_SECRET_NPM_TOKEN" }, PAYMENTS, onlyVault)),
      refusal(() => secretSettingValue(OWNER, { provider: "env", reference: "ORCHESTRATOR_SECRET_KEY" }, PAYMENTS)),
      refusal(() => secretSettingValue(OWNER, { provider: "vault", reference: "task.secret.team.Platform.NPM_TOKEN" }, PAYMENTS)),
      refusal(() => secretSettingValue(OWNER, { provider: "vault", reference: "forge.token.payments-skills" }, PAYMENTS)),
      refusal(() => secretSettingValue(OWNER, { provider: "vault", reference: "task.secret.team.Payments.NPM_TOKEN" }, ["task.secret.team.Pay"])),
      refusal(() => secretSettingValue(OWNER, { provider: "env", reference: "TEAMHANDBOOK_SECRET_X", literal: "y" }, PAYMENTS)),
      refusal(() => secretSettingValue(OWNER, { literal: "" }, PAYMENTS)),
      refusal(() => secretSettingValue({ ...OWNER, role: "member" }, { literal: "npm_abc" }, PAYMENTS)),
      refusal(() => secretSettingValue({ ...OWNER, key: { id: "k", owner: { kind: "user", id: "u1" }, scopes: MOST, expiresAt: null } }, { literal: "npm_abc" }, PAYMENTS)),
    ];

    // then
    expect(answers).toEqual([400, 400, 400, 400, 400, 400, 400, 400, 403, 403]);
  });
});

describe("a 1Password reference a setting takes", () => {
  it("given an orchestrator that reads the Payments vault, when a setting names an item there and one in another vault, then the first is kept and the second refused as a vault it does not read", () => {
    // given
    const env = { ORCHESTRATOR_1PASSWORD_VAULTS: "Payments, Shared" };

    // when
    const kept = secretSettingValue(OWNER, { provider: "op", reference: "op://Payments/npm/credential" }, PAYMENTS, SECRET_PROVIDERS, env);
    const elsewhere = refusal(() => secretSettingValue(OWNER, { provider: "op", reference: "op://Finance/bank/password" }, PAYMENTS, SECRET_PROVIDERS, env));
    const noneListed = refusal(() => secretSettingValue(OWNER, { provider: "op", reference: "op://Payments/npm/credential" }, PAYMENTS, SECRET_PROVIDERS, {}));

    // then
    expect(kept).toEqual({ provider: "op", reference: "op://Payments/npm/credential" });
    expect([elsewhere, noneListed]).toEqual([400, 400]);
  });
});
