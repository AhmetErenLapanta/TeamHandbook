import { describe, expect, it } from "vitest";
import { helpUrl, legalLinks, readmeUrl } from "./legal.js";

describe("the addresses an orchestrator links for its people", () => {
  it("given the operator's privacy, terms and help addresses, when they are read, then https ones and plain http on this machine are taken, and none set gives none", () => {
    // when
    const set = { ...legalLinks({ ORCHESTRATOR_PRIVACY_URL: "https://pages.example.invalid/privacy", ORCHESTRATOR_TERMS_URL: "http://127.0.0.1:3050/en/terms" }), help: helpUrl({ ORCHESTRATOR_HELP_URL: "https://pages.example.invalid/help" }), readme: readmeUrl({ ORCHESTRATOR_README_URL: "https://pages.example.invalid/readme" }) };
    const unset = { ...legalLinks({}), help: helpUrl({}), readme: readmeUrl({}) };

    // then
    expect(set).toEqual({ privacyUrl: "https://pages.example.invalid/privacy", termsUrl: "http://127.0.0.1:3050/en/terms", help: "https://pages.example.invalid/help", readme: "https://pages.example.invalid/readme" });
    expect(unset).toEqual({ privacyUrl: null, termsUrl: null, help: null, readme: null });
  });

  it("given an address over plain http elsewhere, with a password in it, or none at all, when it is read, then the orchestrator refuses it at start", () => {
    expect(() => helpUrl({ ORCHESTRATOR_HELP_URL: "http://help.example.invalid" })).toThrow("has to be https");
    expect(() => legalLinks({ ORCHESTRATOR_TERMS_URL: "https://user:secret@pages.example.invalid/terms" })).toThrow("carries no user or password");
    expect(() => legalLinks({ ORCHESTRATOR_PRIVACY_URL: "not an address" })).toThrow("is not an address");
  });
});
