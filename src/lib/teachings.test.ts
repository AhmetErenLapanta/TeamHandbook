import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { noteCorrection } from "./corrections.js";
import {
  contentWords,
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

describe("contentWords", () => {
  it("given plural and singular forms of the same word, when extracted, then they normalize together", () => {
    expect(contentWords("we never use mocks")).toContain("mock");
    expect(contentWords("do not mock it")).toContain("mock");
  });

  it("given filler words, when extracted, then only the meaningful ones survive", () => {
    expect(contentWords("please do not use the database here")).toEqual(["database"]);
  });

  it("given a verb in different tenses, when extracted, then both land on the same token", () => {
    expect(contentWords("editing hooks")).toEqual(contentWords("edited hook"));
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

  it("given a third session teaching it again, when recorded, then the count keeps climbing", () => {
    recordAndMatchTeachings(["always run npm run build after editing hooks"], home);
    recordAndMatchTeachings(["remember to run npm run build when you edit hooks"], home);

    const echoes = recordAndMatchTeachings(["you must run npm run build after editing a hook"], home);

    expect(echoes[0]?.priorSessions).toBe(2);
  });

  it("given an unrelated teaching, when recorded, then it is not matched to an existing one", () => {
    recordAndMatchTeachings(["never mock the database, use testcontainers"], home);

    const echoes = recordAndMatchTeachings(["always run migrations before starting the api"], home);

    expect(echoes[0]?.priorSessions).toBe(0);
    expect(readTeachings(home)).toHaveLength(2);
  });

  it("given the same teaching repeated within one session, when recorded, then it counts once", () => {
    const echoes = recordAndMatchTeachings(
      ["never mock the database, use testcontainers", "again: never mock the database, testcontainers"],
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

  it("given more teachings than the store keeps, when recording, then the most recently taught survive", () => {
    for (let i = 0; i < 205; i++) {
      const at = `2026-01-01T${String(Math.floor(i / 60)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}:00.000Z`;
      recordAndMatchTeachings([`topic${i} requires approach${i} inside module${i}`], home, at);
    }

    const stored = readTeachings(home);
    expect(stored.length).toBeLessThanOrEqual(200);
    expect(stored.some((r) => r.sample.includes("topic204"))).toBe(true);
    expect(stored.some((r) => r.sample.includes("topic0 "))).toBe(false);
  });
});

describe("sameTeaching", () => {
  it("given no words on one side, when compared, then it matches nothing", () => {
    expect(sameTeaching([], ["mock", "database"])).toBe(false);
  });

  it("given two rules that share only their routine, when compared, then they stay apart", () => {
    expect(
      sameTeaching(
        contentWords("always run the tests before pushing"),
        contentWords("always run the linter before pushing"),
      ),
    ).toBe(false);
  });

  it("given a terse rule restated at length, when compared, then the shorter being contained is enough", () => {
    expect(
      sameTeaching(
        contentWords("never mock the database"),
        contentWords("don't mock the database — use testcontainers instead"),
      ),
    ).toBe(true);
  });
});

describe("the real case this was built for", () => {
  // Verbatim from two live claude sessions: the same rule, welded to different
  // errands. Before teachings captured the rule sentence alone, these two read as
  // unrelated and the repeat went unnoticed.
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

  it("given a teaching, when captured, then the errand is left out of what is remembered", () => {
    expect(taught(first)[0]).toBe(
      "In this repo we never mock the database in tests — always use testcontainers.",
    );
  });
});

describe("sameTeaching against a skill description", () => {
  const teaching = contentWords("Again: we never mock the database here — testcontainers only.");

  it("given a skill description that says more than the teaching, when compared, then it still matches", () => {
    const description = contentWords(
      "Use when writing database tests — write real PostgreSQL tests using testcontainers instead of mocks.",
    );

    expect(sameTeaching(description, teaching)).toBe(true);
  });

  it("given the same rule buried in filler words, when compared to the description, then it still matches", () => {
    const filler = contentWords("One more time: no database mocks in this repo — always testcontainers.");
    const description = contentWords(
      "Use when writing database tests — write real PostgreSQL tests using testcontainers instead of mocks.",
    );

    expect(sameTeaching(description, filler)).toBe(true);
  });

  it("given a description about something else, when compared, then it does not match", () => {
    expect(sameTeaching(contentWords("Use when deploying the api to staging."), teaching)).toBe(false);
  });

  it("given only one or two words in common, when compared, then that is not enough to claim a match", () => {
    expect(sameTeaching(contentWords("Use when the database migration fails."), teaching)).toBe(false);
  });
});
