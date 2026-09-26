/**
 * A RED-TEAM CORPUS, not product code. SECURITY.md:100-110 promises that a captured
 * secret is redacted at the persistence boundary, and admits in the same breath that
 * "a secret in an unrecognized format can slip through". The size of that admission was
 * never measured. `secrets.test.ts` exercises 19 of the 20 patterns, but with one line and
 * one context each, so what it measures is that a pattern fires - not whether the credential
 * families a session actually produces have a pattern at all. This file is the population
 * the measurement runs against - corpus A, lines that MUST be caught, and corpus B, lines that look like
 * secrets and must NOT be, because the detector fails closed and a false positive drops
 * an innocent candidate silently.
 *
 * Every value is synthetic and built at runtime from a prefix literal plus a seeded
 * generator. The repository is public and GitHub push protection blocks a diff carrying
 * a format-matching string even when the value is invented, so no line in this file may
 * read as a token on its own: `"ghp_" + gen(...)` is a prefix and a function call, and
 * the contiguous string exists only in memory. The same rule governs the measurement -
 * it prints ids, never values.
 */

/**
 * xorshift32. A repeated character ("a".repeat(36)) would be the obvious way to build a
 * body, and it understates the transcript path: `looksKeyBearing` asks a run to mix case
 * AND digits before it calls it key material, which single-character filler never does.
 * A seeded draw over each family's real alphabet keeps the value deterministic and the
 * shape honest.
 */
function gen(alphabet: string, length: number, seed: number): string {
  let s = seed >>> 0 || 1;
  let out = "";
  for (let i = 0; i < length; i++) {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    out += alphabet[s % alphabet.length];
  }
  return out;
}

const LOWER = "abcdefghijklmnopqrstuvwxyz";
const UPPER = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const DIGIT = "0123456789";
const ALNUM = LOWER + UPPER + DIGIT;
const B64 = ALNUM + "+/";
const B64URL = ALNUM + "-_";
const HEX = "0123456789abcdef";

/**
 * Where the line sits in a session. The same secret reaches the detector through
 * several shapes and only one of them carries a keyword, so a family measured in one
 * context alone cannot tell "the family is recognized" from "the generic `assigned-secret`
 * rule happened to see an `=`".
 */
export type Context =
  | "command"
  | "stderr"
  /** The value quoted and mid-line, rather than bare at the end of the sentence. */
  | "stderr-quoted"
  | "diff"
  | "env-file"
  | "json-field"
  | "config-file"
  | "header"
  /** A structured log or CLI summary line, where the value sits inside a key=value pair. */
  | "log-line"
  /** The three shapes a pasted block arrives in when it lands inside markdown. */
  | "markdown-quote"
  | "markdown-bullet"
  | "markdown-table";

export interface CorpusEntry {
  /** `<family>/<context>`; the only thing the measurement is allowed to print. */
  id: string;
  family: string;
  /** See `FamilySpec.transcriptOnly`. */
  transcriptOnly?: boolean;
  context: Context;
  /** The line as it would appear in a transcript, command or captured error. */
  line: string;
  /** The bare credential inside `line`, so a leak check can look for it verbatim. */
  value: string;
}

interface FamilySpec {
  family: string;
  value: string;
  lines: Partial<Record<Context, string>>;
  /**
   * This family exists to measure the TRANSCRIPT path. It carries no marker and no field
   * name by construction - it is a message SHAPE, not a credential format - so no pattern
   * can name it and the family-level invariant does not apply. What does apply is stricter:
   * every context of such a family must be HELD, because the message-level drop is the only
   * thing standing between it and the model.
   *
   * Held IN THESE SHAPES, which is what the corpus carries and all the assertion can mean. A
   * dump whose base64 happens to contain enough slashes reads as a path to `isBlobRun` and
   * goes through - measured at roughly one in five, in every version including master. That
   * is a known ceiling on the message-level rule, not something this family promises away.
   */
  transcriptOnly?: boolean;
}

function expand(specs: FamilySpec[]): CorpusEntry[] {
  return specs.flatMap(({ family, value, lines, transcriptOnly }) =>
    Object.entries(lines).map(([context, line]) => ({
      id: `${family}/${context}`,
      family,
      context: context as Context,
      line,
      value,
      ...(transcriptOnly ? { transcriptOnly } : {}),
    })),
  );
}

const anthropic = "sk-" + "ant-api03-" + gen(B64URL, 95, 101);
const openaiLegacy = "sk-" + gen(ALNUM, 48, 102);
const openaiProject = "sk-" + "proj-" + gen(B64URL, 74, 103);
const ghClassic = "ghp_" + gen(ALNUM, 36, 104);
const ghFineGrained = "github" + "_pat_" + gen(ALNUM, 22, 105) + "_" + gen(ALNUM, 59, 106);
const glPat = "glpat-" + gen(B64URL, 20, 107);
const glDeploy = "gldt-" + gen(B64URL, 20, 108);
const glRunner = "glrt-" + gen(B64URL, 20, 109);
const awsSecret = gen(B64URL, 40, 110);
const gcpKeyBody = gen(B64, 180, 111);
const gocspx = "GOCSPX-" + gen(B64URL, 28, 112);
const ya29 = "ya29." + gen(B64URL, 120, 113);
const azureAccountKey = gen(B64, 86, 114) + "==";
const azureSas = gen(ALNUM, 40, 115) + "%2F" + gen(ALNUM, 8, 164) + "%3D";
const azureClientSecret = gen(ALNUM, 3, 116) + "8Q~" + gen(B64URL, 34, 117);
const slackBot = "xox" + "b-" + gen(DIGIT, 13, 118) + "-" + gen(ALNUM, 24, 119);
const discordBot = gen(B64URL, 24, 120) + "." + gen(B64URL, 6, 121) + "." + gen(B64URL, 38, 122);
const telegramBot = gen(DIGIT, 10, 123) + ":" + "AA" + gen(B64URL, 33, 124);
const twilioSid = "AC" + gen(HEX, 32, 125);
const twilioToken = gen(HEX, 32, 126);
const sendgrid = "SG." + gen(B64URL, 22, 127) + "." + gen(B64URL, 43, 128);
const stripeLive = "sk" + "_live_" + gen(ALNUM, 24, 129);
const stripeTest = "sk" + "_test_" + gen(ALNUM, 24, 130);
const mailgun = "key-" + gen(HEX, 32, 131);
const npmToken = "npm" + "_" + gen(ALNUM, 36, 132);
const pypi = "pypi-" + gen(B64URL, 84, 133);
const hf = "hf" + "_" + gen(ALNUM, 34, 134);
const digitalOcean = "dop" + "_v1_" + gen(HEX, 64, 135);
const cloudflare = gen(B64URL, 40, 136);
const vault = "hvs." + gen(B64URL, 24, 137);
const doppler = "dp.st." + gen(LOWER, 8, 138) + "." + gen(ALNUM, 40, 139);
const sentrySecret = gen(HEX, 32, 140);
const sentryDsn =
  "https://" + gen(HEX, 32, 163) + ":" + sentrySecret + "@o447951.ingest.sentry.io/1234567";
const supabaseJwt =
  "eyJ" + gen(B64URL, 32, 141) + "." + "eyJ" + gen(B64URL, 60, 142) + "." + gen(B64URL, 43, 143);
const notionNtn = "ntn" + "_" + gen(ALNUM, 43, 144);
const notionSecret = "secret" + "_" + gen(ALNUM, 43, 145);
const linear = "lin" + "_api_" + gen(ALNUM, 40, 146);
const figma = "figd" + "_" + gen(B64URL, 40, 147);
const postman = "PMAK-" + gen(HEX, 24, 148) + "-" + gen(HEX, 34, 149);
const pgPassword = gen(ALNUM, 22, 150);
const mysqlPassword = gen(ALNUM, 18, 151);
const mongoPassword = gen(ALNUM, 20, 152);
const redisPassword = gen(ALNUM, 24, 153);
const netrcPassword = gen(ALNUM, 20, 154);
const dockerAuth = gen(B64, 44, 155) + "=";
const kubeClientKey = gen(B64, 120, 156) + "==";
const pgpBody = gen(B64, 120, 157);
const sshBody = gen(B64, 120, 158);
const ageKey = "AGE-SECRET-KEY-1" + gen(UPPER + DIGIT, 58, 159);
const puttyBody = gen(B64, 60, 160);
// The authentication tag at the end of a .ppk, which PuTTY writes in upper case.
const puttyMac = gen("0123456789ABCDEF", 32, 610);
const genericApiKey = gen(ALNUM, 40, 161);
const genericToken = gen(ALNUM, 40, 162);

/** Wrap a body the way a PEM writer, a narrow terminal or a paste does. */
function wrap(body: string, width: number): string {
  return body.match(new RegExp(`.{1,${width}}`, "g"))!.join("\n");
}

/** The same, with every line carrying a `git diff` or `cat -n` prefix. */
function prefixLines(text: string, prefix: (i: number) => string): string {
  return text
    .split("\n")
    .map((line, i) => prefix(i) + line)
    .join("\n");
}

// A key body short enough that the whole entry stays inside the 1000-character slice budget
// and long enough to survive being wrapped: 560 characters is 20 lines at a 28-column wrap.
const wrappedBody = gen(B64, 560, 200);
const decoyValue = gen(ALNUM, 10, 201) + "changeme" + gen(ALNUM, 22, 202);
const placeholderNeighbour = "ghp" + "_" + gen(ALNUM, 36, 203);
// A real Subresource Integrity digest is an exact length; this one is not, which is the
// point of the entry that hides a key behind the prefix.
const realSha512 = gen(B64, 86, 204) + "==";
// The access key id that turns a shapeless 40-character run into an AWS secret.
const awsSecretNeighbourId = "AKIA" + gen(UPPER + DIGIT, 16, 205);
const caCertData = gen(B64, 120, 206) + "==";
const awsCsvSecret = gen(B64, 40, 207);
const innocentIds = Array.from({ length: 6 }, (_, i) => gen(ALNUM, 20, 210 + i));
const innocentHex = Array.from({ length: 6 }, (_, i) => gen(HEX, 32, 220 + i));
// 28 characters, mixed case: the longest identifier column a session is likely to print,
// and the shape closest to the wrap rule's 24-character floor.
const longIds = Array.from({ length: 5 }, (_, i) => gen(ALNUM, 28, 260 + i));
const placeholderTail = gen(ALNUM, 30, 270);
// No marker of any kind: the generic keyword rule is the only thing that can see this one,
// which is what makes it a test of that rule and not of some prefix that claims it first.
const shapelessSecret = gen(ALNUM, 32, 280);
// Base64 may open with a slash (the JPEG magic is `/9j/`), so the path exclusion must not
// take a leading slash as proof. This value has one and is nothing else like a path.
const slashLeadingSecret = "/" + gen(ALNUM, 39, 290);
// The two shapes the path exclusion was reading as a path: a token that happens to carry a
// second separator, and one that happens to end in something extension-shaped.
const twoSeparatorSecret = "/" + gen(ALNUM, 12, 600) + "/" + gen(ALNUM, 26, 601);
const extensionLikeSecret = "/" + gen(ALNUM, 30, 602) + "." + gen(ALNUM, 6, 603);
// Lowercase and digits only: the mixed-case body the other placeholder family carries is
// what a generator produces, not what a hand-written `.env` line holds.
const lowercasePlaceholderLead = "example" + gen(LOWER + DIGIT, 30, 300);
// Ragged on purpose: a list of identifiers is not a wrap, and the lengths are what say so.
const identifierList = [
  "AcmeGatewayServiceFactory7",
  "PaymentRouterConfigLoader42",
  "InvoiceBatchScheduler99x",
  "LedgerReconcileWorker128",
];
// `sha256sum | base64` prints one padded digest per line - a column of separate values.
const digestColumn = Array.from({ length: 5 }, (_, i) => gen(B64, 43, 400 + i) + "=");
// 32 bytes is the most common secret size there is, and its base64 is 43 characters plus one
// `=`. Slashes are left out of the alphabet so these measure the message-level rule rather
// than `isBlobRun`'s path guard, which a run carrying three of them trips on its own.
const dumpKey = (i: number) => gen(ALNUM, 43, 500 + i) + "=";
const realSha256 = gen(B64, 43, 230) + "=";
// Derived from the file format itself, not from memory: a PNG always starts 0x89 "PNG".
// 15 bytes, a multiple of 3, so the magic carries no `=` padding of its own - a real data
// URI is one continuous base64 stream and pads only at its end.
const pngMagic = Buffer.from("89504e470d0a1a0a0000000d494844", "hex").toString("base64");

/**
 * Corpus A. `stderr` and `diff` are the keyword-free contexts on purpose: they carry the
 * value with no `api_key=` next to it, so a family caught only there is caught by its own
 * pattern, and a family caught only in `env-file` is caught by the generic backstop.
 */
export const CORPUS_A: CorpusEntry[] = expand([
  {
    family: "anthropic-api-key",
    value: anthropic,
    lines: {
      command: `claude --api-key ${anthropic} -p "summarize"`,
      stderr: `Error: authentication_error - invalid credential ${anthropic}`,
      "env-file": `ANTHROPIC_API_KEY=${anthropic}`,
    },
  },
  {
    family: "openai-legacy-key",
    value: openaiLegacy,
    lines: {
      stderr: `openai.AuthenticationError: Incorrect credential provided: ${openaiLegacy}`,
      diff: `+const openai = createOpenAI("${openaiLegacy}");`,
    },
  },
  {
    family: "openai-project-key",
    value: openaiProject,
    lines: {
      "env-file": `OPENAI_API_KEY=${openaiProject}`,
      stderr: `401 Unauthorized while presenting ${openaiProject}`,
    },
  },
  {
    family: "github-classic-pat",
    value: ghClassic,
    lines: {
      command: `git remote set-url origin https://${ghClassic}@github.com/acme/api.git`,
      stderr: `remote: Support for password authentication was removed; ${ghClassic} rejected`,
      "env-file": `GITHUB_TOKEN=${ghClassic}`,
    },
  },
  {
    family: "github-fine-grained-pat",
    value: ghFineGrained,
    lines: {
      stderr: `remote: Permission denied for ${ghFineGrained}`,
      "config-file": `  Authorization = ${ghFineGrained}`,
    },
  },
  {
    family: "gitlab-pat",
    value: glPat,
    lines: {
      command: `glab auth login --hostname gitlab.com --token ${glPat}`,
      stderr: `GET https://gitlab.com/api/v4/user: 401 with ${glPat}`,
    },
  },
  {
    family: "gitlab-deploy-token",
    value: glDeploy,
    lines: {
      stderr: `fatal: could not read Password for deploy user: ${glDeploy}`,
      diff: `+  registry.login("deploy", "${glDeploy}");`,
    },
  },
  {
    family: "gitlab-runner-token",
    value: glRunner,
    lines: {
      command: `gitlab-runner register --url https://gitlab.com --registration-token ${glRunner}`,
      stderr: `ERROR: Registering runner... failed runner=${glRunner}`,
    },
  },
  {
    family: "aws-secret-access-key",
    value: awsSecret,
    lines: {
      stderr: `SignatureDoesNotMatch: signature computed from ${awsSecret}`,
      "config-file": `aws_secret_access_key = ${awsSecret}`,
    },
  },
  {
    family: "gcp-service-account-private-key",
    value: gcpKeyBody,
    lines: {
      "json-field": `  "private_key": "-----BEGIN PRIVATE KEY-----\\n${gcpKeyBody}\\n-----END PRIVATE KEY-----\\n",`,
      stderr: `google.auth.exceptions.RefreshError: signing failed for ${gcpKeyBody}`,
      // the same field with the armor stripped, which is how a key arrives once it has been
      // pasted through a form or normalized by a config loader
      "config-file": `  "private_key": "${gcpKeyBody}",`,
    },
  },
  {
    family: "google-oauth-client-secret",
    value: gocspx,
    lines: {
      "json-field": `    "client_secret": "${gocspx}",`,
      stderr: `invalid_client: Unauthorized, presented ${gocspx}`,
    },
  },
  {
    family: "google-oauth-access-token",
    value: ya29,
    lines: {
      header: `Authorization: Bearer ${ya29}`,
      stderr: `Request had invalid authentication credentials: ${ya29}`,
    },
  },
  {
    family: "azure-storage-connection-string",
    value: azureAccountKey,
    lines: {
      "env-file": `AZURE_STORAGE_CONNECTION_STRING=DefaultEndpointsProtocol=https;AccountName=acmeprod;AccountKey=${azureAccountKey};EndpointSuffix=core.windows.net`,
      stderr: `AuthenticationFailed: server failed to authenticate, AccountKey=${azureAccountKey}`,
    },
  },
  {
    family: "azure-sas-signature",
    value: azureSas,
    lines: {
      command: `curl "https://acmeprod.blob.core.windows.net/x/y?sv=2022-11-02&ss=b&srt=sco&sp=rwd&sig=${azureSas}"`,
      stderr: `Signature did not match: sig=${azureSas}`,
    },
  },
  {
    family: "azure-ad-client-secret",
    value: azureClientSecret,
    lines: {
      stderr: `AADSTS7000215: Invalid client credential provided: ${azureClientSecret}`,
      diff: `+  credential: "${azureClientSecret}",`,
    },
  },
  {
    family: "slack-bot-token",
    value: slackBot,
    lines: {
      command: `curl -X POST -H "Authorization: Bearer ${slackBot}" https://slack.com/api/chat.postMessage`,
      stderr: `{"ok":false,"error":"invalid_auth"} for ${slackBot}`,
    },
  },
  {
    family: "discord-bot-token",
    value: discordBot,
    lines: {
      "env-file": `DISCORD_BOT_TOKEN=${discordBot}`,
      stderr: `DiscordAPIError[0]: 401: Unauthorized, bot ${discordBot}`,
    },
  },
  {
    family: "telegram-bot-token",
    value: telegramBot,
    lines: {
      command: `curl https://api.telegram.org/bot${telegramBot}/sendMessage`,
      stderr: `Unauthorized: bot ${telegramBot} was not found`,
    },
  },
  {
    family: "twilio-auth-token",
    value: twilioToken,
    lines: {
      command: `twilio api:core:messages:create --account-sid ${twilioSid} --auth-token ${twilioToken}`,
      stderr: `HTTP 401 from Twilio, account ${twilioSid} presented ${twilioToken}`,
    },
  },
  {
    family: "sendgrid-api-key",
    value: sendgrid,
    lines: {
      header: `Authorization: Bearer ${sendgrid}`,
      stderr: `The provided authorization grant is invalid: ${sendgrid}`,
    },
  },
  {
    family: "stripe-live-key",
    value: stripeLive,
    lines: {
      stderr: `Invalid API Key provided: ${stripeLive}`,
      diff: `+const stripe = new Stripe("${stripeLive}");`,
    },
  },
  {
    family: "stripe-test-key",
    value: stripeTest,
    lines: {
      command: `stripe listen --forward-to localhost:4242 --api-key ${stripeTest}`,
      stderr: `No such customer: cus_123; using ${stripeTest}`,
    },
  },
  {
    family: "mailgun-api-key",
    value: mailgun,
    lines: {
      command: `curl -s --user api:${mailgun} https://api.mailgun.net/v3/acme.org/messages`,
      stderr: `Forbidden: credentials ${mailgun} rejected`,
    },
  },
  {
    family: "npm-auth-token",
    value: npmToken,
    lines: {
      "config-file": `//registry.npmjs.org/:_authToken=${npmToken}`,
      stderr: `npm ERR! 401 Unauthorized - GET https://registry.npmjs.org/@acme/api - ${npmToken}`,
    },
  },
  {
    family: "pypi-upload-token",
    value: pypi,
    lines: {
      "config-file": `password = ${pypi}`,
      stderr: `HTTPError: 403 Invalid or non-existent authentication information: ${pypi}`,
    },
  },
  {
    family: "huggingface-token",
    value: hf,
    lines: {
      command: `huggingface-cli login --token ${hf}`,
      stderr: `Invalid user credential: ${hf}`,
    },
  },
  {
    family: "digitalocean-token",
    value: digitalOcean,
    lines: {
      command: `doctl auth init --access-token ${digitalOcean}`,
      stderr: `Error: GET https://api.digitalocean.com/v2/account: 401 Unable to authenticate you ${digitalOcean}`,
    },
  },
  {
    family: "cloudflare-api-token",
    value: cloudflare,
    lines: {
      header: `Authorization: Bearer ${cloudflare}`,
      stderr: `{"code":10000,"message":"Authentication error"} for ${cloudflare}`,
    },
  },
  {
    family: "vault-service-token",
    value: vault,
    lines: {
      command: `vault login ${vault}`,
      stderr: `Error authenticating: permission denied for ${vault}`,
    },
  },
  {
    family: "doppler-service-token",
    value: doppler,
    lines: {
      "env-file": `DOPPLER_TOKEN=${doppler}`,
      stderr: `Doppler Error: Invalid Service token ${doppler}`,
    },
  },
  {
    family: "sentry-dsn-with-secret",
    value: sentrySecret,
    lines: {
      diff: `+Sentry.init({ dsn: "${sentryDsn}" });`,
      stderr: `Sentry responded with 403 for ${sentryDsn}`,
    },
  },
  {
    family: "supabase-service-role-jwt",
    value: supabaseJwt,
    lines: {
      "env-file": `SUPABASE_SERVICE_ROLE_KEY=${supabaseJwt}`,
      stderr: `JWSError JWSInvalidSignature for ${supabaseJwt}`,
    },
  },
  {
    family: "notion-integration-token",
    value: notionNtn,
    lines: {
      header: `Authorization: Bearer ${notionNtn}`,
      stderr: `API token is invalid: ${notionNtn}`,
    },
  },
  {
    family: "notion-legacy-secret",
    value: notionSecret,
    lines: {
      stderr: `unauthorized: the bearer ${notionSecret} is not valid`,
      diff: `+const notion = new Client({ auth: "${notionSecret}" });`,
    },
  },
  {
    family: "linear-api-key",
    value: linear,
    lines: {
      header: `Authorization: ${linear}`,
      stderr: `Authentication required, not authenticated: ${linear}`,
    },
  },
  {
    family: "figma-personal-token",
    value: figma,
    lines: {
      header: `X-Figma-Token: ${figma}`,
      stderr: `{"status":403,"err":"Invalid token"} for ${figma}`,
    },
  },
  {
    family: "postman-api-key",
    value: postman,
    lines: {
      header: `X-Api-Key: ${postman}`,
      stderr: `Invalid API Key. Every request requires a valid API Key: ${postman}`,
    },
  },
  {
    family: "postgres-url-password",
    value: pgPassword,
    lines: {
      command: `psql postgres://acme_app:${pgPassword}@db.internal:5432/prod -c 'select 1'`,
      stderr: `connection to server failed: postgres://acme_app:${pgPassword}@db.internal:5432/prod`,
    },
  },
  {
    family: "mysql-url-password",
    value: mysqlPassword,
    lines: {
      "env-file": `DATABASE_URL=mysql://root:${mysqlPassword}@127.0.0.1:3306/acme`,
      stderr: `Access denied for user 'root'@'localhost' using ${mysqlPassword}`,
    },
  },
  {
    family: "mongodb-url-password",
    value: mongoPassword,
    lines: {
      command: `mongosh "mongodb+srv://acme:${mongoPassword}@cluster0.abcde.mongodb.net/prod"`,
      stderr: `MongoServerError: bad auth : authentication failed for ${mongoPassword}`,
    },
  },
  {
    family: "redis-url-password",
    value: redisPassword,
    lines: {
      command: `redis-cli -u redis://default:${redisPassword}@cache.internal:6379 ping`,
      stderr: `WRONGPASS invalid username-password pair: ${redisPassword}`,
    },
  },
  {
    family: "netrc-credential",
    value: netrcPassword,
    lines: {
      "config-file": `machine api.acme.org login deploybot password ${netrcPassword}`,
      // the file as a diff shows it: the rule may never go back to a start-of-line anchor,
      // which is the mistake `putty-key` already made
      diff: `+machine api.acme.org login deploybot password ${netrcPassword}`,
      stderr: `could not read Password for 'https://deploybot@api.acme.org': ${netrcPassword}`,
    },
  },
  {
    family: "docker-config-auth",
    value: dockerAuth,
    lines: {
      "json-field": `  "auths": { "registry.acme.org": { "auth": "${dockerAuth}" } }`,
      stderr: `unauthorized: authentication required for ${dockerAuth}`,
    },
  },
  {
    family: "kubeconfig-client-key-data",
    value: kubeClientKey,
    lines: {
      "config-file": `    client-key-data: ${kubeClientKey}`,
      stderr: `error: tls: failed to parse private key ${kubeClientKey}`,
    },
  },
  {
    family: "pgp-private-key-block",
    value: pgpBody,
    lines: {
      diff: `+-----BEGIN PGP PRIVATE KEY BLOCK-----\n+\n+${pgpBody}\n+-----END PGP PRIVATE KEY BLOCK-----`,
      stderr: `gpg: error reading the armor of the imported material ${pgpBody}`,
    },
  },
  {
    family: "ssh-private-key-pem",
    value: sshBody,
    lines: {
      diff: `+-----BEGIN OPENSSH PRIVATE KEY-----\n+${sshBody}\n+-----END OPENSSH PRIVATE KEY-----`,
      stderr: `Load key "/srv/deploy/id_ed25519": error in libcrypto, body was ${sshBody}`,
      // A key body hiding behind an integrity prefix: the exemption that stops a lockfile
      // line from dropping a message must not become a way to smuggle one past it.
      "config-file": `  "integrity": "sha512-${sshBody}=="`,
    },
  },
  {
    family: "age-secret-key",
    value: ageKey,
    lines: {
      "config-file": `${ageKey}`,
      stderr: `age: error: failed to parse identity ${ageKey}`,
    },
  },
  {
    family: "putty-private-key",
    value: puttyBody,
    lines: {
      "config-file": `PuTTY-User-Key-File-3: ssh-rsa\nEncryption: none\nPrivate-Lines: 14\n${puttyBody}`,
      stderr: `PuTTY Fatal Error: Couldn't load private key ${puttyBody}`,
    },
  },
  /**
   * The authentication tag at the end of a .ppk. The corpus only ever showed the line-count
   * header, so the tag went unmeasured - and PuTTY writes it in upper case, which a rule
   * asking for lower-case hex silently stopped seeing.
   */
  {
    family: "putty-private-key",
    value: puttyMac,
    lines: {
      "log-line": `Private-MAC: ${puttyMac}`,
      header: `Private-Lines: 14\nPrivate-MAC: ${puttyMac}`,
    },
  },

  {
    family: "generic-assigned-api-key",
    value: genericApiKey,
    lines: {
      "env-file": `ACME_API_KEY=${genericApiKey}`,
      stderr: `Provider rejected the configured value ${genericApiKey}`,
    },
  },
  {
    family: "generic-assigned-token",
    value: genericToken,
    lines: {
      "config-file": `  token: ${genericToken}`,
      diff: `+  headers["X-Acme"] = "${genericToken}";`,
    },
  },

  // ---------------------------------------------------------------------------------
  // Round 2 additions. Existing entries above are untouched so the before/after numbers
  // compare the same lines; everything new arrives as a new context or a new family.
  // ---------------------------------------------------------------------------------

  /**
   * The stderr column was one template - prose then the value bare at the end of the line.
   * A detector keyed on "value at end of line" would have scored the same and been useless,
   * so the same values arrive quoted mid-line and inside a key=value pair.
   */
  {
    family: "anthropic-api-key",
    value: anthropic,
    lines: {
      "stderr-quoted": `Error: the credential "${anthropic}" was rejected by the upstream`,
      "log-line": `level=error msg="auth failed" provider=anthropic credential=${anthropic} retries=3`,
    },
  },
  {
    family: "github-classic-pat",
    value: ghClassic,
    lines: {
      "stderr-quoted": `remote: the credential "${ghClassic}" has expired, generate a new one`,
    },
  },
  {
    family: "telegram-bot-token",
    value: telegramBot,
    lines: {
      "stderr-quoted": `Unauthorized: bot "${telegramBot}" was not found, check the id half`,
      "log-line": `ts=2026-09-26T00:00:00Z component=notifier bot=${telegramBot} status=401`,
    },
  },
  {
    family: "twilio-auth-token",
    value: twilioToken,
    lines: {
      "log-line": `sid=${twilioSid} auth=${twilioToken} region=ie1 status=21603`,
    },
  },

  /**
   * The guilty twin for the path exclusion: a real credential that OPENS with a slash. It
   * has no second separator and no extension, so it is not a path and must stay caught.
   */
  {
    family: "slash-leading-credential",
    value: slashLeadingSecret,
    lines: {
      command: `acme-cli login --auth-token ${slashLeadingSecret}`,
      stderr: `401 rejected the credential ${slashLeadingSecret}`,
      diff: `+  configure("${slashLeadingSecret}");`,
    },
  },

  /**
   * The two variants the twin above left out, which is exactly why they escaped: a token
   * that happens to carry a second separator, and one that happens to end in something
   * extension-shaped. Both were caught by the flag rule before the path exclusion existed.
   */
  {
    family: "slash-leading-credential",
    value: twoSeparatorSecret,
    lines: {
      "log-line": `acme-cli login --auth-token ${twoSeparatorSecret}`,
      "stderr-quoted": `401 rejected the credential "${twoSeparatorSecret}"`,
    },
  },
  {
    family: "slash-leading-credential",
    value: extensionLikeSecret,
    lines: {
      "config-file": `acme-cli login --auth-token ${extensionLikeSecret}`,
      "env-file": `ACME_TOKEN=${extensionLikeSecret}`,
    },
  },
  {
    family: "huggingface-token",
    value: hf,
    lines: {
      "stderr-quoted": `Invalid user credential: "${hf}" - log in again`,
    },
  },
  {
    family: "vault-service-token",
    value: vault,
    lines: {
      "log-line": `component=vault-agent client=${vault} lease=none result=denied`,
    },
  },
  {
    family: "netrc-credential",
    value: netrcPassword,
    lines: {
      "stderr-quoted": `could not authenticate deploybot with "${netrcPassword}" against api.acme.org`,
      // A single-label host is a valid entry and the rule does not see it. Recorded rather
      // than fixed: accepting one label brings back the four prose sentences, which cost
      // more and cost it silently. The trade lives here so it stays visible.
      "log-line": `machine localhost login deploybot password ${netrcPassword}`,
    },
  },
  {
    family: "docker-config-auth",
    value: dockerAuth,
    lines: {
      "log-line": `registry=registry.acme.org auth=${dockerAuth} result=denied attempt=2`,
    },
  },
  {
    family: "aws-secret-access-key",
    value: awsSecret,
    lines: {
      "log-line": `awsAccessKeyId=${awsSecretNeighbourId} awsSecretAccessKey=${awsSecret} region=eu-west-1`,
    },
  },
  {
    family: "kubeconfig-client-key-data",
    value: kubeClientKey,
    lines: {
      "stderr-quoted": `error: the client certificate "${kubeClientKey}" could not be parsed`,
    },
  },

  /**
   * The PuTTY rule is anchored to the start of a line, so the same header inside a diff or a
   * `cat -n` listing - the two shapes a session actually shows a key file in - slips past it.
   */
  {
    family: "putty-private-key",
    value: puttyBody,
    lines: {
      diff: `+PuTTY-User-Key-File-3: ssh-rsa\n+Private-Lines: 14\n+${puttyBody}`,
      command: `     1\tPuTTY-User-Key-File-3: ssh-rsa\n     2\tPrivate-Lines: 14\n     3\t${puttyBody}`,
    },
  },

  /**
   * A key body whose VALUE spans lines. Nothing above measured this: `redactSlice` is a
   * stateless per-line pass, so the only thing that can hold a wrapped body is
   * `looksKeyBearing` dropping the whole message - and its run thresholds are per line.
   */
  {
    family: "wrapped-key-body",
    value: wrappedBody,
    lines: {
      diff: `+-----BEGIN OPENSSH PRIVATE KEY-----\n${prefixLines(wrap(wrappedBody, 64), () => "+")}\n+-----END OPENSSH PRIVATE KEY-----`,
      "config-file": wrap(wrappedBody, 28),
      "json-field": `  "private_key": "-----BEGIN PRIVATE KEY-----\\n${wrap(wrappedBody, 64).split("\n").join("\\n")}\\n-----END PRIVATE KEY-----\\n",`,
      command: prefixLines(wrap(wrappedBody, 40), (i) => `     ${i + 1}\t`),
      "log-line": `added 1 package, integrity sha512-${realSha512}\n${wrap(wrappedBody, 28)}`,
      // The same body pasted into markdown. The rule used to strip a diff sign and a
      // `cat -n` number and nothing else, so a quote, a bullet or a table cell carried the
      // body straight through.
      "markdown-quote": prefixLines(wrap(wrappedBody, 28), () => "> "),
      "markdown-bullet": prefixLines(wrap(wrappedBody, 28), () => "* "),
      "markdown-table": prefixLines(wrap(wrappedBody, 28), () => "| "),
    },
  },

  /**
   * The credentials CSV the AWS console hands out. The secret sits in its own column with
   * the access key id beside it and the header row's "Secret access key" spelled with
   * spaces, so nothing on the value's own line is a keyword the generic rule can key on.
   */
  {
    family: "aws-credentials-csv",
    value: awsCsvSecret,
    lines: {
      "config-file": `User name,Password,Access key ID,Secret access key\ndeploybot,,${awsSecretNeighbourId},${awsCsvSecret}`,
      diff: `+deploybot,,${awsSecretNeighbourId},${awsCsvSecret}`,
    },
  },

  /**
   * A placeholder standing next to a real credential in the same text. The exclusion that
   * stops `api_key=xxxxxxxx` from dropping a candidate has to run per MATCH: a rule that
   * looks at the first hit and gives up fails open on exactly this shape.
   *
   * This pair alone does NOT measure that. A `ghp_` value is claimed by `github-token` long
   * before the keyword rule runs - the same shadowing that hides one family behind another's
   * prefix - so the reject is never reached. It stays because the shape is realistic; the
   * family below is the one that reaches the reject.
   */
  {
    family: "placeholder-beside-real-secret",
    value: placeholderNeighbour,
    lines: {
      "config-file": `api_key = xxxxxxxxxxxxxxxx\napi_key = ${placeholderNeighbour}`,
      diff: `+  // was xxxxxxxxxxxxxxxx, now ${placeholderNeighbour}`,
    },
  },

  /**
   * A secret DUMP: three 32-byte keys, which is what `kubectl get secret -o yaml` prints and
   * what a `.env` holds. Nothing names them - `signing-key:` is in no keyword list - so the
   * message-level drop is the only thing between them and `claude -p`, and a rule that read
   * their padding as "a column of separate values" handed all three over. Every context here
   * must be HELD.
   */
  {
    family: "secret-dump",
    value: dumpKey(1),
    transcriptOnly: true,
    lines: {
      "config-file": `apiVersion: v1\nkind: Secret\ndata:\n  signing-key: ${dumpKey(1)}\n  session-key: ${dumpKey(2)}\n  webhook-key: ${dumpKey(3)}`,
      "env-file": `SIGNING_KEY=${dumpKey(1)}\nSESSION_KEY=${dumpKey(2)}\nWEBHOOK_KEY=${dumpKey(3)}`,
      stderr: `here are the three keys we rotate every quarter\n${dumpKey(1)}\n${dumpKey(2)}\n${dumpKey(3)}\nrotate them together or the session store breaks`,
    },
  },

  /**
   * The same shape with a value no other pattern can claim, so `assigned-secret` is the rule
   * under test and its reject really runs. Measured: with a first-match-only reject this
   * returns null and the credential is written, because the placeholder is the first match
   * and the secret is the second.
   */
  {
    family: "placeholder-beside-a-shapeless-secret",
    value: shapelessSecret,
    lines: {
      "config-file": `api_key = xxxxxxxxxxxxxxxx\napi_key = ${shapelessSecret}`,
      "env-file": `ACME_TOKEN=changeme\nACME_TOKEN=${shapelessSecret}`,
      diff: `+  client.configure("${shapelessSecret}");`,
    },
  },

  /**
   * A real credential that merely CONTAINS a placeholder word. The exclusion is anchored to
   * the whole value for this reason; a substring test would drop it.
   */
  {
    family: "assigned-secret-containing-a-placeholder-word",
    value: decoyValue,
    lines: {
      "env-file": `ACME_API_KEY=${decoyValue}`,
      diff: `+  client.authenticate("${decoyValue}");`,
    },
  },

  /**
   * And one that STARTS with a placeholder word. A prefix test would drop it; the exclusion
   * is anchored to the whole value, and the body's mixed case is what ends the word.
   */
  {
    family: "assigned-secret-starting-with-a-placeholder-word",
    value: "example" + placeholderTail,
    lines: {
      "config-file": `  api_key: example${placeholderTail}`,
      diff: `+  client.authenticate("example${placeholderTail}");`,
    },
  },

  /**
   * The same shape with a LOWERCASE body, which is the half the mixed-case entry above
   * cannot see: an unbounded placeholder tail swallows any number of lowercase characters,
   * so a real key that merely opens with "example" was exempted and written raw.
   */
  {
    family: "assigned-secret-starting-with-a-placeholder-word",
    value: lowercasePlaceholderLead,
    lines: {
      "env-file": `ACME_API_KEY=${lowercasePlaceholderLead}`,
      "json-field": `  "api_key": "${lowercasePlaceholderLead}",`,
    },
  },
]);

/**
 * Paths a session prints, none of them a credential. Written out rather than generated: the
 * point of each one is a specific real shape - a camel-cased directory with a year in it, a
 * pnpm virtual store entry, a bundler content hash, a macOS application-support path with a
 * space in it - and a generator would only produce the shapes it was told to.
 *
 * Three entries name a home directory: two spell it `~/`, and one is `/home/build`. Both are
 * stand-in forms - a build account and the tilde - not a machine's own account name.
 *
 * One shape here is NOT measured whole. `cli-credential-flag` reads `\S{16,}`, which stops at
 * the first space, so for the `Application Support` path the value the rule ever sees is
 * `~/Library/Application`. That prefix is what clears the path test; quoting the argument
 * does not change it, because the regex stops at the space either way. A credential-bearing
 * flag whose value contains a space is outside what this rule can read at all.
 */
const REAL_PATHS = [
  "/opt/acme/SecretsProviderV2Config/token",
  "/srv/Build2026Pipeline/credentials.ini",
  "/home/build/.pnpm-store/v3/files/@acme+api-client@1.2.3/index.js",
  "/var/lib/devcontainer/AcmeWorkspace2026/secrets.env",
  "/etc/acme/ServiceAccount2026/key.json",
  "./dist/assets/main.8f3a2b1c9d4e5f6a.js",
  "./build/static/js/runtime.a1B2c3D4e5F6.chunk.js",
  "~/Library/Application Support/AcmeCli2026/config.json",
  "/usr/local/share/AcmeRunner7/etc/agent.conf",
  "/mnt/data/BackupArchive2026Q3/latest.tar",
  "/opt/homebrew/Cellar/openssl@3/3.2.1/bin/openssl",
  "/workspaces/AcmeMonorepo2026/packages/api/.env",
  "/run/user/1000/AcmeAgentSocket2026/agent.sock",
  "/etc/kubernetes/AdmissionWebhook2026/tls.key",
  "/srv/jenkins/workspace/AcmeReleaseJob42/creds",
  "./node_modules/.pnpm/@acme+sdk@2.0.1_react@18.2.0/node_modules/index.js",
  "/opt/acme/ReleaseCandidate2026Build/config.yaml",
  "/data/AcmeTenantStore2026/shard0/keys.db",
  "/etc/ssl/AcmeInternalCA2026/chain.pem",
  "~/Projects/AcmeGateway2026/src/main/resources/app.properties",
  "/var/log/AcmeIngestWorker2026/current.log",
  "/tmp/AcmeBuildScratch2026/artifact.tgz",
];

const CREDENTIAL_FLAGS = ["--auth-token", "--api-key", "--token", "--password"];

/**
 * Corpus B. Lines a session produces every day that carry the SHAPE of a secret. The
 * detector fails closed, so a hit here is not a harmless over-catch: the candidate that
 * contained the line is dropped and nobody is told which line did it.
 */
export const CORPUS_B: Array<{ id: string; line: string }> = [
  { id: "commit-sha-full", line: "0e06d93a1f4b8c2d5e7a9b0c3d6f8a1b2c4d5e6f HEAD -> master" },
  { id: "commit-sha-short", line: "caba13c The current base merged into the field harness" },
  { id: "uuid-v4", line: "session 3f8a1c2d-9b4e-4f7a-8c1d-2e5f6a7b8c9d ended" },
  // The round 1 literal was 90 characters before its padding, a length no hash produces.
  // An exemption bound to the real length would have left it dropped and the entry would
  // have measured nothing.
  { id: "lockfile-integrity", line: `    integrity: "sha512-${realSha512}",` },
  { id: "lockfile-integrity-sha256", line: `    integrity: "sha256-${realSha256}",` },
  {
    id: "docker-image-digest",
    line: "node@sha256:9f2b7c1e4a6d8f0b3c5e7a9d1f3b5c7e9a1d3f5b7c9e1a3d5f7b9c1e3a5d7f9b",
  },
  { id: "base64-image-fragment", line: `src="data:image/png;base64,${pngMagic}${gen(B64, 60, 240)}"` },
  { id: "sk-prefixed-plain-word", line: "the sk-cross-validation-and-scaling step is slow" },
  { id: "url-without-credentials", line: "fetching https://api.acme.org/v2/customers?page=3&per_page=100" },
  { id: "angle-bracket-placeholder", line: "export ACME_TOKEN=<your-token-here>" },
  { id: "x-placeholder", line: "api_key=xxxxxxxxxxxxxxxxxxxx" },
  { id: "redacted-marker", line: "secret: <redacted>" },
  { id: "two-part-jwt-lookalike", line: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0" },
  { id: "password-prose", line: "the password reset flow is broken, please look at it" },
  {
    id: "bearer-documentation",
    line: "send the credential in an Authorization: Bearer header-as-documented-here",
  },
  { id: "fixture-obvious-fake", line: 'password: "changeme123"' },
  { id: "github-actions-secret-ref", line: "        token: ${{ secrets.GITHUB_TOKEN }}" },
  { id: "env-var-indirection", line: "ACME_API_KEY=$ACME_API_KEY" },
  { id: "terraform-sensitive-output", line: "api_token = (sensitive value)" },
  { id: "public-certificate", line: "-----BEGIN CERTIFICATE-----" },
  { id: "public-key-armor", line: "-----BEGIN PUBLIC KEY-----" },
  { id: "akia-prefix-in-prose", line: "the AKIA prefix identifies an access key id, not the secret" },
  { id: "git-remote-url", line: "fatal: repository 'https://github.com/acme/api.git' not found" },
  { id: "npm-401-line", line: "npm ERR! code E401" },
  { id: "kubernetes-pod-name", line: "pod/acme-api-7d9f8b6c5-xk2mq   1/1   Running   0   14h" },
  { id: "webpack-content-hash", line: "dist/main.8f3a2b1c9d4e5f6a.js  248 KiB [emitted] [immutable]" },
  { id: "java-stack-frame", line: "\tat org.acme.api.GatewayService.handle(GatewayService.java:142)" },
  { id: "slack-channel-id", line: "posted to channel C01ABCDEFGH by the release bot" },
  { id: "secret-word-in-prose", line: "the secret is that there is no secret, it just retries" },
  { id: "token-expiry-setting", line: "password_reset_token_expiry = 3600" },
  { id: "iso-timestamp-log", line: "2026-09-26T00:35:46.912Z INFO  request=req_01HZ9QK completed in 412ms" },
  { id: "long-path", line: "/srv/build/workspace/acme/backend/src/main/java/org/acme/api/GatewayService.java" },
  { id: "semver-line", line: "teamhandbook@0.9.3 build: node scripts/build.mjs" },
  { id: "test-name-with-token-word", line: "  ✓ rejects an expired token and asks for a new one (12 ms)" },
  { id: "basic-auth-masked", line: "Authorization: Basic ***" },
  { id: "hex-digest-sha1", line: "a9993e364706816aba3e25717850c26c9cd0d89d  -" },
  { id: "curl-verbose-no-credential", line: "* Connected to api.acme.org (10.0.3.14) port 443 (#0)" },

  // ---------------------------------------------------------------------------------
  // Round 2: one innocent twin per pattern added this round. A new pattern is the
  // cheapest way there is to buy a false positive, and a false positive here is silent -
  // the candidate that carried the line is dropped and nobody is told which line did it.
  // ---------------------------------------------------------------------------------
  { id: "anthropic-prefix-in-prose", line: "keys for this provider start with sk-ant-api03 and run 95 characters" },
  { id: "gitlab-prefixes-in-docs", line: "runner tokens start with glrt- and deploy tokens with gldt-" },
  { id: "huggingface-python-import", line: "from huggingface_hub import hf_hub_download_with_retries_and_cache" },
  { id: "digitalocean-prefix-in-prose", line: "rotate the dop_v1_ personal access token every quarter" },
  { id: "vault-config-filename", line: "reading hvs.config.production.json before starting the agent" },
  // A filename with no dots in it: the prefix alone cannot tell it from a token, the body can.
  // Split like every corpus value - the push-protection scan reads this source and a prefix
  // followed by sixteen contiguous characters is a hit whether or not the line is innocent.
  { id: "vault-snapshot-filename", line: `cp hvs.${"integrationtest"}${"snapshot"} /srv/backups/` },
  // Prose naming the PuTTY header, which is what this repository's own source does.
  { id: "putty-header-named-in-prose", line: "PuTTY keys are not PEM-armored: the body follows a `Private-Lines: N` header." },
  { id: "linear-sdk-identifier", line: "lin_api_client_request_with_backoff(issueId, { retries: 3 })" },
  { id: "telegram-like-job-id", line: "job 1234567890:AAborted after 3 retries, requeued" },
  { id: "azure-secret-shape-too-short", line: "the sample value abc8Q~xyz in the docs is not a real one" },
  { id: "azure-sas-placeholder", line: 'url = "https://acmeprod.blob.core.windows.net/x?sv=2022-11-02&sig=<signature>"' },
  { id: "azure-accountkey-reference", line: "AZURE_STORAGE_CONNECTION_STRING=AccountName=acmeprod;AccountKey=${AZURE_STORAGE_KEY}" },
  { id: "netrc-words-in-prose", line: "the machine that stores your login and password is not this one" },
  // The shape the words-apart twin never measured: `machine`, `login` and `password` in
  // netrc order, one plain word between each, which is ordinary English.
  { id: "netrc-order-in-prose-1", line: "Each machine needs login and password set before the first deploy." },
  { id: "netrc-order-in-prose-2", line: "The machine used login and password from the netrc file, not the keychain." },
  { id: "netrc-order-in-prose-3", line: "On that machine the login and password were cached by the credential helper." },
  { id: "netrc-order-in-prose-4", line: "Every machine gets login and password rotated by the same playbook." },
  // The other half of the vault filename: camel case with a year in it, which passes the
  // body test, so the extension is what has to say "file".
  { id: "vault-archive-filename", line: `cp hvs.${"Backup2026"}${"SnapshotArchive"}.tar /srv/` },
  { id: "docker-auth-empty", line: '  "auths": { "registry.acme.org": { "auth": "" } }' },
  { id: "docker-auth-reference", line: '  "auths": { "registry.acme.org": { "auth": "${DOCKER_AUTH}" } }' },
  // A kubeconfig carries the PUBLIC CA certificate in the field next to the private one.
  { id: "kubeconfig-ca-data", line: `    certificate-authority-data: ${caCertData}` },
  { id: "cli-token-file-flag", line: "npm publish --access public --token-file /etc/ci/npm-token" },
  // BuildKit's own documented usage, and its systemd equivalent: the flag names a FILE.
  { id: "docker-buildkit-secret-src", line: "docker build --secret id=aws,src=/etc/acme/credentials.ini ." },
  { id: "docker-buildx-secret-src", line: "docker buildx build --secret id=npmrc,src=/home/build/.npmrc ." },
  { id: "systemd-creds-secret-path", line: "systemd-creds --secret /run/credentials/acme.service/dbpass cat" },
  { id: "cli-secret-relative-path", line: "acme-cli deploy --secret ./config/production.secrets.yaml" },
  { id: "cli-secret-env-spec", line: "docker build --secret id=npmrc,env=NPM_TOKEN_CI ." },

  /**
   * Twenty-two paths a real session prints, each crossed with four credential flags and with
   * BuildKit's documented `src=` form - 110 lines, none of them a credential. They exist
   * because a rule that tried to tell a path from a token by the SHAPE of its segments read
   * 32 of these as secrets: a camel-cased directory with a year in it, a pnpm virtual store
   * entry, a bundler content hash and a macOS application-support path are all ordinary.
   */
  ...REAL_PATHS.flatMap((path, i) =>
    CREDENTIAL_FLAGS.map((flag, j) => ({
      id: `real-path-after-a-flag-${i + 1}-${j + 1}`,
      line: `acme-cli run ${flag} ${path}`,
    })),
  ),
  ...REAL_PATHS.map((path, i) => ({
    id: `real-path-in-buildkit-src-${i + 1}`,
    line: `docker buildx build --secret id=npm,src=${path} .`,
  })),
  { id: "gcp-private-key-reference", line: '  "private_key": "${GCP_PRIVATE_KEY}",' },
  { id: "aws-secret-masked", line: "aws_secret_access_key = ****************************************" },
  { id: "dummy-value", line: "api_key=dummyvalue" },
  { id: "your-token-value", line: "token: your-token-goes-here" },
  { id: "example-value", line: "password = examplepassword" },
  { id: "placeholder-literal", line: "secret: placeholder" },

  // The wrap rule reads consecutive short base64-ish lines as one blob. These are the
  // column shapes a session prints that are NOT key material.
  { id: "id-column-20-char", line: innocentIds.join("\n") },
  { id: "hex-column-32-char", line: innocentHex.join("\n") },
  {
    id: "wrapped-prose",
    line: "the release notes say\nthat the migration runs\nonce per deployment and\nis idempotent afterwards",
  },
  {
    id: "aligned-markdown-table",
    line: "| service | region | status |\n|---------|--------|--------|\n| api     | euw1   | ok     |\n| worker  | euw1   | ok     |",
  },
  { id: "id-column-28-char", line: longIds.join("\n") },
  /**
   * The two shapes the wrap rule used to read as a key. Both carry a LESSON around the
   * column, which is what makes the loss expensive: the message is replaced whole, so the
   * prose goes with the identifiers.
   */
  {
    id: "prose-around-an-identifier-list",
    line:
      "we never mock the db here, the fixtures are\n" +
      identifierList.join("\n") +
      "\nand that is why the suite is slow",
  },
  { id: "digest-column-from-sha256sum", line: "sha256sum of each artifact, base64:\n" + digestColumn.join("\n") },
  // The markdown shapes themselves, carrying prose rather than a body.
  { id: "markdown-quote-of-prose", line: "> the migration runs once per deployment\n> and is idempotent afterwards\n> so a rerun is safe\n> which is why the job has no guard" },
  { id: "markdown-bullet-list", line: "* rebuild the index before the import\n* run the migration once\n* verify the row count matches\n* then flip the feature flag" },

  /**
   * The rules that key on a FIELD NAME accept any value by design - that is what lets them
   * see a shapeless blob - so the only thing between them and every README that documents
   * the flag is what a stand-in value looks like. These are the lines those READMEs carry,
   * and a false positive on one of them does not just lose a lesson: `queue.ts` and
   * `commands.ts` run the same scan over a skill's files, so a skill whose own docs show
   * `--token <YOUR_TOKEN>` would be refused by `/handbook:share`.
   */
  { id: "cli-flag-angle-placeholder", line: "gh auth login --token <YOUR_PERSONAL_ACCESS_TOKEN>" },
  { id: "cli-flag-env-reference", line: 'claude -p "summarize" --api-key "$ANTHROPIC_API_KEY_FOR_CI"' },
  { id: "cli-flag-caps-placeholder", line: "huggingface-cli login --token YOUR_PERSONAL_ACCESS_TOKEN" },
  {
    id: "netrc-doc-placeholder",
    line: "machine github.com login USERNAME password <PERSONAL_ACCESS_TOKEN>",
  },
  {
    id: "gcp-private-key-instruction",
    line: '  "private_key": "<paste the private_key value from the downloaded file>",',
  },
  { id: "redacted-value", line: "token: redacted" },
];

/**
 * The prefixes a push-protection scan looks for. They live here rather than in the test
 * because the corpus is what builds values from them: the list and the values it splits
 * have to change together. Each is matched as `<prefix>` followed by 16 or more characters
 * from `[A-Za-z0-9-]`, the alphabet the issued tokens use; `_` is left out because every one
 * of these formats runs alphanumerics after its prefix, and including it would make
 * `hf_hub_download` and `lin_api_client` read as tokens.
 */
export const TOKEN_PREFIXES = [
  "ghp_",
  "gho_",
  "ghu_",
  "ghs_",
  "ghr_",
  "github_pat_",
  "glpat-",
  "gldt-",
  "glrt-",
  "sk-ant-",
  "sk-proj-",
  "sk_live_",
  "sk_test_",
  "xoxb-",
  "xoxp-",
  "AKIA",
  "ASIA",
  "AIza",
  "GOCSPX-",
  "ya29.",
  "npm_",
  "pypi-",
  "hf_",
  "dop_v1_",
  "hvs.",
  "ntn_",
  "secret_",
  "lin_api_",
  "figd_",
  "PMAK-",
  "SG.",
  "AGE-SECRET-KEY-1",
  "dp.st.",
  "AccountKey=",
  "client-key-data:",
  "8Q~",
];

/**
 * A release log line carrying an access key id and, 40 characters of lowercase hex later, a
 * commit digest. The id is itself worth redacting, so the question this line answers is not
 * "is it caught" but WHICH rule claims it: the proximity rule must not read the sha1 as the
 * secret half of the pair.
 */
export const AWS_KEY_ID_BESIDE_A_SHA1 = `${awsSecretNeighbourId} deployed ${gen(HEX, 40, 250)}`;
