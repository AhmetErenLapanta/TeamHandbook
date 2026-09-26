import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { detectSecret } from "./secrets.js";
import { looksKeyBearing, redactSlice, sliceTranscript } from "./transcript.js";
import { AWS_KEY_ID_BESIDE_A_SHA1, CORPUS_A, CORPUS_B, TOKEN_PREFIXES } from "./secret-corpus.js";

/**
 * The measurement behind SECURITY.md's redaction promise. Two production paths reach the
 * detector and they do not cover the same ground, so they are never added into one number:
 *
 *  - The CAPTURE path (`capture`, `signals`, `queue`, `commands`, `mcp`, `corrections`,
 *    `gate`, `distill`, `harvest`) is `detectSecret` alone. A miss there leaves the raw value
 *    unredacted for whatever field captured it. This is the headline rate.
 *  - The TRANSCRIPT path adds `looksKeyBearing`, which drops a whole message carrying key
 *    material. It rescues values `detectSecret` never names, so it is measured as a leak
 *    check on the rendered slice rather than by the redaction counter, which counts a PEM
 *    BEGIN line while the body passes.
 *
 * Nothing here prints a corpus value. The repository is public and the point of the corpus
 * is that a failing case must not become the leak it measures, so every assertion compares
 * ids and booleans.
 */

/**
 * A value that survives a wrap - a PEM body across 28-character lines, a `private_key` JSON
 * field with `\n` escapes, a diff prefixing every line with `+` - is never present in the
 * slice as one contiguous string, so `includes(value)` would call a total leak "held". A leak
 * is therefore any window of the value reappearing, with line structure squeezed out of both
 * sides. 16 characters is long enough that a base64 window cannot collide with prose.
 */
const LEAK_WINDOW = 16;
const squeeze = (text: string) => text.replace(/\\n|\s+/g, "");

/**
 * Both readings of a wrapped body: as it stands, and with the per-line prefix a diff or a
 * `cat -n` listing adds taken off. Both are needed because `+` is itself a base64 character,
 * so stripping unconditionally eats the first byte of any line that happens to start with one.
 */
const bodies = (text: string) => [
  squeeze(text),
  squeeze(
    text
      .split("\n")
      // same prefix class the product strips, so a body pasted into markdown compares too
      .map((line) => line.replace(/^\s*\d+\t|^[>|*+-][ \t]?/, "").replace(/\s*\|$/, ""))
      .join("\n"),
  ),
];

function leaks(value: string, out: string): boolean {
  const v = squeeze(value);
  const o = squeeze(out);
  for (let i = 0; i + LEAK_WINDOW <= v.length; i++) {
    if (o.includes(v.slice(i, i + LEAK_WINDOW))) return true;
  }
  return false;
}

/**
 * The shapes the generic backstops in `secrets.ts` key on - the keyword rule, the bearer
 * header, curl's inline basic auth. A line free of all three carries the credential on its
 * own, which is what makes it a test of the family's own pattern rather than of the backstop.
 */
const CREDENTIAL_KEYWORD =
  /(?:\b|_)(?:api[_-]?key|secret|token|passw(?:or)?d|access[_-]?key)["']?\s*[=:]|\bBearer\s|\bcurl\b[^\n]*\s-{1,2}(?:u|user)\s/i;
const KEYWORD_FREE_CONTEXTS = ["stderr", "stderr-quoted", "diff", "log-line"];

/**
 * The ratchets. Each is a map from id to the REASON it is still there, because a bare list
 * invites the one move that turns this suite into decoration: regenerate it from the output
 * until it goes green. A reason has to be written by someone who looked at the entry.
 *
 * They shorten when a rule is added and GROW when one is taken back out - round 5 gave back
 * two entries by removing a path test that was costing 30 false positives, and the corpus
 * growing adds entries of its own. What is never allowed is a list that grows quietly: a
 * longer list has to arrive with the commit message and the reason saying which rule moved
 * and why. An entry is never deleted to reach green.
 */
const SECRET_DUMP =
  "a 32-byte key with no marker and no keyword beside it - `signing-key:` is in no list, and the value is the same 44 characters as a digest. The capture path cannot name it; the message-level drop holds it, and the test above asserts that it does";
const NETRC_SINGLE_LABEL =
  "a single-label `.netrc` host (`machine localhost`). Recorded rather than fixed: accepting one label makes four ordinary English sentences credentials again, and that cost is both larger and silent - a dropped candidate, a skill refused with \"secret\" - while this one is a machine-local entry";
const PATH_SHAPED_TOKEN =
  "a token that happens to open like a path - a leading slash and a second separator, or something extension-shaped at the end. Telling the two apart by segment shape was tried and measured wrong: 24 false positives over the 88 real-path lines in this corpus, and 32/88 over the independent review's own path set (26 September). The cost fell on the very case the path rule exists for. master misses this shape too, so it is an old gap rather than a regression";
const NO_SHAPE =
  "bare high-entropy value with no marker and no keyword; a rule for it would have to fire on any long word, and a false positive here silently drops a candidate";
const AUTH_FIELD =
  "carried by a field named `auth` with no quotes around it; `auth=none`, `auth=basic` and `auth=bearer` are the same shape, so the rule asks for the quoted JSON form and gets it there";
const BARE_PASSWORD =
  "a password on its own, no scheme and no field. Deliberately not pattern-matched: the round 1 report claimed a server echoes the password here, which is wrong - MySQL prints `using password: YES` - so this line is a probe, not an observed shape, and a rule for it would buy false positives against a leak nobody has seen";
const MARKER_ROUND_3 =
  "the value carries a vendor marker no rule claims yet. The family is recognized in another context, so it fell outside the fourteen round 2 was scoped to - but in THIS shape the value is written unredacted and reaches the harvest prompt, which makes it a known open issue rather than a shape nobody minds. The cheapest remaining work: one pattern and one innocent twin each";
const KEY_BODY =
  "an armor-less or wrapped key body is a bare base64 run and `detectSecret` is a per-line matcher with no block state; the transcript path holds every one of these (measured), and a block machine in the capture path is a deliberate decision nobody has taken";

/** Entries the CAPTURE path (`detectSecret`) does not block. */
const KNOWN_CAPTURE_MISSES: Record<string, string> = {
  "aws-secret-access-key/stderr": NO_SHAPE,
  "gcp-service-account-private-key/stderr": KEY_BODY,
  "google-oauth-client-secret/stderr": MARKER_ROUND_3,
  "google-oauth-access-token/stderr": MARKER_ROUND_3,
  "azure-sas-signature/stderr": NO_SHAPE,
  "discord-bot-token/stderr": MARKER_ROUND_3,
  "twilio-auth-token/stderr": NO_SHAPE,
  "sendgrid-api-key/stderr": MARKER_ROUND_3,
  "mailgun-api-key/stderr": MARKER_ROUND_3,
  "pypi-upload-token/stderr": MARKER_ROUND_3,
  "cloudflare-api-token/stderr": NO_SHAPE,
  "doppler-service-token/stderr": MARKER_ROUND_3,
  "notion-integration-token/stderr": MARKER_ROUND_3,
  "notion-legacy-secret/diff": MARKER_ROUND_3,
  "figma-personal-token/stderr": MARKER_ROUND_3,
  "postman-api-key/stderr": MARKER_ROUND_3,
  "mysql-url-password/stderr": BARE_PASSWORD,
  "mongodb-url-password/stderr": BARE_PASSWORD,
  "redis-url-password/stderr": BARE_PASSWORD,
  "netrc-credential/stderr": BARE_PASSWORD,
  "docker-config-auth/stderr": NO_SHAPE,
  "kubeconfig-client-key-data/stderr": NO_SHAPE,
  "pgp-private-key-block/stderr": KEY_BODY,
  "ssh-private-key-pem/stderr": KEY_BODY,
  "ssh-private-key-pem/config-file": KEY_BODY,
  "putty-private-key/stderr": KEY_BODY,
  "generic-assigned-api-key/stderr": NO_SHAPE,
  "generic-assigned-token/diff": NO_SHAPE,
  "twilio-auth-token/log-line": AUTH_FIELD,
  "netrc-credential/stderr-quoted": BARE_PASSWORD,
  "netrc-credential/log-line": NETRC_SINGLE_LABEL,
  "docker-config-auth/log-line": AUTH_FIELD,
  "kubeconfig-client-key-data/stderr-quoted": NO_SHAPE,
  "wrapped-key-body/config-file": KEY_BODY,
  "wrapped-key-body/command": KEY_BODY,
  "wrapped-key-body/log-line": KEY_BODY,
  "wrapped-key-body/markdown-quote": KEY_BODY,
  "wrapped-key-body/markdown-bullet": KEY_BODY,
  "wrapped-key-body/markdown-table": KEY_BODY,
  "assigned-secret-containing-a-placeholder-word/diff": NO_SHAPE,
  "assigned-secret-starting-with-a-placeholder-word/diff": NO_SHAPE,
  "placeholder-beside-a-shapeless-secret/diff": NO_SHAPE,
  "secret-dump/config-file": SECRET_DUMP,
  "secret-dump/env-file": SECRET_DUMP,
  "secret-dump/stderr": SECRET_DUMP,
  "slash-leading-credential/stderr": NO_SHAPE,
  "slash-leading-credential/diff": NO_SHAPE,
  "slash-leading-credential/stderr-quoted": NO_SHAPE,
  "slash-leading-credential/log-line": PATH_SHAPED_TOKEN,
  "slash-leading-credential/config-file": PATH_SHAPED_TOKEN,
};

/**
 * Values a harvest slice still carries - that is, the value reaches `claude -p` in the
 * clear. Every one of these is a known open issue at release, not an accepted shape.
 */
const KNOWN_TRANSCRIPT_LEAKS: Record<string, string> = {
  "aws-secret-access-key/stderr": NO_SHAPE,
  "google-oauth-client-secret/stderr": MARKER_ROUND_3,
  "google-oauth-access-token/stderr": MARKER_ROUND_3,
  "azure-sas-signature/stderr": NO_SHAPE,
  "discord-bot-token/stderr": MARKER_ROUND_3,
  "twilio-auth-token/stderr": NO_SHAPE,
  "sendgrid-api-key/stderr": MARKER_ROUND_3,
  "mailgun-api-key/stderr": MARKER_ROUND_3,
  "cloudflare-api-token/stderr": NO_SHAPE,
  "doppler-service-token/stderr": MARKER_ROUND_3,
  "notion-integration-token/stderr": MARKER_ROUND_3,
  "notion-legacy-secret/diff": MARKER_ROUND_3,
  "figma-personal-token/stderr": MARKER_ROUND_3,
  "postman-api-key/stderr": MARKER_ROUND_3,
  "mysql-url-password/stderr": BARE_PASSWORD,
  "mongodb-url-password/stderr": BARE_PASSWORD,
  "redis-url-password/stderr": BARE_PASSWORD,
  "netrc-credential/stderr": BARE_PASSWORD,
  "docker-config-auth/stderr": NO_SHAPE,
  "generic-assigned-api-key/stderr": NO_SHAPE,
  "generic-assigned-token/diff": NO_SHAPE,
  "twilio-auth-token/log-line": AUTH_FIELD,
  "netrc-credential/stderr-quoted": BARE_PASSWORD,
  "netrc-credential/log-line": NETRC_SINGLE_LABEL,
  "docker-config-auth/log-line": AUTH_FIELD,
  "assigned-secret-containing-a-placeholder-word/diff": NO_SHAPE,
  "assigned-secret-starting-with-a-placeholder-word/diff": NO_SHAPE,
  "placeholder-beside-a-shapeless-secret/diff": NO_SHAPE,
  "slash-leading-credential/stderr": NO_SHAPE,
  "slash-leading-credential/diff": NO_SHAPE,
  "slash-leading-credential/stderr-quoted": NO_SHAPE,
  "slash-leading-credential/log-line": PATH_SHAPED_TOKEN,
  "slash-leading-credential/config-file": PATH_SHAPED_TOKEN,
};

/** Innocent lines the CAPTURE path drops anyway. Each one silently loses a candidate. */
const KNOWN_FALSE_POSITIVES: Record<string, string> = {};

/** Innocent messages `looksKeyBearing` drops whole from the harvest slice. */
const KNOWN_FALSE_MESSAGE_DROPS: Record<string, string> = {
  "kubeconfig-ca-data":
    "a kubeconfig's PUBLIC certificate authority body. `transcript.ts` already accepts losing a message that quotes a certificate - the body is a base64 blob either way - and the alternative is a rule that tells a certificate from a key by length",
  "digest-column-from-sha256sum":
    "five base64 digests, each 32 bytes and so each padded - which is byte for byte what three rotated 32-byte KEYS look like. The rule that told them apart by padding let a `kubectl get secret` dump through, so it is gone and this column goes down with the dump. Same class and same call as the id column below: it fails CLOSED, and what is lost is a message that was only a column",
  "id-column-28-char":
    "five consecutive 28-character mixed-case identifiers are the same bytes as a key body wrapped at 28, which is the wrap the run thresholds used to miss. Raising the floor past 28 reopens that gap, so the trade is taken in this direction: it fails CLOSED, and a message that is nothing but a bare id column carries no lesson to lose",
};

/**
 * Order-independent. The measured ids come out in corpus order, so `toEqual` on the arrays
 * turns a reordering of the corpus into a red test whose most natural fix - paste the new
 * output over the list - is the same move that lets a real regression in.
 */
function expectSameIds(actual: string[], expected: Record<string, string>): void {
  expect([...actual].sort()).toEqual(Object.keys(expected).sort());
}

/** What the transcript path hands the model for one message of session text. */
function sliceOf(line: string): string {
  return redactSlice(sliceTranscript([{ role: "user", text: line }])).clean;
}

const captured = new Set(CORPUS_A.filter((e) => detectSecret(e.line) !== null).map((e) => e.id));
const families = [...new Set(CORPUS_A.map((e) => e.family))];

describe("corpus integrity", () => {
  it("covers the families a real session produces", () => {
    expect(CORPUS_A.length).toBeGreaterThanOrEqual(60);
    expect(families.length).toBeGreaterThanOrEqual(30);
    expect(CORPUS_B.length).toBeGreaterThanOrEqual(30);
  });

  /**
   * One context per family is how the corpus begs its own question: a family entered as a
   * single `.env` line is held by the generic keyword backstop and reads on the table as if
   * its format were recognized.
   */
  it("measures every family in at least two contexts", () => {
    const thin = families.filter(
      (f) => new Set(CORPUS_A.filter((e) => e.family === f).map((e) => e.context)).size < 2,
    );
    expect(thin).toEqual([]);
  });

  /**
   * Checked on the LINE, not on the context label. A family whose only keyword-free entry
   * still says `password:` next to the value measures the backstop and reports the result
   * as recognition of the family.
   */
  it("gives every family a context whose line carries no credential keyword", () => {
    const keywordFree = new Set(
      CORPUS_A.filter(
        (e) => KEYWORD_FREE_CONTEXTS.includes(e.context) && !CREDENTIAL_KEYWORD.test(e.line),
      ).map((e) => e.family),
    );
    expect(families.filter((f) => !keywordFree.has(f))).toEqual([]);
  });

  it("carries no id twice, and every line really contains its own value", () => {
    expect(new Set(CORPUS_A.map((e) => e.id)).size).toBe(CORPUS_A.length);
    expect(new Set(CORPUS_B.map((e) => e.id)).size).toBe(CORPUS_B.length);
    // a wrapped value is never present contiguously, so the comparison drops line structure
    expect(
      CORPUS_A.filter((e) => !bodies(e.line).some((b) => b.includes(squeeze(e.value)))).map(
        (e) => e.id,
      ),
    ).toEqual([]);
    expect(CORPUS_A.filter((e) => squeeze(e.value).length < LEAK_WINDOW).map((e) => e.id)).toEqual(
      [],
    );
  });

  /**
   * `sliceTranscript` caps a user message at 1000 characters. A corpus line over that budget
   * would be truncated before redaction and report "held" for a value the slice never saw.
   */
  it("keeps every line inside the slice budget, so 'held' means redacted", () => {
    expect(CORPUS_A.filter((e) => e.line.length > 900).map((e) => e.id)).toEqual([]);
  });

  /**
   * GitHub push protection blocks a diff containing a format-matching string even when the
   * value is synthetic, and this repository is public. The corpus builds every value from a
   * prefix literal plus a generated body, so no contiguous token may exist in the source.
   */
  /**
   * Dogfooding. Loosening `putty-key` to see a diff of a key file made the header's NAME
   * enough, and two of the lines that then read as a secret were this repository's own -
   * `secrets.ts` and `transcript.ts`, where the header is named in a comment. A session
   * working on TeamHandbook lost the signal of any edit touching them.
   *
   * Scoped to that rule rather than to every rule: five files here legitimately trip others
   * (`gate.ts` and `pipeline.ts` assign the word `secret`, `init.ts` writes a URL with
   * credentials in it, and `secret-corpus.ts` and `transcript.ts` quote PEM armor because
   * carrying it and redacting it are their jobs). Widening the assertion would only record
   * that, not protect anything.
   */
  it("does not read this repository's own source as a PuTTY key", () => {
    const dir = "src/lib";
    const flagged = readdirSync(dir)
      .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
      .filter((f) => detectSecret(readFileSync(join(dir, f), "utf8")) === "putty-key");
    expect(flagged).toEqual([]);
  });

  it("keeps no contiguous token literal in its own source", () => {
    // The two product files this round edited are scanned too: a comment naming a format by
    // example is the same contiguous run as a fixture, and the scan cannot tell the two
    // apart. The rest of `src/lib` carries literals that predate the corpus.
    const sources = [
      "src/lib/secret-corpus.ts",
      "src/lib/secret-corpus.test.ts",
      "src/lib/secrets.ts",
      "src/lib/transcript.ts",
    ].map((p) => readFileSync(p, "utf8"));
    const offenders = TOKEN_PREFIXES.filter((prefix) =>
      sources.some((src) =>
        new RegExp(`${prefix.replace(/[.\-+*?^$|()[\]{}\\]/g, "\\$&")}[A-Za-z0-9-]{16,}`).test(src),
      ),
    );
    expect(offenders).toEqual([]);
  });
});

describe("corpus A - the capture path (detectSecret alone)", () => {
  it("misses exactly the entries recorded as missed, each with a reason", () => {
    expectSameIds(
      CORPUS_A.filter((e) => !captured.has(e.id)).map((e) => e.id),
      KNOWN_CAPTURE_MISSES,
    );
  });

  /**
   * The family-level invariant SECURITY.md states: a credential family the detector cannot
   * name in any context at all fails the build. The per-entry ratchet above tolerates a miss
   * in one shape; this one tolerates nothing, and deliberately has no ratchet of its own - a
   * list to add to is a list that gets added to, and this assertion can only be got past by
   * editing it where a reviewer sees it.
   */
  it("recognizes every family in at least one context", () => {
    const unrecognized = families.filter(
      (f) =>
        !CORPUS_A.some((e) => e.family === f && e.transcriptOnly) &&
        !CORPUS_A.some((e) => e.family === f && captured.has(e.id)),
    );
    expect(unrecognized).toEqual([]);
  });

  /**
   * The other half of that exemption, and the reason it is safe to grant: a family excused
   * from the pattern invariant because it is a message SHAPE rather than a format has to be
   * held by the message-level drop in EVERY context. There is no ratchet here either - a
   * shape that starts reaching the model fails the build.
   */
  it("holds every context of a family that only the transcript path can catch", () => {
    const leaking = CORPUS_A.filter(
      (e) => e.transcriptOnly && leaks(e.value, sliceOf(e.line)),
    ).map((e) => e.id);
    expect(leaking).toEqual([]);
  });

  it.each(CORPUS_A.filter((e) => !(e.id in KNOWN_CAPTURE_MISSES)))("drops $id", ({ line }) => {
    expect(detectSecret(line)).not.toBeNull();
  });

  /**
   * The reject that keeps `api_key=xxxxxxxx` from dropping a candidate runs per match, and
   * only a LABEL assertion can show it: `not.toBeNull()` passes just as well when some other
   * pattern claimed the line first and the reject was never reached.
   */
  it.each([
    "placeholder-beside-a-shapeless-secret/config-file",
    "placeholder-beside-a-shapeless-secret/env-file",
  ])("reaches the second match in %s, where the first is a placeholder", (id) => {
    const entry = CORPUS_A.find((e) => e.id === id)!;
    expect(detectSecret(entry.line)).toBe("assigned-secret");
  });

  /**
   * The twin for the proximity rule. An access key id IS worth redacting, so this line is
   * caught either way and the only question is which rule claims it: read as the secret half
   * of a pair, the 40 lowercase hex characters after it would make every release log that
   * prints a commit beside a key id look like a leaked secret.
   */
  it("reads a sha1 beside an access key id as the id, not as the secret half", () => {
    expect(detectSecret(AWS_KEY_ID_BESIDE_A_SHA1)).toBe("aws-access-key");
  });

  /**
   * Two families share the `sk-` opening and the detector reports whichever pattern fired
   * first, so a shadowed family reads as caught while its own rule is dead. The label is the
   * only thing that tells the difference.
   */
  it.each([
    ["anthropic-api-key", "anthropic-api-key"],
    ["openai-legacy-key", "openai-key"],
    ["openai-project-key", "openai-key"],
  ])("labels %s as %s rather than shadowing it", (family, expected) => {
    const lines = CORPUS_A.filter((e) => e.family === family);
    expect(lines.length).toBeGreaterThan(0);
    expect([...new Set(lines.map((e) => detectSecret(e.line)))]).toEqual([expected]);
  });
});

describe("corpus A - the transcript path (looksKeyBearing + line redaction)", () => {
  it("leaks exactly the values recorded as leaking, each with a reason", () => {
    expectSameIds(
      CORPUS_A.filter((e) => leaks(e.value, sliceOf(e.line))).map((e) => e.id),
      KNOWN_TRANSCRIPT_LEAKS,
    );
  });
});

describe("corpus B - innocent lines that carry the shape of a secret", () => {
  it("false-positives on exactly the lines recorded as false positives", () => {
    expectSameIds(
      CORPUS_B.filter((e) => detectSecret(e.line) !== null).map((e) => e.id),
      KNOWN_FALSE_POSITIVES,
    );
  });

  it("drops exactly the messages recorded as dropped from the harvest slice", () => {
    expectSameIds(
      CORPUS_B.filter((e) => looksKeyBearing(e.line)).map((e) => e.id),
      KNOWN_FALSE_MESSAGE_DROPS,
    );
  });
});
