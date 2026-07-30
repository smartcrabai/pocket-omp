import { basename, dirname, join } from "node:path";

interface PackageDefinition {
  readonly name: string;
  readonly rootShim?: string;
}

const packages: readonly PackageDefinition[] = [
  { name: "@oh-my-pi/pi-agent-core" },
  { name: "@oh-my-pi/pi-ai", rootShim: "legacy-pi-ai-shim.ts" },
  { name: "@oh-my-pi/pi-coding-agent", rootShim: "legacy-pi-coding-agent-shim.ts" },
  { name: "@oh-my-pi/pi-natives" },
  { name: "@oh-my-pi/pi-tui", rootShim: "legacy-pi-tui-shim.ts" },
  { name: "@oh-my-pi/pi-utils" },
];

interface LegacyModuleEntry {
  readonly key: string;
  readonly specifier: string;
}

export async function createOmpLegacyPlugin(resolveFrom: string): Promise<Bun.BunPlugin> {
  const entries: LegacyModuleEntry[] = [];
  const codingAgentRoot = await packageRoot("@oh-my-pi/pi-coding-agent", resolveFrom);
  const extensionRoot = join(codingAgentRoot, "src", "extensibility");
  for (const definition of packages) {
    // oxlint-disable-next-line no-await-in-loop -- Registry order must remain reproducible.
    const root = await packageRoot(definition.name, codingAgentRoot);
    // oxlint-disable-next-line no-await-in-loop -- Manifest follows its resolved package root.
    const manifest = await readObject(Bun.file(join(root, "package.json")).json());
    const exports = Reflect.get(manifest, "exports");
    if (typeof exports !== "object" || exports === null || Array.isArray(exports)) {
      throw new Error(`${definition.name} has no package exports`);
    }
    const rootTarget = exportImportTarget(Reflect.get(exports, "."));
    if (rootTarget === undefined) throw new Error(`${definition.name} has no root import`);
    add(
      definition.name,
      definition.rootShim === undefined
        ? join(root, rootTarget.slice(2))
        : join(extensionRoot, definition.rootShim),
    );
    for (const [exportKey, target] of Object.entries(exports)) {
      if (!exportKey.startsWith("./") || exportKey === ".") continue;
      const importTarget = exportImportTarget(target);
      if (importTarget === undefined) continue;
      const exportStar = exportKey.indexOf("*");
      const sourceStar = importTarget.indexOf("*");
      if (exportStar === -1 || sourceStar === -1) {
        add(`${definition.name}/${exportKey.slice(2)}`, join(root, importTarget.slice(2)));
        continue;
      }
      const sourceBeforeStar = importTarget.slice(2, sourceStar);
      const sourceDirectory = join(root, dirname(sourceBeforeStar));
      const sourcePrefix = basename(sourceBeforeStar);
      const sourceSuffix = importTarget.slice(sourceStar + 1);
      // oxlint-disable-next-line no-await-in-loop -- Glob iteration preserves export order.
      for await (const match of new Bun.Glob(`${sourcePrefix}*${sourceSuffix}`).scan({
        cwd: sourceDirectory,
        onlyFiles: true,
      })) {
        const wildcard = match.slice(sourcePrefix.length, match.length - sourceSuffix.length);
        if (wildcard.length === 0 || wildcard === "index" || wildcard.includes("/")) continue;
        const subpath = `${exportKey.slice(2, exportStar)}${wildcard}${exportKey.slice(exportStar + 1)}`;
        add(`${definition.name}/${subpath}`, join(sourceDirectory, match));
      }
    }
  }
  add("typebox", join(extensionRoot, "typebox.ts"));
  const loaders = entries.map(
    (entry, index) => `const module${index} = () => import(${JSON.stringify(entry.specifier)});`,
  );
  const registry = entries.map((entry, index) => `  ${JSON.stringify(entry.key)}: module${index},`);
  const source = `${loaders.join("\n")}\nexport const BUNDLED_PI_MODULE_LOADERS = {\n${registry.join("\n")}\n};\n`;
  return {
    name: "pocket-omp:legacy-pi-modules",
    setup(build) {
      build.onResolve({ filter: /^omp-legacy-pi-modules$/ }, () => ({
        path: "omp-legacy-pi-modules",
        namespace: "pocket-omp-legacy",
      }));
      build.onLoad({ filter: /.*/, namespace: "pocket-omp-legacy" }, () => ({
        contents: source,
        loader: "ts",
      }));
    },
  };

  function add(key: string, specifier: string): void {
    if (!entries.some((entry) => entry.key === key)) entries.push({ key, specifier });
  }
}

async function packageRoot(name: string, resolveFrom: string): Promise<string> {
  let candidate = dirname(Bun.resolveSync(name, resolveFrom));
  for (;;) {
    const manifest = Bun.file(join(candidate, "package.json"));
    // oxlint-disable-next-line no-await-in-loop -- Package roots require ordered parent traversal.
    if (await manifest.exists()) {
      // oxlint-disable-next-line no-await-in-loop -- Read only after confirming this parent exists.
      const value = await readObject(manifest.json());
      if (Reflect.get(value, "name") === name) return candidate;
    }
    const parent = dirname(candidate);
    if (parent === candidate) throw new Error(`Unable to locate package root for ${name}`);
    candidate = parent;
  }
}

async function readObject(value: unknown): Promise<object> {
  const resolved = await value;
  if (typeof resolved !== "object" || resolved === null || Array.isArray(resolved)) {
    throw new Error("Package manifest is invalid");
  }
  return resolved;
}

function exportImportTarget(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value !== "object" || value === null) return undefined;
  const imported = Reflect.get(value, "import");
  return typeof imported === "string" ? imported : undefined;
}
