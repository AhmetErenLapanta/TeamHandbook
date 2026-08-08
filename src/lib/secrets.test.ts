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
    ["assigned-secret", "api_key = 'sk-live-abcdef1234567890'"],
    ["assigned-secret", "password: Sup3rS3cret!"],
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
