import { describe, it, expect } from "vitest";
import { ROLE_MAILBOX, detectIdentity, maskIdentity } from "./identity.js";
import type { HostIdentity } from "./identity.js";

// Stand-in names, and the home path is assembled rather than written out: the
// repository's own hygiene gate refuses a literal absolute home path on any added line,
// including a fixture's.
const ALICE: HostIdentity = { names: ["alice"] };
const NOBODY: HostIdentity = { names: [] };
const macHome = (name: string) => ["", "Users", name].join("/");
const linuxHome = (name: string) => ["", "home", name].join("/");

describe("detectIdentity", () => {
  it.each([
    ["a home directory", `run it from ${macHome("alice")}/work/api`],
    ["a linux home directory", `cd ${linuxHome("bob")}/src && make`],
    ["a windows home directory", "open C:\\Users\\bob\\repo in the editor"],
    ["a home directory escaped into json", '{"cwd": "C:\\\\Users\\\\bob\\\\repo"}'],
  ])("reports a home path in %s", (_label, text) => {
    expect(detectIdentity(text, NOBODY)).toBe("home-path");
  });

  it.each([
    ["a hosted runner", `${linuxHome("runner")}/work/repo`],
    ["a placeholder segment", `${macHome("<you>")}/work`],
    ["an expanded variable", `${macHome("$USER")}/work`],
    ["a path already written from home", "~/work/api"],
  ])("stays silent on %s", (_label, text) => {
    expect(detectIdentity(text, NOBODY)).toBeNull();
  });

  it("reports an address", () => {
    expect(detectIdentity("ask bob@acme.corp first", NOBODY)).toBe("email");
  });

  it.each([
    ["the ssh login every forge uses", "git clone git@acme.corp:org/repo.git"],
    ["an address at a domain reserved for documentation", "set it to noreply@example.com"],
    ["a pinned dependency", "npm i esbuild@0.23.1"],
    ["a scoped package", "npm i @scope/parser"],
  ])("stays silent on %s", (_label, text) => {
    expect(detectIdentity(text, NOBODY)).toBeNull();
  });

  it.each([
    ["the ssh login of a forge, at a domain that is not reserved", "git clone git@acme.corp:org/repo.git"],
    ["a sender that takes no mail, at a domain that is not reserved", "from noreply@acme.corp"],
    ["a role account rather than a person", "file it with ci@acme.corp"],
    ["another role account", "ask build@acme.corp to rerun it"],
    ["the address a forge hands out so a commit delivers nowhere", "user.email 12345+ada@users.noreply.github.com"],
  ])("stays silent on %s", (_label, text) => {
    // These four exemptions were being carried by a domain reserved for documentation
    // rather than by the rule under test, so none of them was measured at all.
    expect(detectIdentity(text, NOBODY)).toBeNull();
  });

  it.each([
    ["a person", "write to ada@acme.corp"],
    ["the commonest mailbox a person gives themselves", "write to me@acme.corp"],
    ["another one of those", "write to dev@acme.corp"],
    ["and another", "write to you@acme.corp"],
  ])("reports an address at a real domain whose local part is %s", (_label, text) => {
    // The home-directory list holds all three of those as role accounts, and borrowing it
    // for addresses made a personal mailbox on someone's own domain shareable.
    expect(detectIdentity(text, NOBODY)).toBe("email");
  });

  // Driven off the list itself rather than a copy of it: a name that stops being exempt has
  // to show up as a behaviour change here, not as a case nobody wrote.
  it.each([...ROLE_MAILBOX])("stays silent on the mailbox role %s at a real domain", (role) => {
    expect(detectIdentity(`file it with ${role}@acme.corp`, NOBODY)).toBeNull();
  });

  it("holds exactly the roles it was reviewed with", () => {
    // The loop above walks whatever the list holds, so a deleted name simply stops being
    // tested and an added one is exempted without anyone reading it. This is the tripwire:
    // changing the list is a decision, and the decision has to be made in front of this
    // number. Every name in it has to be one that cannot be a person's own mailbox.
    expect(ROLE_MAILBOX.size).toBe(18);
  });

  it("reports the account of this machine at a real domain, whichever of the two rules names it", () => {
    // The address and the account name both stand on the same characters here, so which
    // class is reported is an ordering detail; that it is refused at all is the rule.
    expect(detectIdentity("write to alice@acme.corp", ALICE)).not.toBeNull();
  });

  it("reports the account name of the machine it runs on", () => {
    expect(detectIdentity("alice ran the migration by hand", ALICE)).toBe("os-username");
  });

  it("matches the account name whatever case it is written in", () => {
    expect(detectIdentity("filed by Alice", ALICE)).toBe("os-username");
  });

  it("leaves the account name alone where a repository owner belongs", () => {
    expect(detectIdentity("scope: example.com/alice/toolkit", ALICE)).toBeNull();
  });

  it("still reports the account name when it is only part of a longer word nowhere", () => {
    expect(detectIdentity("the palisade was rebuilt", ALICE)).toBeNull();
  });
});

describe("maskIdentity", () => {
  it("replaces a home path with the home marker and keeps the rest of the line", () => {
    expect(maskIdentity(`cd ${macHome("alice")}/work/api && npm test`, NOBODY)).toBe(
      "cd ~/work/api && npm test",
    );
  });

  it("replaces an address", () => {
    expect(maskIdentity("mail bob@acme.corp", NOBODY)).toBe("mail <email>");
  });

  it("replaces a bare account name", () => {
    expect(maskIdentity("alice pushed it", ALICE)).toBe("<user> pushed it");
  });

  it("leaves a masked string unchanged, so the order the callers apply it in cannot matter", () => {
    const once = maskIdentity(`${macHome("alice")}/work, bob@acme.corp`, ALICE);
    expect(maskIdentity(once, ALICE)).toBe(once);
    expect(detectIdentity(once, ALICE)).toBeNull();
  });

  it("masks an account name that sits inside its own home path exactly once", () => {
    expect(maskIdentity(`${macHome("alice")}/notes.md`, ALICE)).toBe("~/notes.md");
  });

  it("masks the whole of a full name, not the account name that opens it", () => {
    // A JavaScript alternation is leftmost-first, so the order the names go in decides
    // whether the rest of a name is left standing in text on its way to a model.
    const host = { names: ["ada", "Ada Lovelace"] };

    expect(maskIdentity("author Ada Lovelace wrote it", host)).toBe("author <user> wrote it");
  });

  it("returns text with no trace in it untouched", () => {
    const text = "run npm test from the repository root";
    expect(maskIdentity(text, ALICE)).toBe(text);
  });
});
