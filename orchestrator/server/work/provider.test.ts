import { describe, expect, it } from "vitest";
import { SourceFailed, trackerJson } from "./provider.js";

const answering = (status: number, headers: Record<string, string> = {}) => (async () => new Response("{}", { status, headers })) as typeof fetch;
const refusal = async (send: typeof fetch) => trackerJson("https://tracker.example.invalid/rest/agile/1.0/board/7", {}, send).catch((err: SourceFailed) => ({ message: err.message, status: err.status }));

describe("what a tracker's refusal says on a board read", () => {
  it("given a board the token cannot see, a removed board and a refused token, when the board is read, then each says what happened and what to do", async () => {
    // given
    const refused = answering(403);
    const gone = answering(404);

    // when
    const reads = await Promise.all([refusal(refused), refusal(gone)]);

    // then
    expect(reads).toEqual([
      { message: "the tracker refused the token (403); check the token and its permissions under Integrations", status: 403 },
      { message: "the tracker has no such board; it was removed, or the token cannot see it", status: 404 },
    ]);
  });

  it("given a tracker limiting requests, when the board is read, then it says to try again after the wait it named, and in a minute when it named none", async () => {
    // given
    const named = answering(429, { "retry-after": "45" });
    const unnamed = answering(429);

    // when
    const reads = await Promise.all([refusal(named), refusal(unnamed)]);

    // then
    expect(reads).toEqual([
      { message: "the tracker is limiting requests; try again in 45 seconds", status: 429 },
      { message: "the tracker is limiting requests; try again in a minute", status: 429 },
    ]);
  });

  it("given a dropped connection, when the board is read, then it says the tracker was not reached and names neither its address nor the cause", async () => {
    // given
    const dropped = (async () => { throw new TypeError("fetch failed: ECONNRESET tracker.example.invalid"); }) as typeof fetch;

    // when
    const read = await refusal(dropped);

    // then
    expect(read).toEqual({ message: "the tracker was not reached; check the connection and try again", status: null });
  });
});
