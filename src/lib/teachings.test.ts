import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { noteCorrection } from "./corrections.js";
import {
  STORE_LIMIT,
  matchTokens,
  readTeachings,
  recordAndMatchTeachings,
  sameTeaching,
  teachingsFile,
} from "./teachings.js";

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "handbook-teach-"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});


describe("matchTokens", () => {
  it("given a word typed with and without its diacritics, when tokenized, then both land on one form", () => {
    expect(matchTokens("değiştirme")).toEqual(matchTokens("degistirme"));
  });

  it("given dotted and dotless Turkish i, when tokenized, then neither letter is deleted", () => {
    expect(matchTokens("İSTANBUL sırası")).toEqual(["istanbul", "sirasi"]);
  });

  it.each([
    ["Turkish", "burada db'yi asla mocklamayız", "mocklamayiz"],
    ["Cyrillic", "мы не используем моки", "используем"],
    ["Greek", "δεν χρησιμοποιούμε mocks", "χρησιμοποιουμε"],
  ])("given %s, when tokenized, then its letters survive", (_l, text, expected) => {
    expect(matchTokens(text)).toContain(expected);
  });

  it("given a script with no spaces, when tokenized, then it still yields a token", () => {
    expect(matchTokens("このリポジトリではモックを使いません").length).toBeGreaterThan(0);
  });
});

describe("sameTeaching", () => {
  it("given no words on one side, when compared, then it matches nothing", () => {
    expect(sameTeaching([], matchTokens("mock the database"))).toBe(false);
  });

  it("given two rules that share only their routine, when compared, then they stay apart", () => {

    expect(
      sameTeaching(
        matchTokens("always run the tests before pushing"),
        matchTokens("always run the linter before pushing"),
      ),
    ).toBe(false);
  });

  it("given a terse rule restated at length, when compared, then the shorter being contained is enough", () => {
    expect(
      sameTeaching(
        matchTokens("never mock the database"),
        matchTokens("don't mock the database — use testcontainers instead"),
      ),
    ).toBe(true);
  });

  it("given a Turkish rule inflected differently, when compared, then no stemmer is needed", () => {
    expect(
      sameTeaching(
        matchTokens("burada asla db mocklamayız"),
        matchTokens("burada asla db mocklamayın"),
      ),
    ).toBe(true);
  });

  it("given two Turkish rules that share only their scaffolding, when compared, then they stay apart", () => {

    expect(
      sameTeaching(
        matchTokens("burada db'yi asla mocklamayız"),
        matchTokens("burada log seviyesini asla debug bırakma"),
      ),
    ).toBe(false);
  });
});

// The table the matcher was designed against, run against the real implementation
// rather than a prototype. Every "no" here is a pair that shares its scaffolding and
// differs in what it is actually about; every "yes" is one lesson said twice.
describe("sameTeaching — the measured table", () => {
  it.each([
    [true, "never mock the database", "don't mock the database — use testcontainers instead"],
    [
      true,
      "we never use mocks for the database in this repo, use testcontainers",
      "don't mock the database — use testcontainers",
    ],
    [
      true,
      "always run npm run build after editing hooks",
      "you must run npm run build after editing a hook",
    ],
    [true, "burada asla db mocklamayız", "burada asla db mocklamayın"],
    [
      true,
      "burada db'yi asla mocklamayız, testcontainer kullan",
      "db'yi asla mocklamayın, testcontainer kullanın",
    ],
    [true, "değiştirme onu şimdi", "degistirme onu simdi"],
    [
      true,
      "hayır önce review sonra e2e test yapılsın, max 4 olsun",
      "önce review yapılsın sonra e2e test, max 4",
    ],
    [false, "always run the tests before pushing", "always run the linter before pushing"],
    [false, "never use mocks", "never use var"],
    [false, "never mock the database, use testcontainers", "always run migrations before starting the api"],
    [false, "burada db'yi asla mocklamayız", "burada log seviyesini asla debug bırakma"],
    [false, "devam ediyor musun?", "hazır mıyız?"],
    [false, "tüm kodları master a koy, test et", "tüm testleri koş ve sonucu söyle"],
    // an identifier a digit apart is two things, not one word inflected twice
    [false, "topic204 requires approach204", "topic203 requires approach203"],
    [false, "customer1 gets the discount", "customer2 gets the discount"],
  ])("%s: %s || %s", (expected, a, b) => {
    expect(sameTeaching(matchTokens(a), matchTokens(b))).toBe(expected);
  });
});

describe("recordAndMatchTeachings", () => {
  it("given a teaching never said before, when recorded, then it is not reported as an echo", () => {
    const echoes = recordAndMatchTeachings(["never mock the database, use testcontainers"], home);

    expect(echoes[0]?.priorSessions).toBe(0);
    expect(readTeachings(home)).toHaveLength(1);
  });

  it("given the same lesson phrased differently in a later session, when recorded, then it is an echo of the first", () => {
    recordAndMatchTeachings(
      ["we never use mocks for the database in this repo, use testcontainers"],
      home,
      "2026-08-01T00:00:00.000Z",
    );

    const echoes = recordAndMatchTeachings(
      ["don't mock the database — use testcontainers"],
      home,
      "2026-08-09T00:00:00.000Z",
    );

    expect(echoes[0]?.priorSessions).toBe(1);
    expect(echoes[0]?.firstAt).toBe("2026-08-01T00:00:00.000Z");
    expect(readTeachings(home)).toHaveLength(1);
  });

  it("given a Turkish rule taught in two sessions, when recorded, then the second is an echo", () => {
    recordAndMatchTeachings(
      ["burada db'yi asla mocklamayız, testcontainer kullan"],
      home,
      "2026-08-01T00:00:00.000Z",
    );

    const echoes = recordAndMatchTeachings(
      ["db'yi asla mocklamayın, testcontainer kullanın"],
      home,
      "2026-08-09T00:00:00.000Z",
    );

    expect(echoes[0]?.priorSessions).toBe(1);
    expect(readTeachings(home)).toHaveLength(1);
  });

  it("given an unrelated teaching, when recorded, then it is not matched to an existing one", () => {
    recordAndMatchTeachings(["never mock the database, use testcontainers"], home);

    const echoes = recordAndMatchTeachings(["always run migrations before starting the api"], home);

    expect(echoes[0]?.priorSessions).toBe(0);
    expect(readTeachings(home)).toHaveLength(2);
  });

  it("given the same teaching repeated within one session, when recorded, then it counts once", () => {
    const echoes = recordAndMatchTeachings(
      [
        "never mock the database, use testcontainers",
        "again: never mock the database, testcontainers",
      ],
      home,
    );

    expect(echoes).toHaveLength(1);
    expect(readTeachings(home)[0]?.count).toBe(1);
  });

  it("given a teaching too short to match on, when recorded, then it is ignored rather than matching everything", () => {
    recordAndMatchTeachings(["no"], home);

    expect(readTeachings(home)).toEqual([]);
  });

  it("given a corrupted store, when recording, then it recovers instead of throwing", () => {
    writeFileSync(teachingsFile(home), "[not json");

    const echoes = recordAndMatchTeachings(["never mock the database, use testcontainers"], home);

    expect(echoes[0]?.priorSessions).toBe(0);
  });

  it("given a store written by the English-only tokenizer, when read, then its words are re-derived from the sample", () => {
    writeFileSync(
      teachingsFile(home),
      JSON.stringify([
        {
          words: ["mock", "databas", "testcontain"], // stemmed by the old matcher
          count: 1,
          firstAt: "2026-08-01T00:00:00.000Z",
          lastAt: "2026-08-01T00:00:00.000Z",
          sample: "we never mock the database, use testcontainers",
        },
      ]),
    );

    const echoes = recordAndMatchTeachings(
      ["don't mock the database — use testcontainers"],
      home,
      "2026-08-09T00:00:00.000Z",
    );

    expect(echoes[0]?.priorSessions).toBe(1);
    expect(readTeachings(home)).toHaveLength(1);
  });

  it("given more teachings than the store keeps, when recording, then the most recently taught survive", () => {
    const seeded = Array.from({ length: STORE_LIMIT }, (_, i) => ({
      words: matchTokens(`topic${i} requires approach${i} inside module${i}`),
      count: 1,
      firstAt: `2026-01-01T00:00:00.${String(i).padStart(3, "0")}Z`,
      lastAt: `2026-01-01T00:00:00.${String(i).padStart(3, "0")}Z`,
      sample: `topic${i} requires approach${i} inside module${i}`,
      v: 2,
    }));
    writeFileSync(teachingsFile(home), JSON.stringify(seeded));

    recordAndMatchTeachings(["a brand new lesson about pagination cursors"], home, "2027-01-01T00:00:00.000Z");

    const stored = readTeachings(home);
    expect(stored.length).toBe(STORE_LIMIT);
    expect(stored.some((r) => r.sample.includes("pagination cursors"))).toBe(true);
    // the oldest singleton is the one that made room
    expect(stored.some((r) => r.sample === "topic0 requires approach0 inside module0")).toBe(false);
  });

  it("given a secret-bearing prompt, when captured, then nothing about it reaches the store", () => {
    const notes = noteCorrection([], "always use Bearer sk-proj-abcdef1234567890ABCDEFGH here");
    recordAndMatchTeachings((notes ?? []).map((n) => n.text), home);

    expect(readTeachings(home)).toEqual([]);
    expect(() => readFileSync(teachingsFile(home), "utf8")).toThrow();
  });
});

describe("the real case this was built for", () => {
  // Verbatim from two live claude sessions: the same rule, welded to different errands.
  // Nothing extracts the rule sentence any more — that took an English pattern to find —
  // so the errand rides along and the weighting has to see past it on its own.
  const first =
    "In this repo we never mock the database in tests — always use testcontainers. Now append a comment line '// db: testcontainers only' to src/api.ts.";
  const second =
    "Reminder: don't mock the database — use testcontainers instead. Now append '// no mocks' to src/api.ts.";

  const taught = (prompt: string) => noteCorrection([], prompt)!.map((n) => n.text);

  it("given the rule stated twice with different errands attached, when recorded, then the second is an echo of the first", () => {
    recordAndMatchTeachings(taught(first), home, "2026-08-01T00:00:00.000Z");

    const echoes = recordAndMatchTeachings(taught(second), home, "2026-08-09T00:00:00.000Z");

    expect(echoes[0]?.priorSessions).toBe(1);
  });

  it("given the same rule stated a third time with filler words, when recorded, then it is still the same lesson", () => {
    recordAndMatchTeachings(taught(first), home, "2026-08-01T00:00:00.000Z");
    recordAndMatchTeachings(taught(second), home, "2026-08-09T00:00:00.000Z");

    const echoes = recordAndMatchTeachings(
      taught("One more time: no database mocks in this repo — always testcontainers."),
      home,
      "2026-08-11T00:00:00.000Z",
    );

    expect(echoes[0]?.priorSessions).toBe(2);
    expect(readTeachings(home)).toHaveLength(1);
  });
});

describe("sameTeaching against a skill description", () => {
  const teaching = matchTokens("Again: we never mock the database here — testcontainers only.");

  it("given a skill description that says more than the teaching, when compared, then it still matches", () => {
    const description = matchTokens(
      "Use when writing database tests — write real PostgreSQL tests using testcontainers instead of mocks.",
    );

    expect(sameTeaching(description, teaching)).toBe(true);
  });

  it("given a description about something else, when compared, then it does not match", () => {
    expect(sameTeaching(matchTokens("Use when deploying the api to staging."), teaching)).toBe(
      false,
    );
  });

  it("given only one or two words in common, when compared, then that is not enough to claim a match", () => {
    expect(
      sameTeaching(matchTokens("Use when the database migration fails."), teaching),
    ).toBe(false);
  });
});
