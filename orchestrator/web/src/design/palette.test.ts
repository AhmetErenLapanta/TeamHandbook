import { describe, expect, it } from "vitest";
import { folderAsk, folderUp, jumpsFor, MOST_A_GROUP } from "./palette";
import type { Jump } from "./palette";

const JUMPS: Jump[] = [
  { label: "Tasks", detail: "Agent tasks", to: "/demo/tasks", group: "Pages" },
  { label: "Settings", detail: "Your account", to: "/demo/settings", group: "Pages" },
  { label: "payments-api", detail: "Platform", to: "/demo/tasks?repo=payments-api", group: "Repositories" },
  { label: "Retry failed webhook payments", detail: "payments-api", to: "/demo/tasks/1", group: "Tasks" },
];

describe("jumpsFor", () => {
  it("given nothing typed, when the jumps are read, then none is listed", () => {
    // given
    const query = "  ";

    // when
    const found = jumpsFor(JUMPS, query);

    // then
    expect(found).toEqual([]);
  });

  it("given a word in a repository's name and a task's title, when the jumps are read, then the repository comes before the task, pages first", () => {
    // given
    const query = "Pay";

    // when
    const found = jumpsFor(JUMPS, query);

    // then
    expect(found.map((j) => j.to)).toEqual(["/demo/tasks?repo=payments-api", "/demo/tasks/1"]);
  });

  it("given a word only in a page's detail, when the jumps are read, then the page is found by it", () => {
    // given
    const query = "account";

    // when
    const found = jumpsFor(JUMPS, query);

    // then
    expect(found.map((j) => j.label)).toEqual(["Settings"]);
  });

  it("given more tasks match than a group lists, when the jumps are read, then the group stops at its most, a title starting with the word first", () => {
    // given
    const many: Jump[] = [...Array(8)].map((_, i) => ({ label: i === 7 ? "Fix the docs" : `Write fix ${i}`, detail: "", to: `/t/${i}`, group: "Tasks" }));

    // when
    const found = jumpsFor(many, "fix");

    // then
    expect(found).toHaveLength(MOST_A_GROUP);
    expect(found[0]!.label).toBe("Fix the docs");
  });
});

describe("the folder path typed into the palette", () => {
  it("given a path ending in a slash, one without, words, or nothing, when the folder list is asked for, then it looks inside, keeps the names that start with the last part, searches, or asks nothing", () => {
    // given
    const typed = ["~/code/", "~/code/sh", "~/sh", "/srv/repos/", "~", "shop", "  "];

    // when
    const asked = typed.map(folderAsk);

    // then
    expect(asked).toEqual([{ under: "~/code" }, { under: "~/code", prefix: "sh" }, { under: "~", prefix: "sh" }, { under: "/srv/repos" }, { under: "~" }, { q: "shop" }, null]);
  });

  it("given a folder path ending in a slash, when Backspace takes it up, then it stands in the parent, and home and the root stay where they are", () => {
    // given
    const typed = ["~/code/shop/", "~/code/", "/srv/repos/", "~/", "/", "~/code/sh"];

    // when
    const up = typed.map(folderUp);

    // then
    expect(up).toEqual(["~/code/", "~/", "/srv/", null, null, null]);
  });
});
