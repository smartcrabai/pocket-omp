import { mkdir, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { generateEd25519KeyPair } from "../packages/crypto/src/index";
import {
  HOST_RELEASE_UNITS,
  HOST_UPDATE_MANIFEST_VERSION,
  signHostUpdateManifest,
  type HostArtifact,
  type HostUpdateManifest,
  verifyHostUpdateManifest,
} from "../packages/host-update/src/index";
import { HOST_UPDATE_SIGNING_PUBLIC_KEY_BASE64 } from "../apps/host/src/update-trust";

const options = parseOptions(process.argv.slice(2));
const encodedSecret = process.env.HOST_UPDATE_SIGNING_KEY;
if (encodedSecret === undefined) throw new Error("HOST_UPDATE_SIGNING_KEY is required");
const secretKey = Uint8Array.from(Buffer.from(encodedSecret, "base64"));
if (secretKey.byteLength !== 32) throw new Error("HOST_UPDATE_SIGNING_KEY must encode 32 bytes");
const { publicKey } = generateEd25519KeyPair({ bytes: () => secretKey });
if (Buffer.from(publicKey).toString("base64") !== HOST_UPDATE_SIGNING_PUBLIC_KEY_BASE64) {
  throw new Error("HOST_UPDATE_SIGNING_KEY does not match the pinned Host update public key");
}
const generatedAtMs = BigInt(Date.now());
const expiresAtMs = generatedAtMs + 90n * 24n * 60n * 60n * 1_000n;

const metadataPaths: string[] = [];
const metadataGlob = new Bun.Glob("**/release-metadata.json");
for await (const relativePath of metadataGlob.scan({ cwd: options.input, onlyFiles: true })) {
  metadataPaths.push(join(options.input, relativePath));
}
const manifests = await Promise.all(
  metadataPaths.toSorted().map(async (metadataPath) => {
    const metadata = readMetadata(await Bun.file(metadataPath).json());
    const directory = dirname(metadataPath);
    const artifacts = await Promise.all(
      HOST_RELEASE_UNITS.map(async (unit): Promise<HostArtifact> => {
        const fileName = releaseFileName(unit, metadata.platform);
        const path = join(directory, fileName);
        const fileStat = await stat(path);
        return {
          unit,
          platform: metadata.platform,
          url: `${options.baseUrl}/${fileName}`,
          sha256: await sha256File(path),
          size: BigInt(fileStat.size),
        };
      }),
    );
    const manifest: HostUpdateManifest = {
      manifestVersion: HOST_UPDATE_MANIFEST_VERSION,
      releaseVersion: metadata.releaseVersion,
      ompSdkVersion: metadata.ompSdkVersion,
      tuiVersion: metadata.tuiVersion,
      runtimeIpcMinimum: metadata.runtimeIpcMinimum,
      runtimeIpcMaximum: metadata.runtimeIpcMaximum,
      generatedAtMs,
      expiresAtMs,
      artifacts,
    };
    const signature = signHostUpdateManifest(secretKey, manifest);
    verifyHostUpdateManifest({
      manifest,
      signature,
      nowMs: generatedAtMs,
      publicKey,
      currentVersion: "0.0.0",
      runtimeIpcVersion: 1,
    });
    return { metadata, manifest, signature };
  }),
);
if (manifests.length === 0) throw new Error("No release metadata found");
await mkdir(options.output, { recursive: true });
await Promise.all(
  manifests.map(async ({ metadata, manifest, signature }) => {
    const payload = {
      ...manifest,
      generatedAtMs: manifest.generatedAtMs.toString(),
      expiresAtMs: manifest.expiresAtMs.toString(),
      artifacts: manifest.artifacts.map((artifact) => ({
        ...artifact,
        size: artifact.size.toString(),
      })),
      signature: Buffer.from(signature).toString("base64"),
    };
    await Bun.write(
      join(options.output, `host-update-${metadata.platform}.json`),
      `${JSON.stringify(payload, null, 2)}\n`,
    );
  }),
);
process.stdout.write(
  `${manifests.length} signed manifests written to ${resolve(options.output)}\n`,
);

interface ReleaseMetadata {
  readonly artifactKind: "atomic-host-release";
  readonly publishable: true;
  readonly platform: string;
  readonly releaseVersion: string;
  readonly ompSdkVersion: string;
  readonly tuiVersion: string;
  readonly runtimeIpcMinimum: number;
  readonly runtimeIpcMaximum: number;
}

function readMetadata(value: unknown): ReleaseMetadata {
  if (typeof value !== "object" || value === null) throw new Error("Release metadata is invalid");
  const artifactKind = Reflect.get(value, "artifactKind");
  const publishable = Reflect.get(value, "publishable");
  const platform = Reflect.get(value, "platform");
  const releaseVersion = Reflect.get(value, "releaseVersion");
  const ompSdkVersion = Reflect.get(value, "ompSdkVersion");
  const tuiVersion = Reflect.get(value, "tuiVersion");
  const runtimeIpcMinimum = Reflect.get(value, "runtimeIpcMinimum");
  const runtimeIpcMaximum = Reflect.get(value, "runtimeIpcMaximum");
  if (
    artifactKind !== "atomic-host-release" ||
    publishable !== true ||
    typeof platform !== "string" ||
    typeof releaseVersion !== "string" ||
    typeof ompSdkVersion !== "string" ||
    typeof tuiVersion !== "string" ||
    typeof runtimeIpcMinimum !== "number" ||
    typeof runtimeIpcMaximum !== "number"
  ) {
    throw new Error(`Release metadata is malformed: ${JSON.stringify(value)}`);
  }
  return {
    artifactKind,
    publishable,
    platform,
    releaseVersion,
    ompSdkVersion,
    tuiVersion,
    runtimeIpcMinimum,
    runtimeIpcMaximum,
  };
}

function releaseFileName(unit: string, platform: string): string {
  return platform.startsWith("windows-") ? `${unit}-${platform}.exe` : `${unit}-${platform}`;
}

async function sha256File(path: string): Promise<string> {
  const hasher = new Bun.CryptoHasher("sha256");
  for await (const chunk of Bun.file(path).stream()) hasher.update(chunk);
  return hasher.digest("hex");
}

function parseOptions(args: readonly string[]): {
  readonly input: string;
  readonly output: string;
  readonly baseUrl: string;
} {
  let input = "dist/host-release";
  let output = "dist/host-manifests";
  let baseUrl: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index + 1];
    if (args[index] === "--input" && value !== undefined) input = value;
    if (args[index] === "--output" && value !== undefined) output = value;
    if (args[index] === "--base-url" && value !== undefined) baseUrl = value.replace(/\/$/, "");
  }
  if (baseUrl === undefined || !baseUrl.startsWith("https://")) {
    throw new Error("--base-url must be an HTTPS URL");
  }
  return { input, output, baseUrl };
}
