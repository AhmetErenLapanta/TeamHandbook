// `node scripts/merge-release.mjs <out> <dir>...`: the release workflow's step between the
// platform builds and signing. Each <dir> holds what one runner's `npm run build:release` made
// (its archive and manifest.json); <out> gets every archive, one SHA256SUMS and one manifest.json
// over all of them, install.sh and install.ps1. Each archive is summed again here rather than
// taken from its runner's manifest, and a release missing a platform is refused, so what is
// signed next is exactly what is published.
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// The release workflow's build matrix.
const PLATFORMS = ["darwin-arm64", "linux-arm64", "linux-x64"];

const orchestratorDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const version = JSON.parse(readFileSync(join(orchestratorDir, "package.json"), "utf8")).version;
const [out, ...dirs] = process.argv.slice(2);

function refuse(why) {
  console.error(`merge-release: ${why}`);
  process.exit(1);
}

if (!out || !dirs.length) refuse("usage: node scripts/merge-release.mjs <out> <dir>...");
mkdirSync(out, { recursive: true });

const archives = {};
const released = [];
for (const dir of dirs) {
  const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
  if (manifest.schema !== 1 || manifest.version !== version) refuse(`${dir}/manifest.json is not a schema 1 manifest of ${version}`);
  released.push(manifest.released);
  for (const [platform, entry] of Object.entries(manifest.archives)) {
    const file = `handbook-orchestrator-${version}-${platform}.tar.gz`;
    if (!PLATFORMS.includes(platform) || entry.file !== file) refuse(`${dir}/manifest.json names ${entry.file} for ${platform}`);
    if (archives[platform]) refuse(`${platform} is built twice`);
    const bytes = readFileSync(join(dir, file));
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    if (sha256 !== entry.sha256) refuse(`${file} does not match the checksum its build wrote`);
    copyFileSync(join(dir, file), join(out, file));
    archives[platform] = { ...entry, sha256, size: statSync(join(out, file)).size };
  }
}
const missing = PLATFORMS.filter((platform) => !archives[platform]);
if (missing.length) refuse(`no build for ${missing.join(", ")}`);

const sorted = Object.fromEntries(PLATFORMS.map((platform) => [platform, archives[platform]]));
writeFileSync(join(out, "SHA256SUMS"), PLATFORMS.map((platform) => `${archives[platform].sha256}  ${archives[platform].file}`).join("\n") + "\n");
writeFileSync(join(out, "manifest.json"), JSON.stringify({ schema: 1, name: "handbook-orchestrator", version, released: released.sort()[0], archives: sorted }, null, 2) + "\n");
copyFileSync(join(orchestratorDir, "scripts", "install.sh"), join(out, "install.sh"));
copyFileSync(join(orchestratorDir, "scripts", "install.ps1"), join(out, "install.ps1"));
console.log(`${version}: ${PLATFORMS.length} archives, SHA256SUMS and manifest.json in ${out}`);
