import { generateEd25519KeyPair } from "@pocket-omp/crypto";
import {
  HOST_RELEASE_UNITS,
  signHostUpdateManifest,
  type HostUpdateManifest,
} from "@pocket-omp/host-update";
import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  applyPreparedHostUpdate,
  currentHostPlatform,
  prepareHostUpdate,
  runHostUpdate,
  runPreparedUpdateHelper,
  runUpdateHelperCleanup,
} from "../src/updater";

const platform = "darwin-arm64";
const signing = generateEd25519KeyPair({ bytes: (length) => new Uint8Array(length).fill(7) });
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

test("downloads, verifies, and applies one complete Host release transaction", async () => {
  const fixture = await updateFixture();
  const prepared = await prepareHostUpdate(fixture.options);

  await applyPreparedHostUpdate(prepared, {
    currentVersion: "1.0.0",
    nowMs: 1_500n,
    publicKey: signing.publicKey,
  });

  await Promise.all(
    HOST_RELEASE_UNITS.map(async (unit) => {
      expect(await Bun.file(join(fixture.installDirectory, releaseFileName(unit))).text()).toBe(
        fixture.contents.get(unit),
      );
    }),
  );
  expect(await Bun.file(prepared.stagingDirectory).exists()).toBe(false);
  expect(
    (await readdir(fixture.root)).some((name) => name.includes("backup") || name.endsWith(".lock")),
  ).toBe(false);
});

test("rejects an invalid manifest signature before downloading artifacts", async () => {
  const fixture = await updateFixture();
  const payload = { ...fixture.payload, signature: Buffer.alloc(64).toString("base64") };
  let artifactRequests = 0;
  const fetcher: typeof fetch = async (input) => {
    const url = requestUrl(input);
    if (url === fixture.manifestUrl) return Response.json(payload);
    artifactRequests += 1;
    return new Response(fixture.contentByUrl.get(url));
  };

  await expect(prepareHostUpdate({ ...fixture.options, fetcher })).rejects.toThrow(
    "signature is invalid",
  );
  expect(artifactRequests).toBe(0);
});

test("rejects corrupted artifact bytes and removes the staging set", async () => {
  const fixture = await updateFixture();
  const corruptedUrl = fixture.manifest.artifacts[0]?.url;
  if (corruptedUrl === undefined) throw new Error("fixture requires an artifact");
  const fetcher: typeof fetch = async (input) => {
    const url = requestUrl(input);
    if (url === fixture.manifestUrl) return Response.json(fixture.payload);
    return new Response(url === corruptedUrl ? "corrupt" : fixture.contentByUrl.get(url));
  };

  await expect(prepareHostUpdate({ ...fixture.options, fetcher })).rejects.toThrow(
    /signed size|size mismatch|checksum mismatch/,
  );
  expect(
    (await readdir(fixture.root)).filter((name) => name.startsWith(".pocket-omp-update-")),
  ).toEqual([]);
});

test("does not touch the installed release when prepared bytes change", async () => {
  const fixture = await updateFixture();
  const prepared = await prepareHostUpdate(fixture.options);
  const firstUnit = HOST_RELEASE_UNITS[0];
  await Bun.write(join(prepared.stagingDirectory, releaseFileName(firstUnit)), "tampered");

  await expect(
    applyPreparedHostUpdate(prepared, {
      currentVersion: "1.0.0",
      nowMs: 1_500n,
      publicKey: signing.publicKey,
    }),
  ).rejects.toThrow(/size mismatch|checksum mismatch/);
  await Promise.all(
    HOST_RELEASE_UNITS.map(async (unit) => {
      expect(await Bun.file(join(fixture.installDirectory, releaseFileName(unit))).text()).toBe(
        `old:${unit}`,
      );
    }),
  );
});

test("rejects malformed update commands and helper invocations", async () => {
  expect(currentHostPlatform()).toMatch(/^(darwin|linux|windows)-/);
  await expect(runHostUpdate(["--manifest-url"])).rejects.toThrow("requires a value");
  await expect(runPreparedUpdateHelper([])).rejects.toThrow("arguments are incomplete");
  expect(await runUpdateHelperCleanup([])).toBe(2);
  await expect(runUpdateHelperCleanup(["unused", "0"])).rejects.toThrow(
    "Invalid update helper PID",
  );
});

test("rejects malformed base64 signatures", async () => {
  const fixture = await updateFixture();
  const payload = { ...fixture.payload, signature: "not-base64" };
  const fetcher: typeof fetch = async (input) =>
    requestUrl(input) === fixture.manifestUrl
      ? Response.json(payload)
      : new Response(fixture.contentByUrl.get(requestUrl(input)));

  await expect(prepareHostUpdate({ ...fixture.options, fetcher })).rejects.toThrow(
    "Invalid manifest signature",
  );
});

test("refuses a second updater while the install lock is held", async () => {
  const fixture = await updateFixture();
  const prepared = await prepareHostUpdate(fixture.options);
  await Bun.write(join(fixture.root, ".pocket-omp-update.lock"), "held");

  await expect(
    applyPreparedHostUpdate(prepared, {
      currentVersion: "1.0.0",
      nowMs: 1_500n,
      publicKey: signing.publicKey,
    }),
  ).rejects.toThrow("Another Host update is in progress");
  await Promise.all(
    HOST_RELEASE_UNITS.map(async (unit) => {
      expect(await Bun.file(join(fixture.installDirectory, releaseFileName(unit))).text()).toBe(
        `old:${unit}`,
      );
    }),
  );
});

async function updateFixture() {
  const root = await mkdtemp(join(tmpdir(), "pocket-omp-updater-test-"));
  directories.push(root);
  const installDirectory = join(root, "bin");
  await mkdir(installDirectory);
  const contents = new Map<string, string>();
  const contentByUrl = new Map<string, string>();
  await Promise.all(
    HOST_RELEASE_UNITS.map(async (unit) => {
      await Bun.write(join(installDirectory, releaseFileName(unit)), `old:${unit}`);
      const content = `new:${unit}`;
      const url = `https://updates.example.test/${unit}`;
      contents.set(unit, content);
      contentByUrl.set(url, content);
    }),
  );
  const manifest: HostUpdateManifest = {
    manifestVersion: 1,
    releaseVersion: "2.0.0",
    ompSdkVersion: "17.1.5",
    tuiVersion: "17.1.5",
    runtimeIpcMinimum: 1,
    runtimeIpcMaximum: 1,
    generatedAtMs: 1_000n,
    expiresAtMs: 2_000n,
    artifacts: HOST_RELEASE_UNITS.map((unit) => {
      const content = contents.get(unit);
      if (content === undefined) throw new Error(`Missing fixture content for ${unit}`);
      const bytes = new TextEncoder().encode(content);
      return {
        unit,
        platform,
        url: `https://updates.example.test/${unit}`,
        sha256: new Bun.CryptoHasher("sha256").update(bytes).digest("hex"),
        size: BigInt(bytes.byteLength),
      };
    }),
  };
  const payload = serializeManifest(manifest, signHostUpdateManifest(signing.secretKey, manifest));
  const manifestUrl = "https://updates.example.test/manifest.json";
  const fetcher: typeof fetch = async (input) => {
    const url = requestUrl(input);
    if (url === manifestUrl) return Response.json(payload);
    const content = contentByUrl.get(url);
    return content === undefined ? new Response(null, { status: 404 }) : new Response(content);
  };
  return {
    root,
    installDirectory,
    contents,
    contentByUrl,
    manifest,
    manifestUrl,
    payload,
    options: {
      manifestUrl,
      installDirectory,
      platform,
      currentVersion: "1.0.0",
      nowMs: 1_500n,
      fetcher,
      publicKey: signing.publicKey,
    },
  };
}

function serializeManifest(manifest: HostUpdateManifest, signature: Uint8Array) {
  return {
    ...manifest,
    generatedAtMs: manifest.generatedAtMs.toString(),
    expiresAtMs: manifest.expiresAtMs.toString(),
    artifacts: manifest.artifacts.map((artifact) => ({
      ...artifact,
      size: artifact.size.toString(),
    })),
    signature: Buffer.from(signature).toString("base64"),
  };
}

function releaseFileName(unit: string): string {
  return `${unit}-${platform}`;
}

function requestUrl(input: string | URL | Request): string {
  if (typeof input === "string") return input;
  return input instanceof URL ? input.href : input.url;
}
