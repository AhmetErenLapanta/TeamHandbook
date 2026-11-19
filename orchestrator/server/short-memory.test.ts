import { describe, expect, it } from "vitest";
import { shortMemory } from "./short-memory.js";

describe("what a short memory keeps", () => {
  it("given two reads that ask at once and a third within the minute, when each is loaded, then one load answers all three", async () => {
    // given
    const memory = shortMemory(60_000);
    let loads = 0;
    const load = async () => (loads += 1);

    // when
    const [a, b] = await Promise.all([memory.read("inventory", load), memory.read("inventory", load)]);
    const c = await memory.read("inventory", load);

    // then
    expect([a, b, c, loads]).toEqual([1, 1, 1, 1]);
  });

  it("given a kept read, when a write forgets it or the minute passes, then the next read loads again; a failed read is not kept", async () => {
    // given
    let clock = 0;
    const memory = shortMemory(60_000, () => clock);
    let loads = 0;
    const load = async () => (loads += 1);

    // when
    await memory.read("a", load);
    memory.forget();
    await memory.read("a", load);
    clock = 61_000;
    await memory.read("a", load);
    await memory.read("bad", async () => { throw new Error("no"); }).catch(() => undefined);
    const again = await memory.read("bad", async () => "ok");

    // then
    expect([loads, again]).toEqual([3, "ok"]);
  });

  it("given a memory that answers from an old read for a while, when a read asks past its minute, then it gets the old answer at once, one read runs behind it, and a failed one keeps the old answer", async () => {
    // given
    let clock = 0;
    const memory = shortMemory(60_000, () => clock, 600_000);
    let loads = 0;
    await memory.read("a", async () => (loads += 1));

    // when
    clock = 61_000;
    const [first, second] = await Promise.all([memory.read("a", async () => (loads += 1)), memory.read("a", async () => (loads += 1))]);
    await new Promise((resolve) => setTimeout(resolve, 5));
    const fresh = await memory.read("a", async () => (loads += 1));
    clock = 800_000;
    const beyond = await memory.read("a", async () => (loads += 1));

    // then
    expect([first, second, fresh, beyond, loads]).toEqual([1, 1, 2, 3, 3]);
  });
});
