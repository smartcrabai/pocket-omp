interface Violation {
  readonly file: string;
  readonly specifier: string;
  readonly rule: string;
}

const sourceRoots = ["packages", "apps", "services"] as const;
const transpiler = new Bun.Transpiler({ loader: "tsx" });
const coreRules: Readonly<Record<string, readonly string[]>> = {
  "control-core": [
    "@pocket-omp/control-adapters",
    "@pocket-omp/proto",
    "@connectrpc/",
    "jose",
    "postgres",
    "redis",
    "expo",
  ],
  "host-core": [
    "@pocket-omp/host-adapters",
    "@pocket-omp/omp-sdk-adapter",
    "@pocket-omp/proto",
    "@connectrpc/",
    "@oh-my-pi/",
  ],
  "agent-runtime-core": ["@pocket-omp/omp-sdk-adapter", "@oh-my-pi/"],
  "agent-domain": [
    "@pocket-omp/agent-runtime-protocol",
    "@pocket-omp/proto",
    "@connectrpc/",
    "@oh-my-pi/",
  ],
  "mobile-core": ["@pocket-omp/proto", "@connectrpc/", "expo", "react-native"],
};
const allowedProtoExports: Readonly<Record<string, true>> = {
  "@pocket-omp/proto/relay/v1": true,
  "@pocket-omp/proto/control/v1": true,
  "@pocket-omp/proto/session/v1": true,
  "@pocket-omp/proto/runtime/v1": true,
  "@pocket-omp/proto/hostlocal/v1": true,
  "@pocket-omp/proto/internal/v1": true,
};
const sourceFiles = (
  await Promise.all(
    sourceRoots.map(async (root) => {
      const glob = new Bun.Glob("**/*.{ts,tsx,js,jsx}");
      const relativePaths = [...glob.scanSync({ cwd: root, onlyFiles: true })].filter(
        (relativePath) =>
          !relativePath.includes("/node_modules/") &&
          !relativePath.includes("/dist/") &&
          !relativePath.includes("/build/") &&
          !relativePath.includes("/src/gen/"),
      );
      return Promise.all(
        relativePaths.map(async (relativePath) => {
          const file = `${root}/${relativePath}`;
          return { file, source: await Bun.file(file).text() };
        }),
      );
    }),
  )
).flat();
const violations: Violation[] = [];
for (const { file, source } of sourceFiles) {
  for (const imported of transpiler.scan(source).imports) {
    const specifier = imported.path;
    const rule = forbiddenRule(file, specifier);
    if (rule !== undefined) violations.push({ file, specifier, rule });
  }
}

if (violations.length > 0) {
  for (const violation of violations) {
    process.stderr.write(
      `${violation.file}: ${violation.rule}: import ${JSON.stringify(violation.specifier)}\n`,
    );
  }
  process.exitCode = 1;
} else {
  process.stdout.write("Architecture dependency rules passed\n");
}

function forbiddenRule(file: string, specifier: string): string | undefined {
  const packageName = file.match(/^packages\/([^/]+)\//)?.[1];
  if (
    specifier === "@oh-my-pi/pi-coding-agent" ||
    specifier.startsWith("@oh-my-pi/pi-coding-agent/")
  ) {
    if (packageName !== "omp-sdk-adapter" && !file.startsWith("services/agent-runtime/")) {
      return "OMP SDK imports are isolated to omp-sdk-adapter and agent-runtime";
    }
  }

  if (packageName !== undefined) {
    const forbidden = coreRules[packageName];
    if (forbidden?.some((prefix) => specifier === prefix || specifier.startsWith(prefix))) {
      return `${packageName} must remain framework and adapter independent`;
    }
  }

  const pocketImport = specifier.match(/^@pocket-omp\/([^/]+)(\/.+)$/);
  if (pocketImport !== null) {
    if (!allowedProtoExports[specifier]) {
      return "Workspace deep imports are forbidden; use the package exports";
    }
  }
  return undefined;
}
