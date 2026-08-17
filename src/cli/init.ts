import { formatInitSuccess, initTeamRepo } from "../lib/init.js";

function usage(): never {
  console.error("usage: init.js <git-url> [--name <marketplace-name>] [--branch-prefix <prefix>] [--commit-prefix <prefix>] [--with-ci]");
  process.exit(2);
}

function main(): void {
  const args = process.argv.slice(2);
  let url: string | undefined;
  let name: string | undefined;
  let branchPrefix: string | undefined;
  let commitPrefix: string | undefined;
  let withCi = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--name") {
      name = args[++i];
      if (!name) usage();
    } else if (args[i] === "--branch-prefix") {
      branchPrefix = args[++i];
      if (!branchPrefix) usage();
    } else if (args[i] === "--commit-prefix") {
      commitPrefix = args[++i];
      if (!commitPrefix) usage();
    } else if (args[i] === "--with-ci") {
      withCi = true;
    } else if (!url) {
      url = args[i];
    } else {
      usage();
    }
  }
  if (!url) usage();
  const result = initTeamRepo(url, name, undefined, undefined, undefined, undefined, branchPrefix, commitPrefix, withCi);
  if (!result.ok) {
    console.error(`error: ${result.error}`);
    process.exit(1);
  }
  console.log(formatInitSuccess(result));
}

main();
