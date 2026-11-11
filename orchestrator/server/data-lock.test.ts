import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { dataDirSentence, privateDataDir } from "./data-lock.js";

describe("the data directory's mode", () => {
  it("given an open umask, a new directory, a local one an earlier start left open and a team's mounted open, when each is made private, then the new and the local one are 0700 and the team's is left as mounted", () => {
    const base = mkdtempSync(join(tmpdir(), "th-data-mode-"));
    const umask = process.umask(0o022);
    try {
      // given
      const fresh = join(base, "fresh", "TeamHandbook Orchestrator");
      const left = join(base, "left");
      const mounted = join(base, "mounted");
      for (const dir of [left, mounted]) {
        mkdirSync(dir);
        chmodSync(dir, 0o755);
      }

      // when
      privateDataDir(fresh, { ORCHESTRATOR_MODE: "local" });
      privateDataDir(left, { ORCHESTRATOR_MODE: "local" });
      privateDataDir(mounted, { ORCHESTRATOR_MODE: "self-hosted" });

      // then
      expect(statSync(fresh).mode & 0o777).toBe(0o700);
      expect(statSync(left).mode & 0o777).toBe(0o700);
      expect(statSync(mounted).mode & 0o777).toBe(0o755);
    } finally {
      process.umask(umask);
      rmSync(base, { recursive: true, force: true });
    }
  });
});

describe("what a start says of its data folder", () => {
  it("given a team's start with no data folder set, one that sets it and a local one, when each says where its data lives, then only the first says it is the directory it was started from and how to find the data again", () => {
    // when
    const [fromHere, set, local] = [dataDirSentence("/srv/orch/data", { ORCHESTRATOR_MODE: "self-hosted" }), dataDirSentence("/var/lib/orch", { ORCHESTRATOR_MODE: "self-hosted", ORCHESTRATOR_DATA_DIR: "/var/lib/orch" }), dataDirSentence("/home/ada/.local/share/orch", { ORCHESTRATOR_MODE: "local" })];

    // then
    expect(fromHere).toBe("Data and sealed sign-ins are kept in /srv/orch/data, the data folder of the directory this was started from; start it from the same directory, or set ORCHESTRATOR_DATA_DIR, to find them again.");
    expect([set, local]).toEqual(["Data and sealed sign-ins are kept in /var/lib/orch.", "Data and sealed sign-ins are kept in /home/ada/.local/share/orch."]);
  });
});
