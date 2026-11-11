/**
 * Where the orchestrator's privacy policy and terms of use are, from ORCHESTRATOR_PRIVACY_URL and
 * ORCHESTRATOR_TERMS_URL: the operator's own pages, never an address written here. Shown on the sign-in
 * and signup screens and at the foot of every page when given. A cloud orchestrator takes no new
 * organization without both, since whoever signs up accepts the terms at that moment.
 */
export interface LegalLinks {
  privacyUrl: string | null;
  termsUrl: string | null;
}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

function link(env: NodeJS.ProcessEnv, name: string): string | null {
  const value = env[name]?.trim();
  if (!value) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} is not an address`);
  }
  // Plain http only on this machine, where a landing page is previewed before it is published.
  if (url.protocol !== "https:" && !(url.protocol === "http:" && LOOPBACK.has(url.hostname))) throw new Error(`${name} has to be https (plain http only on this machine)`);
  if (url.username || url.password) throw new Error(`${name} carries no user or password`);
  return url.toString();
}

export function legalLinks(env: NodeJS.ProcessEnv = process.env): LegalLinks {
  return { privacyUrl: link(env, "ORCHESTRATOR_PRIVACY_URL"), termsUrl: link(env, "ORCHESTRATOR_TERMS_URL") };
}

/** Where someone stuck signing up gets help, from ORCHESTRATOR_HELP_URL; null hides the link. */
export function helpUrl(env: NodeJS.ProcessEnv = process.env): string | null {
  return link(env, "ORCHESTRATOR_HELP_URL");
}

/** Where the hosted orchestrator's sign-in page sends someone who wants it on their own machine, from ORCHESTRATOR_README_URL; null leaves the sentence without a link. */
export function readmeUrl(env: NodeJS.ProcessEnv = process.env): string | null {
  return link(env, "ORCHESTRATOR_README_URL");
}
