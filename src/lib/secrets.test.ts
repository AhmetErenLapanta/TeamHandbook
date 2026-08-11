import { describe, it, expect } from "vitest";
import { detectSecret } from "./secrets.js";

describe("detectSecret", () => {
  it.each([
    ["private-key", "-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA"],
    ["aws-access-key", "aws configure set key AKIAIOSFODNN7EXAMPLE"],
    [
      "jwt",
      "curl -H 'auth: eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV'",
    ],
    ["github-token", "git clone with ghp_16C7e42F292c6912E7710c838347Ae178B4a"],
    ["gitlab-token", "export GITLAB_TOKEN=glpat-xJ2vRq8kQzWn5pYtBs7d"],
    ["slack-token", "xoxb-1234567890-abcdefghijkl"],
    ["bearer-token", "Authorization: Bearer dGhpcy1pcy1hLXZlcnktbG9uZy10b2tlbg"],
    ["url-credentials", "psql postgres://admin:hunter22@db.internal:5432/prod"],
    ["stripe-key", "STRIPE_KEY=sk_live_abcdef1234567890ABCDEF"],
    ["openai-key", "export OPENAI_API_KEY=sk-proj-abcdef1234567890ABCDEFGH"],
    ["google-api-key", "AIzaSyA1234567890abcdef_ABCDEFGHIJKLMNOP"],
    ["npm-token", "//registry.npmjs.org/:_authToken=npm_abcdefghijklmnopqrstuvwxyz012345"],
    ["basic-auth-header", "Authorization: Basic dXNlcjpwYXNzd29yZA=="],
    ["assigned-secret", "api_key = 'hunter2000plain'"],
    ["assigned-secret", "password: Sup3rS3cret!"],
    // \b cannot match between two word chars, so an underscore-prefixed keyword
    // (the most common env-var leak) must still be caught.
    ["assigned-secret", "AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMIabcd1234"],
  ])("detects %s", (name, text) => {
    expect(detectSecret(text)).toBe(name);
  });

  it.each([
    "Error: 1 test failed at src/app.ts:<n>",
    "TypeError: Cannot read properties of undefined",
    "npm ERR! Invalid token: abc",
    "fatal: repository 'https://github.com/org/repo' not found",
    "warning: token expired, please login again",
    "secret: <redacted>",
  ])("stays silent on normal error text: %s", (text) => {
    expect(detectSecret(text)).toBeNull();
  });
});

describe("armored key variants (regression: only PEM 'PRIVATE KEY' was caught)", () => {
  it.each([
    ["PGP block", "-----BEGIN PGP PRIVATE KEY BLOCK-----"],
    ["putty file header", "PuTTY-User-Key-File-3: ssh-rsa"],
    ["putty private lines", "Private-Lines: 14"],
    ["age secret key", "AGE-SECRET-KEY-1QQPQZRFR9Q0YV2M9DTKZ0T4GSXH7C2XQ5RRAM9NLZ7WQABCDEFGHIJKLMNOP"],
  ])("detects %s", (_label, text) => {
    expect(detectSecret(text)).not.toBeNull();
  });

  it("does not flag a public certificate (not a secret, routine in TLS work)", () => {
    expect(detectSecret("-----BEGIN CERTIFICATE-----")).toBeNull();
  });
});

describe("common credential shapes beyond the generic keyword rule", () => {
  it.each([
    ["a postgres env password", "PGPASSWORD=hunter2 psql -h db"],
    ["a DB_PASS env line", "DB_PASS=s3cr3tvalue"],
    ["curl basic auth", "curl -u admin:letmein https://api.internal/health"],
    ["mysql inline password", "mysql -uroot -psup3rs3cret mydb"],
  ])("detects %s", (_label, text) => {
    expect(detectSecret(text)).not.toBeNull();
  });

  it("does not flag ordinary prose that merely mentions a password", () => {
    expect(detectSecret("the password reset flow is broken, please look at it")).toBeNull();
  });
});
