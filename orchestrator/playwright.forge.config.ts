import { generateKeyPairSync } from "node:crypto";
import base from "./playwright.config.js";
import type { PlaywrightTestConfig } from "@playwright/test";

// The forge connection end to end: the suite's orchestrator, with a GitLab OAuth application and a
// GitHub App registered against stand-ins on this machine that the spec starts on the ports
// below. Its specs end in .forge.ts so the main suite, whose orchestrator has no application, never
// runs them, and no other spec sees a card that offers one.
const port = Number(process.env.ORCHESTRATOR_E2E_PORT ?? 18196);
export const FORGE_PORTS = { gitlab: port + 1, github: port + 2 };
const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
const server = base.webServer as Exclude<PlaywrightTestConfig["webServer"], undefined | unknown[]>;

export default {
  ...base,
  testMatch: "**/*.forge.ts",
  webServer: server && {
    ...server,
    // The build and the seed come first, and on a loaded machine they take longer than the suite's minute.
    timeout: 240_000,
    env: {
      ...server.env,
      ORCHESTRATOR_FORGE_GITLAB_CLIENT_ID: "stand-in-gitlab-client",
      ORCHESTRATOR_FORGE_GITLAB_CLIENT_SECRET: "stand-in-gitlab-secret",
      ORCHESTRATOR_FORGE_GITLAB_URL: `http://127.0.0.1:${FORGE_PORTS.gitlab}`,
      ORCHESTRATOR_FORGE_GITHUB_APP_ID: "1",
      ORCHESTRATOR_FORGE_GITHUB_APP_SLUG: "teamhandbook-orchestrator",
      ORCHESTRATOR_FORGE_GITHUB_CLIENT_ID: "Iv1.stand-in",
      ORCHESTRATOR_FORGE_GITHUB_CLIENT_SECRET: "stand-in-github-secret",
      ORCHESTRATOR_FORGE_GITHUB_PRIVATE_KEY: privateKey,
      ORCHESTRATOR_FORGE_GITHUB_URL: `http://127.0.0.1:${FORGE_PORTS.github}`,
      ORCHESTRATOR_INTERNAL_FORGE_HOSTS: `127.0.0.1:${FORGE_PORTS.gitlab},127.0.0.1:${FORGE_PORTS.github}`,
    },
  },
} satisfies PlaywrightTestConfig;
