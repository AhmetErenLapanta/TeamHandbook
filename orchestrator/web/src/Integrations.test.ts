import { describe, expect, it } from "vitest";
import { forgeGuess, reachedByPath } from "./Integrations";

describe("where a repository's requests can open", () => {
  it("given repositories read from a path, by GitLab address and by GitHub address, when each is read, then a path says so and the others name their forge's API and project", () => {
    // given
    const urls = ["file:///srv/payments-skills.git", "/srv/payments-skills.git", "https://***@gitlab.example.com/acme/payments/skills.git", "https://github.com/acme/platform-skills.git"];

    // when
    const guesses = urls.map((u) => [reachedByPath(u), forgeGuess(u)]);

    // then
    expect(guesses).toEqual([
      [true, null],
      [true, null],
      [false, { kind: "gitlab", apiUrl: "https://gitlab.example.com/api/v4", project: "acme/payments/skills" }],
      [false, { kind: "github", apiUrl: "https://api.github.com", project: "acme/platform-skills" }],
    ]);
  });

  it("given an address with no project in it or over plain http, when it is read, then nothing is guessed", () => {
    // when
    const guesses = ["https://gitlab.example.com/", "http://gitlab.example.com/acme/skills.git", "ssh://git@gitlab.example.com/acme/skills.git"].map(forgeGuess);

    // then
    expect(guesses).toEqual([null, null, null]);
  });
});
