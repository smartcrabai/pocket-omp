import { createRequire } from "node:module";
import { chmod, mkdir, realpath, rm } from "node:fs/promises";
import { join, resolve } from "node:path";

import hostManifest from "../apps/host/package.json" with { type: "json" };
import { createOmpLegacyPlugin } from "./omp-legacy-plugin";

const targetByPlatform: Readonly<Record<string, Bun.Build.CompileTarget>> = {
  "darwin-arm64": "bun-darwin-arm64",
  "darwin-x64": "bun-darwin-x64",
  "linux-arm64": "bun-linux-arm64",
  "linux-x64": "bun-linux-x64-baseline",
  "windows-x64": "bun-windows-x64-baseline",
};
const unitEntrypoint: Readonly<Record<string, string>> = {
  "pocket-omp-host": "apps/host/src/host.ts",
  "pocket-omp-agent-runtime": "apps/host/src/agent-runtime.ts",
  "pocket-omp": "apps/host/src/cli.ts",
};

const options = parseOptions(process.argv.slice(2));
const target = targetByPlatform[options.platform];
if (target === undefined) throw new Error(`Unsupported release platform: ${options.platform}`);
if (!/^\d+\.\d+\.\d+$/.test(options.version)) throw new Error("Release version must be semver");
if (options.version !== hostManifest.version) {
  throw new Error(
    `Release version ${options.version} does not match apps/host/package.json ${hostManifest.version}`,
  );
}

const ompPackageDir = await realpath(
  "packages/omp-sdk-adapter/node_modules/@oh-my-pi/pi-coding-agent",
);
const ompRequire = createRequire(join(ompPackageDir, "package.json"));
const ompManifest: unknown = ompRequire("./package.json");
const ompVersion = readManifestVersion(ompManifest);
const outputDir = resolve(options.output, options.platform);
await rm(outputDir, { recursive: true, force: true });
await mkdir(outputDir, { recursive: true });
const ompLegacyPlugin = await createOmpLegacyPlugin(resolve("packages/omp-sdk-adapter"));

await Promise.all(
  Object.entries(unitEntrypoint).map(async ([unit, entrypoint]) => {
    const outputName = releaseFileName(unit, options.platform);
    const result = await Bun.build({
      entrypoints: [resolve(entrypoint)],
      define: {
        POCKET_OMP_BUILD_VERSION: JSON.stringify(options.version),
        POCKET_OMP_OMP_VERSION: JSON.stringify(ompVersion),
      },
      ...(unit === "pocket-omp-agent-runtime" ? { plugins: [ompLegacyPlugin] } : {}),
      minify: true,
      compile: {
        target,
        outfile: join(outputDir, outputName),
        autoloadBunfig: false,
        autoloadDotenv: false,
        autoloadTsconfig: false,
        autoloadPackageJson: false,
      },
      throw: false,
    });
    if (!result.success) {
      throw new Error(`${unit} build failed:\n${result.logs.map((log) => log.message).join("\n")}`);
    }
    if (process.platform !== "win32") await chmod(join(outputDir, outputName), 0o755);
  }),
);

const ompSha256ByPlatform: Readonly<Record<string, string>> = {
  "darwin-arm64": "8c548c94d1f44ec30a74c9ea7d604b945b1c5419ee3574db45188ec66d31d749",
  "darwin-x64": "b85da81c4f0e978cfd0a3c78d289628ae5a4acd05408bf9932fd769f07e84140",
  "linux-arm64": "0386b28b0f1b9213985fa9f690972ed85c563f4b28187fb2fdb42fcc70d70d9e",
  "linux-x64": "35019bfa4d1acae0040ef1f3d91c29c6e7401acfcdbcfeba6ff506a6b103c987",
  "windows-x64": "341c969e31eebca0f2a5da930b4688d6ae234441901b5eded79bbf2314306410",
};
const ompOutputName = releaseFileName("omp", options.platform);
const ompOutputPath = join(outputDir, ompOutputName);
const ompUrl = `https://github.com/can1357/oh-my-pi/releases/download/v${ompVersion}/${ompOutputName}`;
const ompResponse = await fetch(ompUrl);
if (!ompResponse.ok || ompResponse.body === null) {
  throw new Error(`Unable to download pinned OMP binary: ${ompResponse.status} ${ompUrl}`);
}
const ompWriter = Bun.file(ompOutputPath).writer();
try {
  for await (const chunk of ompResponse.body) {
    // oxlint-disable-next-line no-await-in-loop -- each chunk must reach the sink in wire order.
    await ompWriter.write(chunk);
  }
} finally {
  await ompWriter.end();
}
const ompDigest = await sha256File(ompOutputPath);
if (ompDigest !== ompSha256ByPlatform[options.platform]) {
  await rm(ompOutputPath, { force: true });
  throw new Error(`Pinned OMP checksum mismatch for ${options.platform}: ${ompDigest}`);
}
if (process.platform !== "win32") await chmod(ompOutputPath, 0o755);

const metadata = {
  artifactKind: "atomic-host-release",
  publishable: true,
  platform: options.platform,
  releaseVersion: options.version,
  ompSdkVersion: ompVersion,
  tuiVersion: ompVersion,
  runtimeIpcMinimum: 1,
  runtimeIpcMaximum: 1,
  units: ["pocket-omp-host", "pocket-omp-agent-runtime", "pocket-omp", "omp"],
};
await Bun.write(join(outputDir, "release-metadata.json"), `${JSON.stringify(metadata, null, 2)}\n`);
process.stdout.write(`${outputDir}\n`);

function releaseFileName(unit: string, platform: string): string {
  return platform.startsWith("windows-") ? `${unit}-${platform}.exe` : `${unit}-${platform}`;
}

async function sha256File(path: string): Promise<string> {
  const hasher = new Bun.CryptoHasher("sha256");
  for await (const chunk of Bun.file(path).stream()) hasher.update(chunk);
  return hasher.digest("hex");
}

function parseOptions(args: readonly string[]): {
  version: string;
  platform: string;
  output: string;
} {
  let version = hostManifest.version;
  let platform = `${process.platform === "win32" ? "windows" : process.platform}-${process.arch}`;
  let output = "dist/host-release";
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index + 1];
    if (args[index] === "--version" && value !== undefined) version = value.replace(/^v/, "");
    if (args[index] === "--platform" && value !== undefined) platform = value;
    if (args[index] === "--output" && value !== undefined) output = value;
  }
  return { version, platform, output };
}

function readManifestVersion(value: unknown): string {
  if (typeof value !== "object" || value === null) throw new Error("Package manifest is invalid");
  const version = Reflect.get(value, "version");
  if (typeof version !== "string") throw new Error("Package manifest version is invalid");
  return version;
}
