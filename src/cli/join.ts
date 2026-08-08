import { formatJoinSuccess, joinTeamRepo } from "../lib/join.js";

function usage(): never {
  console.error("usage: join.js <git-url>");
  process.exit(2);
}

function main(): void {
  const [url, extra] = process.argv.slice(2);
  if (!url || extra) usage();
  const result = joinTeamRepo(url);
  if (!result.ok) {
    console.error(`error: ${result.error}`);
    process.exit(1);
  }
  console.log(formatJoinSuccess(result));
}

main();
