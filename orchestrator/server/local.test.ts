import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { askForLink, onWindowsFromWsl, signInSentence, localDataDir, localOwnerName, localMachine, localHostProblem, localLinkRoutes, localReposRoot, localStartProblem, openBrowser, pickPort, reentrySecret, runningAddress, signInPage, writeLocalAddress } from "./local.js";
import { openSqliteStore } from "./store.js";

describe("a local orchestrator's defaults", () => {
  it("given each system, when the data directory is chosen without ORCHESTRATOR_DATA_DIR, then it is that system's place for an application's data", () => {
    expect(localDataDir({}, "darwin", "/home/someone")).toBe("/home/someone/Library/Application Support/TeamHandbook Orchestrator");
    expect(localDataDir({}, "linux", "/home/someone")).toBe("/home/someone/.local/share/teamhandbook-orchestrator");
    expect(localDataDir({ XDG_DATA_HOME: "/data/someone" }, "linux", "/home/someone")).toBe("/data/someone/teamhandbook-orchestrator");
  });

  it("given a local orchestrator with nothing set, ORCHESTRATOR_LOCAL_REPOS_ROOT set for one org and for several, and a team's with none, when the folder for repositories by path is chosen, then it is the person's home, the folder named, a folder an org under it, or none", () => {
    expect(localReposRoot({}, ["default"], "default", "/home/someone")).toBe("/home/someone");
    expect(localReposRoot({ ORCHESTRATOR_LOCAL_REPOS_ROOT: "/srv/repos" }, ["default"], "default", "/home/someone")).toBe("/srv/repos");
    expect(localReposRoot({ ORCHESTRATOR_LOCAL_REPOS_ROOT: "/srv/repos" }, ["acme", "globex"], "acme", "/home/someone")).toBe("/srv/repos/acme");
    expect(localReposRoot({ ORCHESTRATOR_MODE: "self-hosted" }, ["default"], "default", "/home/someone")).toBeNull();
  });

  it("given an address on this machine and one beyond it, when they are checked, then only the first is taken", () => {
    expect(["127.0.0.1", "::1", "localhost"].map(localHostProblem)).toEqual([null, null, null]);
    expect(localHostProblem("0.0.0.0")).toMatch(/^ORCHESTRATOR_HOST=0\.0\.0\.0 reaches beyond this machine/);
  });

  it("given an address beyond this machine with nothing else set, with ORCHESTRATOR_MODE=local, and with a team's settings, when a start is checked, then only the local ones stop it, and an empty or loopback address never does", () => {
    for (const env of [{ ORCHESTRATOR_HOST: "0.0.0.0" }, { ORCHESTRATOR_MODE: "local", ORCHESTRATOR_HOST: "0.0.0.0" }, { ORCHESTRATOR_HOST: "192.168.1.20" }]) expect(localStartProblem(env), JSON.stringify(env)).toMatch(/reaches beyond this machine/);
    for (const env of [{}, { ORCHESTRATOR_HOST: "" }, { ORCHESTRATOR_HOST: "127.0.0.1" }, { ORCHESTRATOR_MODE: "self-hosted", ORCHESTRATOR_HOST: "0.0.0.0" }, { ORCHESTRATOR_AUTH: "local", ORCHESTRATOR_HOST: "0.0.0.0" }]) expect(localStartProblem(env), JSON.stringify(env)).toBeNull();
  });

  it("given the preferred port held by something else, when a port is picked, then another free one is given", async () => {
    // given
    const holder = createServer();
    const held = await new Promise<number>((resolve) => holder.listen(0, "127.0.0.1", () => resolve((holder.address() as { port: number }).port)));
    try {
      // when
      const picked = await pickPort(held, "127.0.0.1");

      // then
      expect(picked).not.toBe(held);
      expect(picked).toBeGreaterThan(0);
    } finally {
      holder.close();
    }
  });

  it("given BROWSER set, nothing set on each system, and ORCHESTRATOR_NO_BROWSER=1, when the address is opened, then the named command, the system's opener, or nothing runs", () => {
    const runs: [string, string[]][] = [];
    const run = (command: string, args: string[]) => (runs.push([command, args]), { unref: () => undefined, on: () => undefined });
    const url = "http://127.0.0.1:8080/";

    expect(openBrowser(url, { BROWSER: "/usr/local/bin/stand-in" }, "linux", run, false)).toBe("/usr/local/bin/stand-in");
    expect(openBrowser(url, {}, "darwin", run, false)).toBe("open");
    expect(openBrowser(url, {}, "linux", run, false)).toBe("xdg-open");
    expect(openBrowser(url, { ORCHESTRATOR_NO_BROWSER: "1" }, "linux", run, false)).toBeNull();
    expect(runs).toEqual([["/usr/local/bin/stand-in", [url]], ["open", [url]], ["xdg-open", [url]]]);
  });

  it("given the browser opened and left closed, when the start says how to sign in, then it names the page either way and promises no browser it did not open", () => {
    const page = "/home/someone/.local/share/teamhandbook-orchestrator/open.html";

    expect(signInSentence(page, true)).toBe(`It opens in your browser; to sign in from another browser on this machine, open ${page} in it within five minutes.`);
    expect(signInSentence(page, false)).toBe(`Open ${page} in your browser within five minutes to sign in.`);
  });

  it("given WSL with wslview, and WSL without it, when the sign-in page is opened, then wslview opens it, or Windows' start opens the same file by its Windows name", () => {
    const runs: [string, string[]][] = [];
    const missing = new Set(["wslview"]);
    const listeners: (() => void)[] = [];
    const run = (command: string, args: string[]) => (runs.push([command, args]), { unref: () => undefined, on: (_event: "error", listener: () => void) => void (missing.has(command) && listeners.push(listener)) });
    const page = "/home/someone/.local/share/teamhandbook-orchestrator/open.html";
    const env = { WSL_DISTRO_NAME: "Ubuntu" };

    expect(openBrowser(page, env, "linux", run, true)).toBe("wslview");
    for (const failed of listeners.splice(0)) failed();

    expect(runs).toEqual([
      ["wslview", [page]],
      ["cmd.exe", ["/c", "start", "", "\\\\wsl$\\Ubuntu\\home\\someone\\.local\\share\\teamhandbook-orchestrator\\open.html"]],
    ]);
  });
});

describe("a second local start", () => {
  it("given the address a running orchestrator wrote, none, and one that is not this machine's, when a second start reads it, then only the first is given back, and the file is its owner's alone", () => {
    const dir = mkdtempSync(join(tmpdir(), "th-local-address-"));
    try {
      expect(runningAddress(dir)).toBeNull();
      writeLocalAddress(dir, "http://127.0.0.1:8081/");
      expect(runningAddress(dir)).toBe("http://127.0.0.1:8081/");
      expect(statSync(join(dir, "address")).mode & 0o777).toBe(0o600);
      writeFileSync(join(dir, "address"), "http://evil.example.invalid/\n");
      expect(runningAddress(dir)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("asking the running orchestrator for a fresh link", () => {
  it("given the running one's reentry secret, a wrong one and none, when a fresh link is asked for, then only the right secret gets a link, and the secret file is its owner's alone", async () => {
    const dir = mkdtempSync(join(tmpdir(), "th-local-reentry-"));
    try {
      // given
      let minted = 0;
      const app = localLinkRoutes(dir, async () => `http://127.0.0.1:8081/api/auth/local?token=t${++minted}`);
      const fetcher = ((url: string, init?: RequestInit) => app.request(new URL(url).pathname, init)) as typeof fetch;

      // when
      const asked = await askForLink(dir, "http://127.0.0.1:8081/", fetcher);
      const wrong = await app.request("/api/local/link", { method: "POST", headers: { "x-reentry-secret": "a".repeat(43) } });
      const none = await app.request("/api/local/link", { method: "POST" });

      // then
      expect(asked).toBe("http://127.0.0.1:8081/api/auth/local?token=t1");
      expect([wrong.status, none.status, minted]).toEqual([403, 403, 1]);
      expect(statSync(join(dir, "reentry")).mode & 0o777).toBe(0o600);
      expect(reentrySecret(dir)).toHaveLength(43);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("given a running orchestrator that does not answer or answers a link elsewhere, when a fresh link is asked for, then none is given", async () => {
    const dir = mkdtempSync(join(tmpdir(), "th-local-reentry-"));
    try {
      const down = (async () => Promise.reject(new Error("refused"))) as unknown as typeof fetch;
      const elsewhere = (async () => new Response(JSON.stringify({ url: "http://evil.example.invalid/" }), { status: 200 })) as unknown as typeof fetch;
      expect(await askForLink(dir, "http://127.0.0.1:8081/", down)).toBeNull();
      expect(await askForLink(dir, "http://127.0.0.1:8081/", elsewhere)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("the page a local start opens", () => {
  it("given a one-time link, when the page that opens it is written, then the browser is sent on to the link from a file only its owner reads, and the link is quoted so it ends where it should", () => {
    const dir = mkdtempSync(join(tmpdir(), "th-local-open-"));
    try {
      const file = signInPage(dir, 'http://127.0.0.1:8080/api/auth/local?token=abc&x="<');
      const page = readFileSync(file, "utf8");
      expect(statSync(file).mode & 0o777).toBe(0o600);
      expect(page).toContain('content="0;url=http://127.0.0.1:8080/api/auth/local?token=abc&amp;x=&quot;&lt;"');
      expect(page).toContain('<meta name="referrer" content="no-referrer">');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("the name a local orchestrator gives its person", () => {
  it("given a name set in git, none, and one of spaces, when the owner is named, then it is git's name or \"you\", never the system account's", () => {
    expect(localOwnerName(() => "Ada Lovelace\n")).toBe("Ada Lovelace");
    expect(localOwnerName(() => null)).toBe("you");
    expect(localOwnerName(() => "   ")).toBe("you");
  });
});

describe("the machine a local orchestrator runs its person's tasks on", () => {
  it("given a first start, a second, and a row someone revoked, when the machine is looked up, then it is made once, found again, and made anew once revoked, with no token anyone holds", async () => {
    const store = openSqliteStore(":memory:");
    try {
      // given
      const owner = { id: "usr_ada" };

      // when
      const first = await localMachine(store, "default", owner, "workstation", "darwin");
      const again = await localMachine(store, "default", owner, "workstation", "darwin");
      await store.revokeMachine("default", first.id, new Date().toISOString());
      const anew = await localMachine(store, "default", owner, "workstation", "darwin");

      // then
      expect(first).toMatchObject({ userId: "usr_ada", name: "workstation", platform: "darwin", publicKey: "" });
      expect(again.id).toBe(first.id);
      expect(anew.id).not.toBe(first.id);
      expect((await store.listMachines("default", "usr_ada")).filter((m) => !m.revokedAt).map((m) => m.id)).toEqual([anew.id]);
    } finally {
      await store.close();
    }
  });
});

describe("a folder on Windows, from WSL", () => {
  it("given WSL and a folder under /mnt/ and one elsewhere, when each is refused as outside the home, then only the one on Windows is told to be cloned inside WSL", () => {
    // given
    const wsl = { WSL_DISTRO_NAME: "Stand-In" };

    // when
    const told = [onWindowsFromWsl("/mnt/c/code/shop", wsl), onWindowsFromWsl("/srv/shop", wsl)];

    // then
    expect(told).toEqual(["that folder is on Windows, outside your home folder in WSL; clone it inside WSL, for instance into ~/code, where git and the agent are fast", null]);
  });
});
