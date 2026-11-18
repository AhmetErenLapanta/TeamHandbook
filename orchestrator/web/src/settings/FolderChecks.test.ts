import { describe, expect, it } from "vitest";
import { foundSaid } from "./FolderChecks";

describe("the checks found for a folder, said once", () => {
  it.each([
    [["npm test"], "npm test was found for this folder; approve it to run after each task."],
    [["npm test", "npm run lint"], "npm test and npm run lint were found for this folder; approve them to run after each task."],
    [["npm test", "npm run lint", "npm run build"], "npm test, npm run lint and npm run build were found for this folder; approve them to run after each task."],
  ])("given %j, when it is said, then it reads %s", (commands, expected) => {
    // when
    const said = foundSaid(commands);

    // then
    expect(said).toBe(expected);
  });
});
