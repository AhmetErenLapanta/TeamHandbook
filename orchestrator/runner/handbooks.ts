import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { deleteOwnFile, readForEditing, writeOwnFile } from "../server/tasks/handbook-files.js";
import { readSkill, readSources } from "../server/tasks/handbook-sources.js";
import type { ReadSources } from "../server/tasks/handbook-sources.js";
import { listedPlugins, probePersonalSetup } from "../server/tasks/personal-setup.js";
import { PLUGIN_OPS, runPluginOp } from "../server/tasks/plugin-install.js";
import { personalEnv } from "../server/tasks/profile.js";
import { folderPlace } from "./folders.js";
import type { MachineWhere } from "./folders.js";
import type { SetupAnswer, SetupAsk } from "./link.js";

const NAME = /^[A-Za-z0-9._@-]{1,100}$/;
const FILE_NAME = /^[A-Za-z0-9._:-]{1,100}$/;
const READ_TIMEOUT_MS = 30_000;

export async function setupHere(ask: SetupAsk, where: MachineWhere, hostEnv: Record<string, string | undefined>, program: string): Promise<SetupAnswer> {
  if (ask.want === "plugin" && !PLUGIN_OPS.includes(ask.op)) return { refused: "this runner does not run that command" };
  if ((ask.want === "skill" || ask.want === "file") && !FILE_NAME.test(ask.name)) return { refused: "that is not a name this runner takes" };
  if (ask.want === "plugin" && !NAME.test(ask.plugin.slice("plugin:".length))) return { refused: "that is not a name this runner takes" };
  const home = await realpath(where.home).catch(() => where.home);
  const folder = ask.want === "plugin" || ask.want === "marketplaces" ? null : ask.folder;
  const place = folder ? await folderPlace(folder.path, folder.projectId, where) : null;
  if (place && "refused" in place) return place;
  const root = await mkdtemp(join(tmpdir(), "handbook-setup-"));
  try {
    const paths = { root, work: root, home: join(root, "home"), tmp: join(root, "tmp"), git: join(root, "git") };
    await Promise.all([paths.home, paths.tmp].map((dir) => mkdir(dir)));
    const env = personalEnv(hostEnv, paths);
    const fromHome = (id: string) => (id.startsWith("folder:~/") ? `folder:${home}/${id.slice("folder:~/".length)}` : id);
    const read = async (): Promise<ReadSources> => {
      const plugins = (await listedPlugins(program, env, root, READ_TIMEOUT_MS)) ?? [];
      const personal = await probePersonalSetup(program, env, root, place ? [place.folder] : [], READ_TIMEOUT_MS).catch(() => null);
      return readSources({ claudeDir: hostEnv.CLAUDE_CONFIG_DIR || join(home, ".claude"), ...(place && folder ? { folder: place.folder, folderTrusted: folder.trusted } : {}), plugins, personal });
    };
    if (ask.want === "marketplaces") return runPluginOp(program, env, root, "check", "", "user");
    if (ask.want === "sources") {
      const { sources } = await read();
      return { sources: sources.map((source) => ({ ...source, id: source.id.startsWith(`folder:${home}${sep}`) ? `folder:~/${source.id.slice(`folder:${home}${sep}`.length)}` : source.id })) };
    }
    if (ask.want === "skill") return readSkill(await read(), fromHome(ask.source), ask.name);
    if (ask.want === "plugin") {
      const plugin = (await read()).sources.find((s) => s.kind === "plugin" && s.id === ask.plugin);
      if (!plugin?.marketplace || !plugin.scope) return { refused: "that is not a plugin of yours this runner changes" };
      return runPluginOp(program, env, root, ask.op, `${plugin.name}@${plugin.marketplace}`, plugin.scope);
    }
    const source = fromHome(ask.source);
    const own = source === "yours" || source.startsWith("folder:") ? (await read()).roots.get(source) : undefined;
    if (!own) return { refused: "only your own files and a project folder's are changed from here" };
    if (ask.act === "read") return (await readForEditing(own, ask.kind, ask.name)) ?? { content: null, digest: null };
    if (ask.act === "write") return typeof ask.content === "string" && (ask.expectedDigest === null || typeof ask.expectedDigest === "string") ? writeOwnFile(own, ask.kind, ask.name, ask.content, ask.expectedDigest ?? null) : { refused: "a write says the text and the digest it opened" };
    return typeof ask.expectedDigest === "string" ? deleteOwnFile(own, ask.kind, ask.name, ask.expectedDigest) : { refused: "a delete says the digest it opened" };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
