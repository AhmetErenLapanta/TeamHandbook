// What a visitor meets at the edge, through Caddy over TLS, against a release deploy:local made:
// ready, metrics kept off the edge, the sign-ins a cloud orchestrator does not take (a setup code, a
// password) and reads without one refused, and, with sign-up open, the whole of it: signing up
// with the lab's stand-in Google, creating an organization, and reading /api/me in it as its owner.
// Usage: node deploy/smoke.mjs <public URL> <open|closed>; NODE_EXTRA_CA_CERTS names Caddy's root.
const [base, signUp] = process.argv.slice(2);
if (!base || !["open", "closed"].includes(signUp)) {
  console.error("usage: node deploy/smoke.mjs <public URL> <open|closed>");
  process.exit(2);
}
const origin = new URL(base).origin;
/** One browser's cookies, by host, as the orchestrator and the stand-in providers set them. */
const jar = new Map();

async function call(url, init = {}) {
  const at = new URL(url, base);
  const cookies = jar.get(at.host);
  const json = typeof init.body === "string" && init.body.startsWith("{");
  const res = await fetch(at, {
    ...init,
    headers: { ...(json ? { "content-type": "application/json" } : {}), origin, ...(cookies?.size ? { cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join("; ") } : {}), ...init.headers },
    redirect: "manual",
  });
  for (const set of res.headers.getSetCookie?.() ?? []) {
    const [pair, ...attributes] = set.split(";");
    const [name, ...value] = pair.split("=");
    const held = jar.get(at.host) ?? new Map();
    if (attributes.some((a) => /^\s*(max-age=0|expires=thu, 01 jan 1970)/i.test(a))) held.delete(name.trim());
    else held.set(name.trim(), value.join("="));
    jar.set(at.host, held);
  }
  return res;
}

function step(name, ok, detail = "") {
  console.log(`smoke: ${ok ? "ok  " : "FAIL"} ${name}${detail ? ` (${detail})` : ""}`);
  if (!ok) process.exit(1);
}

const ready = await call("/api/health/ready");
step("ready over TLS", ready.status === 200 && (await ready.json()).ready === true);

const metrics = await call("/metrics");
step("metrics are not served at the edge", metrics.status === 404);

const identityConfig = await (await call("/api/identity/config")).json();
const configured = JSON.stringify({ signupOpen: identityConfig.signupOpen, providers: identityConfig.providers });
if (signUp === "open") step("sign-up is open, with the providers and the policy and terms linked", identityConfig.signupOpen === true && identityConfig.providers?.includes("google"), configured);
else step("sign-up is closed, as the env file says", identityConfig.signupOpen === false, configured);

const refused = (res) => res.status >= 400 && res.status < 500;
const setup = await call("/api/auth/setup", { method: "POST", body: JSON.stringify({ code: "a code from anywhere", email: "owner@example.com", name: "First Owner", password: "a long enough passphrase for the smoke" }) });
step("a setup code is refused", refused(setup), `HTTP ${setup.status}`);
const login = await call("/api/auth/login", { method: "POST", body: JSON.stringify({ email: "owner@example.com", password: "a long enough passphrase for the smoke" }) });
step("a password sign-in is refused", refused(login), `HTTP ${login.status}`);
const tasks = await call("/api/tasks");
step("tasks are not read without a sign-in", refused(tasks), `HTTP ${tasks.status}`);

if (signUp === "open") {
  const start = await call("/api/auth/google/start");
  const authorize = new URL(start.headers.get("location") ?? "about:blank");
  step("Sign up with Google sends the browser to Google", start.status === 302 && authorize.pathname.startsWith("/google/"), `${authorize.origin}${authorize.pathname}`);

  // The stand-in's consent page posts the authorization request back with the person picked.
  const form = new URLSearchParams(authorize.searchParams);
  form.set("person", "104857600123456789012");
  const consent = await call(`${authorize.origin}${authorize.pathname}`, { method: "POST", body: form.toString(), headers: { "content-type": "application/x-www-form-urlencoded" } });
  const callback = consent.headers.get("location") ?? "";
  step("Google sends Ada back to the orchestrator with a code", consent.status === 302 && callback.startsWith(`${origin}/api/auth/google/callback`), `HTTP ${consent.status}`);

  const back = await call(callback);
  step("the orchestrator signs Ada in", back.status === 302 && !(back.headers.get("location") ?? "").includes("error"), `to ${back.headers.get("location")}`);

  const identity = await call("/api/identity");
  const me = identity.status === 200 ? await identity.json() : {};
  step("Ada's identity is Google's verified address", me.identity?.email === "ada@okafor-labs.example.invalid", `HTTP ${identity.status}`);

  const slug = `okafor-${Date.now().toString(36)}`;
  const created = await call("/api/signup/organization", { method: "POST", body: JSON.stringify({ name: "Okafor Labs", slug, acceptTerms: true }), headers: { "x-csrf-token": me.csrf } });
  const org = created.status === 200 ? await created.json() : {};
  step("Ada creates an organization, accepting the terms", org.tenant === slug, `HTTP ${created.status}`);

  const inOrg = await call(`/api/orgs/${slug}/me`);
  const user = inOrg.status === 200 ? (await inOrg.json()).user : {};
  step("/api/me in it names Ada its owner", user?.role === "owner" && user?.email === "ada@okafor-labs.example.invalid", `HTTP ${inOrg.status}`);
}
console.log("smoke: the flow over the edge passed");
