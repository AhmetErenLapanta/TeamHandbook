import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { createSocket } from "node:dgram";

/**
 * A stand-in DNS server for TXT records, so an orchestrator verifies an email domain without asking
 * any real resolver. It answers only what `records` holds - a JSON object of name to TXT
 * values, read at every query so a test publishes a record by writing the file - and NXDOMAIN
 * for everything else. An orchestrator reaches it through `preloadSource`, which points Node's own
 * resolver at it; nothing in the orchestrator changes.
 */

export interface DnsConfig {
  port: number;
  records: string;
  log: string;
}

const TXT = 16;

function questionOf(query: Buffer): { name: string; type: number; end: number } | null {
  const labels: string[] = [];
  let at = 12;
  while (at < query.length && query[at] !== 0) {
    const length = query[at]!;
    labels.push(query.subarray(at + 1, at + 1 + length).toString("ascii"));
    at += 1 + length;
  }
  if (at + 5 > query.length) return null;
  return { name: labels.join(".").toLowerCase(), type: query.readUInt16BE(at + 1), end: at + 5 };
}

function answer(query: Buffer, values: string[] | null): Buffer {
  const question = questionOf(query)!;
  const header = Buffer.alloc(12);
  header.writeUInt16BE(query.readUInt16BE(0), 0);
  header.writeUInt16BE(values ? 0x8180 : 0x8183, 2);
  header.writeUInt16BE(1, 4);
  header.writeUInt16BE(values?.length ?? 0, 6);
  const records = (values ?? []).map((value) => {
    const text = Buffer.from(value, "utf8");
    const chunks: Buffer[] = [];
    for (let i = 0; i < text.length || i === 0; i += 255) {
      const part = text.subarray(i, i + 255);
      chunks.push(Buffer.from([part.length]), part);
    }
    const data = Buffer.concat(chunks);
    const fixed = Buffer.alloc(12);
    fixed.writeUInt16BE(0xc00c, 0);
    fixed.writeUInt16BE(TXT, 2);
    fixed.writeUInt16BE(1, 4);
    fixed.writeUInt32BE(60, 6);
    fixed.writeUInt16BE(data.length, 10);
    return Buffer.concat([fixed, data]);
  });
  return Buffer.concat([header, query.subarray(12, question.end), ...records]);
}

export function startDns(config: DnsConfig): Promise<void> {
  if (!existsSync(config.records)) writeFileSync(config.records, "{}\n");
  const socket = createSocket("udp4");
  socket.on("message", (query, from) => {
    const question = questionOf(query);
    if (!question) return;
    const held = (JSON.parse(readFileSync(config.records, "utf8")) as Record<string, string[]>)[question.name];
    appendFileSync(config.log, `${new Date().toISOString()} ${question.type === TXT ? "TXT" : question.type} ${question.name} ${held ? "answered" : "nxdomain"}\n`);
    socket.send(answer(query, question.type === TXT && held ? held : null), from.port, from.address);
  });
  return new Promise((resolve) => socket.bind(config.port, "127.0.0.1", () => resolve()));
}

/** A module an orchestrator imports first, pointing Node's resolver at the stand-in. */
export function preloadSource(port: number): string {
  return `import dns from "node:dns";\ndns.setServers(["127.0.0.1:${port}"]);\ndns.promises.setServers(["127.0.0.1:${port}"]);\n`;
}

/** Run as `lab.mjs dns <config.json>`: the stand-in lives until down.sh stops it. */
export async function dnsMain(file: string): Promise<void> {
  const config = JSON.parse(readFileSync(file, "utf8")) as DnsConfig;
  await startDns(config);
  appendFileSync(config.log, `dns listening on 127.0.0.1:${config.port}\n`);
}
