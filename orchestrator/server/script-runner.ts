import { readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import vm from "node:vm";

/**
 * Runs a JavaScript module file the way `node <file>` would, inside the single executable
 * (handbook-orchestrator), which is a Node runtime that cannot load a module from disk on its
 * own. The orchestrator starts small scripts with its own executable as the node: the stand-in
 * agent, the personal-profile guard hook, a replayed transcript. Their imports are Node's
 * built-ins and other files beside them; node_modules is not looked up.
 * Needs --experimental-vm-modules, which the executable is built with.
 *
 * This is not isolation: a script runs with everything the executable's user can do, as
 * `node <file>` would. Only scripts the orchestrator itself writes or ships are run this way, by
 * absolute path; a repository's or an agent's content never is.
 */

type Module = InstanceType<typeof vm.SourceTextModule>;

const loaded = new Map<string, Module>();

async function builtin(specifier: string): Promise<InstanceType<typeof vm.SyntheticModule>> {
  const name = specifier.replace(/^node:/, "");
  if (!builtinModules.includes(name)) throw new Error(`${specifier} is not a Node built-in, and a script here imports only those and files beside it`);
  const namespace = (await import(`node:${name}`)) as Record<string, unknown>;
  const names = Object.keys(namespace);
  const module = new vm.SyntheticModule(names, function (this: InstanceType<typeof vm.SyntheticModule>) {
    for (const key of names) this.setExport(key, namespace[key]);
  });
  await module.link(() => {
    throw new Error("a built-in links nothing");
  });
  await module.evaluate();
  return module;
}

function fileOf(specifier: string, from: string): string | null {
  if (specifier.startsWith("file:")) return fileURLToPath(specifier);
  if (specifier.startsWith("/") || specifier.startsWith("./") || specifier.startsWith("../")) return resolve(dirname(from), specifier);
  return null;
}

async function resolveImport(specifier: string, from: string): Promise<vm.Module> {
  const file = fileOf(specifier, from);
  return file ? load(file) : builtin(specifier);
}

async function load(file: string): Promise<Module> {
  const known = loaded.get(file);
  if (known) return known;
  const url = pathToFileURL(file).href;
  const module: Module = new vm.SourceTextModule(readFileSync(file, "utf8"), {
    identifier: url,
    initializeImportMeta(meta) {
      meta.url = url;
    },
    importModuleDynamically: (async (specifier: string) => {
      const target = await resolveImport(specifier, file);
      if (target.status === "unlinked") await target.link((s: string) => resolveImport(s, file));
      if (target.status === "linked") await target.evaluate();
      return target;
    }) as never,
  });
  loaded.set(file, module);
  await module.link((specifier: string) => resolveImport(specifier, file));
  return module;
}

/** Runs `file` with `args` as its arguments; resolves when its top level has finished. */
export async function runScript(file: string, args: readonly string[]): Promise<void> {
  const path = resolve(file);
  process.argv = [process.execPath, path, ...args];
  const module = await load(path);
  await module.evaluate();
}
