import { formatInitSuccess, initTeamRepo } from "../lib/init.js";

function usage(): never {
  console.error("usage: init.js <git-url> [--name <marketplace-name>]");
  process.exit(2);
}

function main(): void {
  const args = process.argv.slice(2);
  let url: string | undefined;
  let name: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--name") {
      name = args[++i];
      if (!name) usage();
    } else if (!url) {
      url = args[i];
    } else {
      usage();
    }
  }
  if (!url) usage();
  const result = initTeamRepo(url, name);
  if (!result.ok) {
    console.error(`error: ${result.error}`);
    process.exit(1);
  }
  console.log(formatInitSuccess(result));
}

main();
