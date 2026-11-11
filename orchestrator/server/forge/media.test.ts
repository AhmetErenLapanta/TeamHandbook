import { createServer } from "node:http";
import type { IncomingHttpHeaders, RequestListener, Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { fetchMedia, giteaMedia, githubMedia, gitlabMedia, MediaRefused } from "./media.js";
import type { ForgeConfig } from "./types.js";

const SECRET = "0123456789abcdef0123456789abcdef";
const TOKEN = "glpat-stand-in-media-0001";
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const servers: Server[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
});

/** A server on this machine that records what each request carried. */
async function serve(answer: RequestListener): Promise<{ origin: string; host: string; seen: { url: string; headers: IncomingHttpHeaders }[] }> {
  const seen: { url: string; headers: IncomingHttpHeaders }[] = [];
  const server = createServer((req, res) => {
    seen.push({ url: req.url ?? "", headers: req.headers });
    answer(req, res);
  });
  servers.push(server);
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const host = `127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { origin: `http://${host}`, host, seen };
}

/** The object storage a forge keeps attachments in, answering every path with `type`. */
const storage = (type: string) => serve((_req, res) => res.writeHead(200, { "content-type": type }).end(PNG));

/** A forge that redirects every image to `to`. */
const forge = (to: (path: string) => string) => serve((req, res) => res.writeHead(302, { location: to(req.url ?? "/") }).end());

const allowing = (...hosts: string[]) => ({ resolveHost: async () => ["127.0.0.1"], internalForgeHosts: new Set(hosts) });

describe("an image passed through from a forge", () => {
  it("given a GitLab upload kept in object storage, when it is fetched, then the token reaches the forge alone and the image comes back", async () => {
    const store = await storage("image/png");
    const gitlab = await forge((path) => `${store.origin}/bucket${path}`);

    const media = await fetchMedia(allowing(gitlab.host, store.host), new URL(`${gitlab.origin}/api/v4/projects/acme%2Fskills/uploads/${SECRET}/shot.png`), { "private-token": TOKEN });

    expect(media.type).toBe("image/png");
    expect(Buffer.from(media.body)).toEqual(PNG);
    expect(gitlab.seen[0]!.headers["private-token"]).toBe(TOKEN);
    expect(store.seen).toHaveLength(1);
    expect(JSON.stringify(store.seen)).not.toContain(TOKEN);
  });

  it("given a forge redirecting more than three times, when an image is fetched, then it is refused after the third", async () => {
    const loop = await serve((req, res) => res.writeHead(302, { location: `/hop${req.url}` }).end());

    await expect(fetchMedia(allowing(loop.host), new URL(`${loop.origin}/start.png`), {})).rejects.toThrow(/redirected more than 3 times/);
    expect(loop.seen).toHaveLength(4);
  });

  it("given a redirect to an address inside the network the operator did not allow, when an image is fetched, then it is refused before anything reaches that address", async () => {
    const inside = await storage("image/png");
    const gitlab = await forge(() => `${inside.origin}/metadata`);

    await expect(fetchMedia(allowing(gitlab.host), new URL(`${gitlab.origin}/img.png`), { "private-token": TOKEN })).rejects.toThrow(/ORCHESTRATOR_INTERNAL_FORGE_HOSTS/);
    expect(inside.seen).toEqual([]);
  });

  it("given an SVG or a page instead of an image, when it is fetched, then it is refused, so no script reaches the browser from the orchestrator's address", async () => {
    for (const type of ["image/svg+xml", "text/html; charset=utf-8"]) {
      const store = await storage(type);
      const refused = await fetchMedia(allowing(store.host), new URL(`${store.origin}/img.png`), {}).catch((err: Error) => err);
      expect(refused).toBeInstanceOf(MediaRefused);
      expect(refused).toMatchObject({ status: 422 });
    }
  });

  it("given an image announced beyond 8 MB, or sent with no length and running past it, when it is fetched, then it is refused and no more than the cap is held", async () => {
    const announced = await serve((_req, res) => res.writeHead(200, { "content-type": "image/png", "content-length": String(64 * 1024 * 1024) }).end());
    const endless = await serve((_req, res) => {
      res.writeHead(200, { "content-type": "image/png" });
      const chunk = Buffer.alloc(1024 * 1024);
      let sent = 0;
      const more = () => {
        while (sent < 16 && res.write(chunk)) sent++;
        if (sent < 16) res.once("drain", () => (sent++, more()));
        else res.end();
      };
      res.on("error", () => undefined);
      more();
    });

    for (const server of [announced, endless]) {
      await expect(fetchMedia(allowing(server.host), new URL(`${server.origin}/big.png`), {})).rejects.toThrow(/more than 8 MB/);
    }
  });

  it("given a forge answering 404, when an image is fetched, then it says the forge has no such image", async () => {
    const gone = await serve((_req, res) => res.writeHead(404).end());

    await expect(fetchMedia(allowing(gone.host), new URL(`${gone.origin}/img.png`), {})).rejects.toMatchObject({ status: 404, message: "the forge has no such image" });
  });
});

describe("which images a repository's credential is used for", () => {
  const GITLAB: ForgeConfig = { repoId: "skills", kind: "gitlab", apiUrl: "https://gitlab.example.invalid/api/v4", project: "acme/skills" };
  const GITHUB: ForgeConfig = { repoId: "skills", kind: "github", apiUrl: "https://api.github.com", project: "acme/skills" };
  const GITLAB_WEB = "https://gitlab.example.invalid";

  it("given a GitLab upload of the project, as markdown or as its page writes it, when it is mapped, then it is read through the project's uploads API", () => {
    const api = `https://gitlab.example.invalid/api/v4/projects/acme%2Fskills/uploads/${SECRET}/shot.png`;
    expect(gitlabMedia(GITLAB, GITLAB_WEB, `/uploads/${SECRET}/shot.png`)?.href).toBe(api);
    expect(gitlabMedia(GITLAB, GITLAB_WEB, `${GITLAB_WEB}/acme/skills/uploads/${SECRET}/shot.png`)?.href).toBe(api);
  });

  it("given another project's upload, another host, a query, a path climbing out or any other GitLab page, when it is mapped, then nothing is read", () => {
    for (const src of [
      `${GITLAB_WEB}/acme/other/uploads/${SECRET}/shot.png`,
      `https://elsewhere.example.invalid/acme/skills/uploads/${SECRET}/shot.png`,
      `/uploads/${SECRET}/shot.png?x=1`,
      `/uploads/${SECRET}/../../../user`,
      `/uploads/${SECRET}/..`,
      `/uploads/${SECRET}/%2e%2e`,
      `${GITLAB_WEB}/api/v4/user`,
      "/uploads/short/shot.png",
    ]) {
      expect(gitlabMedia(GITLAB, GITLAB_WEB, src)).toBeNull();
    }
  });

  it("given a GitHub attachment, or one under this repository's assets, when it is mapped, then it is read as given; another repository's asset or any other page is not", () => {
    const uuid = "0a1b2c3d-4e5f-6071-8293-a4b5c6d7e8f9";
    expect(githubMedia(GITHUB, "https://github.com", `https://github.com/user-attachments/assets/${uuid}`)?.href).toBe(`https://github.com/user-attachments/assets/${uuid}`);
    expect(githubMedia(GITHUB, "https://github.com", `https://github.com/Acme/Skills/assets/42/${uuid}`)).not.toBeNull();
    for (const src of [`https://github.com/acme/other/assets/42/${uuid}`, "https://github.com/settings/tokens", `https://gist.github.com/user-attachments/assets/${uuid}`, `https://github.com/user-attachments/assets/${uuid}?raw=1`]) {
      expect(githubMedia(GITHUB, "https://github.com", src)).toBeNull();
    }
  });

  it("given a Gitea attachment, as markdown writes it or under this repository's path, even on a Gitea served below a path, when it is mapped, then it is read at Gitea's own attachments address", () => {
    const uuid = "0a1b2c3d-4e5f-6071-8293-a4b5c6d7e8f9";
    const GITEA: ForgeConfig = { repoId: "skills", kind: "gitea", apiUrl: "https://git.example.invalid/api/v1", project: "acme/skills" };
    const BELOW: ForgeConfig = { ...GITEA, apiUrl: "https://git.example.invalid/gitea/api/v1" };
    const web = "https://git.example.invalid";

    expect(giteaMedia(GITEA, web, `/attachments/${uuid}`)?.href).toBe(`${web}/attachments/${uuid}`);
    expect(giteaMedia(GITEA, web, `${web}/attachments/${uuid}`)?.href).toBe(`${web}/attachments/${uuid}`);
    expect(giteaMedia(GITEA, web, `${web}/Acme/Skills/attachments/${uuid}`)?.href).toBe(`${web}/attachments/${uuid}`);
    expect(giteaMedia(BELOW, web, `/attachments/${uuid}`)?.href).toBe(`${web}/gitea/attachments/${uuid}`);
    expect(giteaMedia(BELOW, web, `${web}/gitea/acme/skills/attachments/${uuid}`)?.href).toBe(`${web}/gitea/attachments/${uuid}`);
  });

  it("given another repository's path, another host, a query, a short or climbing name, a protocol-relative address or any other Gitea page, when it is mapped, then nothing is read", () => {
    const uuid = "0a1b2c3d-4e5f-6071-8293-a4b5c6d7e8f9";
    const GITEA: ForgeConfig = { repoId: "skills", kind: "gitea", apiUrl: "https://git.example.invalid/api/v1", project: "acme/skills" };
    const web = "https://git.example.invalid";
    for (const src of [
      `${web}/acme/other/attachments/${uuid}`,
      `https://elsewhere.example.invalid/attachments/${uuid}`,
      `//elsewhere.example.invalid/attachments/${uuid}`,
      `/attachments/${uuid}?download=1`,
      `/attachments/${uuid}#x`,
      "/attachments/0a1b2c3d",
      `/attachments/../api/v1/user`,
      `/attachments/%2e%2e/api/v1/user`,
      `${web}/api/v1/user`,
      `${web}/user/settings/applications`,
    ]) {
      expect(giteaMedia(GITEA, web, src)).toBeNull();
    }
  });
});
