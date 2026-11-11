import { describe, it, expect } from "vitest";
import { skeletonFiles } from "./init.js";
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

describe("a URL whose password is only a variable reference", () => {
  it.each([
    ["a shell variable", 'git remote set-url origin "https://oauth2:${TEAMHANDBOOK_CI_TOKEN}@${CI_SERVER_HOST}/${CI_PROJECT_PATH}.git"'],
    ["a variable whose name carries a digit", "https://oauth2:${OAUTH2_TOKEN}@git.example.com/acme/skills.git"],
    ["a GitHub Actions secret", "url: https://x-access-token:${{ secrets.BUMP_TOKEN }}@github.com/acme/skills.git"],
    ["a GitHub Actions secret written tight", "url: https://x-access-token:${{secrets.BUMP_TOKEN}}@github.com/acme/skills.git"],
    ["a GitHub Actions env value", "url: https://x-access-token:${{env.BUMP_TOKEN}}@github.com/acme/skills.git"],
  ])("given %s, when it is screened, then it is not a credential", (_label, text) => {
    expect(detectSecret(text)).toBeNull();
  });

  it.each([
    ["a literal password", "https://oauth2:s3cr3tvalue@git.example.com/acme/skills.git"],
    ["text before the reference", "https://oauth2:abc${TOKEN}@git.example.com/acme/skills.git"],
    ["text after the reference", "https://oauth2:${TOKEN}x@git.example.com/acme/skills.git"],
    ["a bare shell variable", "https://oauth2:$TOKEN@git.example.com/acme/skills.git"],
    ["a mixed-case token between the braces", "https://oauth2:${Zx9Kq2LmN8vB4tR7yW1pS6dF3gH5jK0a}@gitlab.com/acme/skills.git"],
    ["a hex token between the braces", "https://oauth2:${a94a8fe5ccb19ba61c4c0873d391e987982fbbd3}@gitlab.com/acme/skills.git"],
    ["an upper-case hex token between the braces", "https://oauth2:${A94A8FE5CCB19BA61C4C0873D391E987982FBBD3}@gitlab.com/acme/skills.git"],
    ["a long upper-case run between the braces", "https://oauth2:${KQZWXPRTMNVBLJHGFDSAYUIOPE}@gitlab.com/acme/skills.git"],
    ["a short upper-case token between the braces", "https://oauth2:${K7Q2M9X4ZP}@gitlab.com/acme/skills.git"],
    ["a lower-case name between the braces", "https://oauth2:${token}@gitlab.com/acme/skills.git"],
    ["a token as a CI secret's name", "https://x-access-token:${{secrets.Zx9Kq2LmN8vB4tR7yW1pS6dF3gH5jK0a}}@github.com/acme/skills.git"],
  ])("given %s, when it is screened, then it is still a credential", (_label, text) => {
    expect(detectSecret(text)).toBe("url-credentials");
  });

  it.each([
    ["GitLab", "https://gitlab.com/acme/skills.git", "gitlab.com"],
    ["GitHub", "https://github.com/acme/skills.git", "github.com"],
  ])("given the scaffold with the version-bump job for %s, when each file is screened, then none reads as a secret", (_forge, url, host) => {
    const files = skeletonFiles("acme-skills", url, host, "", true);

    const flagged = Object.entries(files).filter(([, text]) => detectSecret(text) !== null);

    expect(flagged.map(([path]) => path)).toEqual([]);
  });
});
