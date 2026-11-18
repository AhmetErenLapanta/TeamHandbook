import { describe, expect, it } from "vitest";
import { listedFor, OFFICIAL_MARKETPLACE } from "./AddPlugin";
import type { Offered } from "./AddPlugin";

const plugin = (name: string, marketplace: string, description = ""): Offered => ({ id: `plugin:${name}@${marketplace}`, name, marketplace, description, skills: 1, commands: 0, hooks: [], mcpServers: [] });
const offered = [plugin("docs-kit", "payments-market", "Write docs"), plugin("lint-kit", "payments-market"), plugin("pdf-tools", OFFICIAL_MARKETPLACE, "Read PDFs"), plugin("docs-helper", OFFICIAL_MARKETPLACE, "Helps with docs")];

describe("which plugins the add list offers", () => {
  it("given a market the person added and the official one, when nothing is typed, then only the added market's plugins are listed", () => {
    // when
    const listed = listedFor(offered, "", "");

    // then
    expect(listed.map((p) => p.name)).toEqual(["docs-kit", "lint-kit"]);
  });

  it("given words, when they are typed, then the official catalogue is searched too, by name and sentence; a picked market lists its own with no words", () => {
    // when
    const searched = listedFor(offered, "docs", "");
    const official = listedFor(offered, "", OFFICIAL_MARKETPLACE);

    // then
    expect(searched.map((p) => p.name)).toEqual(["docs-kit", "docs-helper"]);
    expect(official.map((p) => p.name)).toEqual(["pdf-tools", "docs-helper"]);
  });
});
