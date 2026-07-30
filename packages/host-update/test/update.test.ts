import { expect, test } from "bun:test";
import { generateEd25519KeyPair } from "@pocket-omp/crypto";
import {
  HOST_RELEASE_UNITS,
  signHostUpdateManifest,
  verifyHostArtifact,
  verifyHostUpdateManifest,
  type HostUpdateManifest,
} from "../src/index";

const bytes = new TextEncoder().encode("signed artifact");
const sha256 = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
const manifest: HostUpdateManifest = {
  manifestVersion: 1,
  releaseVersion: "2.0.0",
  ompSdkVersion: "17.1.4",
  tuiVersion: "17.1.4",
  runtimeIpcMinimum: 1,
  runtimeIpcMaximum: 1,
  generatedAtMs: 1_000n,
  expiresAtMs: 2_000n,
  artifacts: HOST_RELEASE_UNITS.map((unit) => ({
    unit,
    platform: "darwin-arm64",
    url: `https://updates.example.test/2.0.0/${unit}`,
    sha256,
    size: BigInt(bytes.byteLength),
  })),
};
const firstArtifact = manifest.artifacts[0];
if (firstArtifact === undefined) throw new Error("test manifest requires an artifact");

const signing = generateEd25519KeyPair({ bytes: (length) => new Uint8Array(length).fill(4) });

test("signed Host update verifies one complete atomic release set", () => {
  const signature = signHostUpdateManifest(signing.secretKey, manifest);
  expect(() =>
    verifyHostUpdateManifest({
      publicKey: signing.publicKey,
      manifest,
      signature,
      nowMs: 1_500n,
      currentVersion: "1.9.0",
      runtimeIpcVersion: 1,
    }),
  ).not.toThrow();
  for (const artifact of manifest.artifacts)
    expect(() => verifyHostArtifact(artifact, bytes)).not.toThrow();
});

test("Host update rejects tampering, partial releases, downgrade, and incompatible IPC", () => {
  const signature = signHostUpdateManifest(signing.secretKey, manifest);
  expect(() =>
    verifyHostUpdateManifest({
      publicKey: signing.publicKey,
      manifest: { ...manifest, tuiVersion: "17.1.5" },
      signature,
      nowMs: 1_500n,
      currentVersion: "1.9.0",
      runtimeIpcVersion: 1,
    }),
  ).toThrow("signature is invalid");
  expect(() =>
    signHostUpdateManifest(signing.secretKey, {
      ...manifest,
      artifacts: manifest.artifacts.slice(1),
    }),
  ).toThrow("complete atomic release set");
  expect(() =>
    verifyHostUpdateManifest({
      publicKey: signing.publicKey,
      manifest,
      signature,
      nowMs: 1_500n,
      currentVersion: "2.0.0",
      runtimeIpcVersion: 1,
    }),
  ).toThrow("does not advance");
  expect(() =>
    verifyHostUpdateManifest({
      publicKey: signing.publicKey,
      manifest,
      signature,
      nowMs: 1_500n,
      currentVersion: "1.9.0",
      runtimeIpcVersion: 2,
    }),
  ).toThrow("IPC range is incompatible");
  expect(() =>
    verifyHostUpdateManifest({
      publicKey: signing.publicKey,
      manifest,
      signature,
      nowMs: 2_001n,
      currentVersion: "1.9.0",
      runtimeIpcVersion: 1,
    }),
  ).toThrow("validity window");
  expect(() => verifyHostArtifact(firstArtifact, bytes.slice(1))).toThrow("size mismatch");
  expect(() => verifyHostArtifact(firstArtifact, new Uint8Array(bytes.byteLength))).toThrow(
    "checksum mismatch",
  );
});
