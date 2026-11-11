import { createServer } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { ANSWER_MAX, pinnedFetch } from "./pinned-fetch.js";

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((resolve) => s.close(resolve))));
});

async function answering(size: number): Promise<number> {
  const server = createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json", "x-seen-host": req.headers.host ?? "" });
    res.end(size ? "x".repeat(size) : JSON.stringify({ ok: true }));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as AddressInfo).port;
}

describe("a fetch held to one address", () => {
  it("given a name nothing resolves, when it is called, then it reaches the address it was held to and sends the name as the host", async () => {
    const port = await answering(0);
    const send = pinnedFetch(`gitlab.stand-in.invalid:${port}`, "127.0.0.1");
    const res = await send(`http://gitlab.stand-in.invalid:${port}/api/v4/user`);
    expect(await res.json()).toEqual({ ok: true });
    expect(res.headers.get("x-seen-host")).toBe(`gitlab.stand-in.invalid:${port}`);
  });

  it("given another host, when it is called, then it is refused before anything is sent", async () => {
    const send = pinnedFetch("gitlab.example.com", "127.0.0.1");
    await expect(send("https://elsewhere.example.com/oauth/token")).rejects.toThrow(/reaches gitlab.example.com alone/);
  });

  it("given an answer larger than the limit, when it arrives, then the call fails rather than holding it", async () => {
    const port = await answering(ANSWER_MAX + 1);
    const send = pinnedFetch(`127.0.0.1:${port}`, "127.0.0.1");
    await expect(send(`http://127.0.0.1:${port}/`)).rejects.toThrow(/more than/);
  });
});
