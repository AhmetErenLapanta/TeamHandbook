import type { OrchestratorContext } from "../app.js";
import { forgeDestination } from "../connect.js";
import { OrchestratorError } from "../errors.js";
import { pinnedFetch } from "./pinned-fetch.js";
import type { ForgeConfig } from "./types.js";

/**
 * An image attached to an issue or a request on a private repository, passed through to the
 * browser, which holds no sign-in to the forge. The forge's credential goes only to the forge's
 * own address the image starts at; a redirect elsewhere, to the object storage that holds the
 * file, is followed by hand with no credential, at most three times, each address judged before
 * it is reached as every forge call is. Raster images alone come back: an SVG carries script.
 */

const REDIRECTS = 3;
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif"]);
const TIMEOUT_MS = 20_000;

export class MediaRefused extends OrchestratorError {
  constructor(message: string, status: 404 | 409 | 422 | 502 = 502) {
    super("media", message, status);
  }
}

export interface Media {
  type: string;
  body: ArrayBuffer;
}

/** Fetches the image at `start` with `headers` sent to `start`'s origin alone. */
export async function fetchMedia(ctx: Pick<OrchestratorContext, "resolveHost" | "internalForgeHosts" | "privateNetworkForges">, start: URL, headers: Record<string, string>): Promise<Media> {
  let url = start;
  for (let hop = 0; hop <= REDIRECTS; hop++) {
    if (hop > 0 && url.protocol !== "https:" && url.protocol !== start.protocol) throw new MediaRefused("the image was redirected to an address that is not https");
    const send = pinnedFetch(url.host, await forgeDestination(ctx, url));
    const answer = await send(url, { headers: { accept: "image/*", ...(url.origin === start.origin ? headers : {}) }, signal: AbortSignal.timeout(TIMEOUT_MS) }).catch((err: Error) => {
      throw new MediaRefused(`the image was not fetched: ${err.message}`);
    });
    const location = answer.headers.get("location");
    if (answer.status >= 300 && answer.status < 400 && location) {
      url = new URL(location, url);
      continue;
    }
    if (answer.status === 404) throw new MediaRefused("the forge has no such image", 404);
    if (answer.status !== 200) throw new MediaRefused(`the forge answered ${answer.status} for the image`);
    const type = (answer.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
    if (!IMAGE_TYPES.has(type)) throw new MediaRefused(`the forge answered with ${type || "no type"}, not a PNG, JPEG, GIF, WebP or AVIF image`, 422);
    return { type, body: await answer.arrayBuffer() };
  }
  throw new MediaRefused(`the image was redirected more than ${REDIRECTS} times`);
}

const GITLAB_UPLOAD = /^\/uploads\/([0-9a-f]{32})\/([^/?#]+)$/;

/**
 * A GitLab upload of this project, as its markdown writes it (`/uploads/<secret>/<file>`, relative
 * to the project) or as its page shows it, read through the API, which takes a token where the
 * page wants a browser's session.
 */
export function gitlabMedia(config: ForgeConfig, web: string, src: string): URL | null {
  const projectPath = `/${config.project}`;
  let path = src;
  if (!src.startsWith("/uploads/")) {
    const url = URL.canParse(src) ? new URL(src) : null;
    if (!url || url.origin !== web || url.search || !url.pathname.startsWith(`${projectPath}/uploads/`)) return null;
    path = url.pathname.slice(projectPath.length);
  }
  const upload = GITLAB_UPLOAD.exec(path);
  if (!upload) return null;
  const api = `${config.apiUrl}/projects/${encodeURIComponent(config.project)}/uploads/${upload[1]}/${upload[2]}`;
  // A file named `..` or `%2e%2e` is folded away by the URL parser, and the token would read another API path.
  return new URL(api).href === api ? new URL(api) : null;
}

const GITHUB_ASSET = /^\/(?:user-attachments\/assets\/[0-9a-f-]{36}|([^/]+\/[^/]+)\/assets\/\d+\/[0-9a-f-]{36})$/;

/** A file attached on GitHub: one in `user-attachments`, or one under this repository's own `assets`. */
export function githubMedia(config: ForgeConfig, web: string, src: string): URL | null {
  const url = URL.canParse(src) ? new URL(src) : null;
  if (!url || url.origin !== web || url.search) return null;
  const asset = GITHUB_ASSET.exec(url.pathname);
  if (!asset || (asset[1] !== undefined && asset[1].toLowerCase() !== config.project.toLowerCase())) return null;
  return url;
}

const GITEA_ATTACHMENT = /^\/(?:([^/]+\/[^/]+)\/)?attachments\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

/**
 * A file attached on Gitea, as its markdown writes it (`/attachments/<uuid>`) or under this
 * repository's path, read at Gitea's own `/attachments/<uuid>`, which takes a token. Gitea checks
 * the token's account may read the repository the attachment belongs to, whatever path names it,
 * so a path naming another repository is refused here rather than read.
 */
export function giteaMedia(config: ForgeConfig, web: string, src: string): URL | null {
  const root = config.apiUrl.replace(/\/api\/v1\/?$/, "");
  const base = new URL(root).pathname.replace(/\/+$/, "");
  const url = src.startsWith("/") && !src.startsWith("//") ? new URL(`${root}${src}`) : URL.canParse(src) ? new URL(src) : null;
  if (!url || url.origin !== web || url.origin !== new URL(root).origin || url.search || url.hash || !url.pathname.startsWith(`${base}/`)) return null;
  const attachment = GITEA_ATTACHMENT.exec(url.pathname.slice(base.length));
  if (!attachment || (attachment[1] !== undefined && attachment[1].toLowerCase() !== config.project.toLowerCase())) return null;
  return new URL(`${root}/attachments/${attachment[2]}`);
}
