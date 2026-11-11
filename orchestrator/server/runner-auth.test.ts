import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { checkRunnerSignature, cleanPairingCode, pairingCode, publicKeyOf, signRunnerRequest, SKEW_SECONDS } from "./runner-auth.js";

/** A machine's key pair, its public half as the machine sends it at its claim. */
function machineKeys() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const raw = (publicKey.export({ format: "der", type: "spki" }) as Buffer).subarray(-32).toString("base64url");
  return { privateKey, sent: raw };
}

describe("a pairing code", () => {
  it("given a new code, when a person types it back with other case, spaces or no dashes, then it reads the same, and a made-up one does not", () => {
    // given
    const code = pairingCode();

    // when
    const typed = [code.toLowerCase(), code.replace(/-/g, " "), code.replace(/-/g, "")].map(cleanPairingCode);

    // then
    expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
    expect(new Set(typed)).toEqual(new Set([code.replace(/-/g, "")]));
    expect([cleanPairingCode("ILOU-ILOU-ILOU"), cleanPairingCode("SHORT"), cleanPairingCode(42)]).toEqual([null, null, null]);
  });
});

describe("a machine's signed call", () => {
  it("given a call signed with the machine's key, when the orchestrator checks it, then it passes with its nonce, and the same signature on another path, body, method, key or time does not", () => {
    // given
    const { privateKey, sent } = machineKeys();
    const other = machineKeys();
    const key = publicKeyOf(sent)!;
    const call = { method: "POST", path: "/api/runner/poll", body: JSON.stringify({ wait: 25 }) };
    const now = Date.now();
    const header = signRunnerRequest(privateKey, { ...call, time: Math.floor(now / 1000), nonce: "n0nce-of-sixteen-chars" });

    // when
    const checked = checkRunnerSignature(key, header, call, now);
    const refused = [
      checkRunnerSignature(key, header, { ...call, path: "/api/runner/tasks/x/finish" }, now),
      checkRunnerSignature(key, header, { ...call, body: "{}" }, now),
      checkRunnerSignature(key, header, { ...call, method: "PUT" }, now),
      checkRunnerSignature(publicKeyOf(other.sent)!, header, call, now),
      checkRunnerSignature(key, header, call, now + (SKEW_SECONDS + 1) * 1000),
      checkRunnerSignature(key, undefined, call, now),
    ];

    // then
    expect(checked).toBe("n0nce-of-sixteen-chars");
    expect(refused).toEqual([null, null, null, null, null, null]);
  });

  it("given public keys that are not 32 raw Ed25519 bytes, when they are read, then none is taken", () => {
    expect([publicKeyOf("short"), publicKeyOf(Buffer.alloc(31).toString("base64url")), publicKeyOf(42)]).toEqual([null, null, null]);
  });
});
