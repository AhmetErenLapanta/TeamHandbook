import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";

/** The most a forge's answer may hold: far beyond a page of repositories or a token, and short of filling memory. */
export const ANSWER_MAX = 8 * 1024 * 1024;

/**
 * A fetch held to one host and one address judged for it beforehand: the connection goes to that
 * address whatever the name resolves to by then, TLS still checks the name, and any other host is
 * refused. An address an owner entered could otherwise be answered by a public address when it is
 * judged and by one inside the orchestrator's network when the client secret or a refresh token is sent.
 * Redirects are never followed, as with every forge call.
 */
export function pinnedFetch(host: string, address: string): typeof fetch {
  const family = isIP(address);
  return (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(input instanceof Request ? input.url : input);
    if (url.host !== host) throw new TypeError(`this connection reaches ${host} alone`);
    const send = url.protocol === "https:" ? httpsRequest : httpRequest;
    const headers = Object.fromEntries(new Headers(init.headers).entries());
    const body = typeof init.body === "string" ? init.body : init.body === undefined || init.body === null ? undefined : String(init.body);
    return new Promise<Response>((resolve, reject) => {
      const req = send(
        url,
        {
          method: init.method ?? "GET",
          headers: { ...headers, ...(body === undefined ? {} : { "content-length": String(Buffer.byteLength(body)) }) },
          lookup: (_name, options, callback) => {
            if ((options as { all?: boolean }).all) (callback as (err: null, addresses: { address: string; family: number }[]) => void)(null, [{ address, family }]);
            else (callback as (err: null, address: string, family: number) => void)(null, address, family);
          },
        },
        (res) => {
          // A length announced beyond the cap is refused before a byte of it is read; one not
          // announced, or announced short, is cut where the count passes the cap.
          if (Number(res.headers["content-length"]) > ANSWER_MAX) {
            req.destroy();
            return reject(new TypeError(`${host} answered with more than ${ANSWER_MAX / 1024 / 1024} MB`));
          }
          const chunks: Buffer[] = [];
          let size = 0;
          res.on("data", (chunk: Buffer) => {
            size += chunk.length;
            if (size > ANSWER_MAX) {
              req.destroy();
              return reject(new TypeError(`${host} answered with more than ${ANSWER_MAX / 1024 / 1024} MB`));
            }
            chunks.push(chunk);
          });
          res.on("end", () => {
            const status = res.statusCode ?? 0;
            const out = new Headers();
            for (const [k, v] of Object.entries(res.headers)) if (v !== undefined) out.set(k, Array.isArray(v) ? v.join(", ") : v);
            resolve(new Response([101, 204, 205, 304].includes(status) ? null : Buffer.concat(chunks), { status, headers: out }));
          });
          res.on("error", reject);
        },
      );
      init.signal?.addEventListener("abort", () => req.destroy(init.signal!.reason as Error), { once: true });
      req.on("error", reject);
      req.end(body);
    });
  }) as typeof fetch;
}
