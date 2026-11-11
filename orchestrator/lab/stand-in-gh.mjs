#!/usr/bin/env node
// GitHub's gh on a clean machine, signed in to github.com: `gh api` reads go to the lab's stand-in
// GitHub with the lab's token and come back with github.com's addresses, as the real gh's would.
// Every call is written down; anything but `auth status` and `api` fails, so nothing is pushed
// or opened anywhere.
import { appendFileSync } from "node:fs";

const [forge, token, log] = [process.env.LAB_GH_FORGE, process.env.LAB_GH_TOKEN, process.env.LAB_GH_LOG];
const args = process.argv.slice(2);
appendFileSync(log, `${JSON.stringify(args)}\n`);

const host = args[args.indexOf("--hostname") + 1];
if (host !== "github.com") process.exit(1);
if (args[0] === "auth" && args[1] === "status") process.exit(0);
if (args[0] !== "api") process.exit(1);
const path = args[3];
if (path === "user") {
  process.stdout.write(JSON.stringify({ login: "solo-person" }));
  process.exit(0);
}
const res = await fetch(`${forge}/api/${path}`, { headers: { authorization: `Bearer ${token}` } });
const text = (await res.text()).replaceAll(`${forge}/api`, "https://api.github.com").replaceAll(forge, "https://github.com");
if (!res.ok) {
  process.stderr.write(`gh: HTTP ${res.status}\n`);
  process.exit(1);
}
process.stdout.write(text);
