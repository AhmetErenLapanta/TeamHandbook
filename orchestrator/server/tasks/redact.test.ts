import { describe, expect, it } from "vitest";
import { Redactor } from "./redact.js";

describe("the redaction every task log line passes", () => {
  it("given a repository address with a user and token in an error, when the line is redacted, then the user part is masked and the rest kept", () => {
    const line = new Redactor().line("fatal: unable to access 'https://oauth2:abcd1234efgh@git.example.com/acme/payments-skills.git/': 403");
    expect(line).toBe("fatal: unable to access 'https://***@git.example.com/acme/payments-skills.git/': 403");
  });

  it("given a credential the orchestrator passed to the agent, when it appears in any format, then its value is masked", () => {
    const redactor = new Redactor(["svc-credential-9f8e7d6c5b4a", "short"]);
    expect(redactor.line("using svc-credential-9f8e7d6c5b4a now")).toBe("using [redacted:credential] now");
    expect(redactor.carriesCredential("x svc-credential-9f8e7d6c5b4a")).toBe(true);
    expect(redactor.line("a short word")).toBe("a short word");
  });

  it("given a private key block, when its lines are redacted one by one, then every line from BEGIN to END is withheld", () => {
    const redactor = new Redactor();
    const lines = ["before", "-----BEGIN OPENSSH PRIVATE KEY-----", "b3BlbnNzaC1rZXktdjEAAAAABG5vbmU", "-----END OPENSSH PRIVATE KEY-----", "after"].map((l) => redactor.line(l));
    expect(lines).toEqual(["before", "[redacted:private-key]", "[redacted:private-key]", "[redacted:private-key]", "after"]);
  });
});
