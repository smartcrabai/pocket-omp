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

test("requires HTTPS manifest URLs from both updater entry points", async () => {
  const fixture = await updateFixture();
  const manifestUrl = "http://updates.example.test/manifest.json";

  await expect(
    prepareHostUpdate({ ...fixture.options, manifestUrl, fetcher: serve(fixture.payload) }),
  ).rejects.toThrow("Manifest URL must use HTTPS");
  await expect(runHostUpdate(["--manifest-url", manifestUrl])).rejects.toThrow(
    "Manifest URL must use HTTPS",
  );
});

test("rejects an unavailable manifest", async () => {
  const fixture = await updateFixture();
  await expect(
    prepareHostUpdate({
      ...fixture.options,
      fetcher: serve(new Response(null, { status: 503 })),
    }),
  ).rejects.toThrow("Unable to fetch Host update manifest: 503");
});

test("rejects a signed manifest for a different platform", async () => {
  const fixture = await updateFixture();
  const manifest = {
    ...fixture.manifest,
    artifacts: fixture.manifest.artifacts.map((artifact) => ({
      ...artifact,
      platform: "linux-x64",
    })),
  };
  const payload = serializeManifest(manifest, signHostUpdateManifest(signing.secretKey, manifest));

  await expect(prepareHostUpdate({ ...fixture.options, fetcher: serve(payload) })).rejects.toThrow(
    "Host update manifest platform does not match this Host",
  );
});

test("rejects missing artifacts and removes the staging set", async () => {
  const fixture = await updateFixture();
  const fetcher: typeof fetch = async (input) =>
    requestUrl(input) === fixture.manifestUrl
      ? Response.json(fixture.payload)
      : new Response(null, { status: 404 });

  await expect(prepareHostUpdate({ ...fixture.options, fetcher })).rejects.toThrow(
    /Unable to fetch .*: 404/,
  );
  expect(
    (await readdir(fixture.root)).filter((name) => name.startsWith(".pocket-omp-update-")),
  ).toEqual([]);
});

test("rejects artifact bytes that exceed their signed size", async () => {
  const fixture = await updateFixture();
  const fetcher: typeof fetch = async (input) => {
    const url = requestUrl(input);
    if (url === fixture.manifestUrl) return Response.json(fixture.payload);
    const content = fixture.contentByUrl.get(url);
    return new Response(content === undefined ? null : `${content}x`);
  };

  await expect(prepareHostUpdate({ ...fixture.options, fetcher })).rejects.toThrow(
    "exceeds signed size",
  );
  expect(
    (await readdir(fixture.root)).filter((name) => name.startsWith(".pocket-omp-update-")),
  ).toEqual([]);
});

test("rejects changed prepared manifest metadata", async () => {
  const fixture = await updateFixture();
  const prepared = await prepareHostUpdate(fixture.options);
  (prepared.manifest as { releaseVersion: string }).releaseVersion = "3.0.0";

  await expect(
    applyPreparedHostUpdate(prepared, {
      currentVersion: "1.0.0",
      nowMs: 1_500n,
      publicKey: signing.publicKey,
    }),
  ).rejects.toThrow("Prepared Host update metadata changed");
});

test("rejects malformed manifest arrays and objects", async () => {
  const fixture = await updateFixture();

  await expect(prepareHostUpdate({ ...fixture.options, fetcher: serve([]) })).rejects.toThrow(
    "Host update manifest is invalid",
  );
  await expect(prepareHostUpdate({ ...fixture.options, fetcher: serve({}) })).rejects.toThrow(
    "Manifest artifacts are invalid",
  );
});

test("rejects an unknown artifact unit", async () => {
  const fixture = await updateFixture();
  const payload = {
    ...fixture.payload,
    artifacts: fixture.payload.artifacts.map((artifact, index) =>
      index === 0 ? { ...artifact, unit: "unknown-unit" } : artifact,
    ),
  };

  await expect(prepareHostUpdate({ ...fixture.options, fetcher: serve(payload) })).rejects.toThrow(
    "Unknown Host artifact unit unknown-unit",
  );
});

test("handles ended updater PIDs", async () => {
  const fixture = await updateFixture();
  const child = Bun.spawn([process.execPath, "-e", "process.exit(0)"], {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });
  await child.exited;

  await expect(
    runPreparedUpdateHelper([
      join(fixture.root, "missing-staging"),
      fixture.installDirectory,
      String(child.pid),
      "1.0.0",
      join(fixture.root, "missing-helper"),
    ]),
  ).rejects.toThrow();

  const helperDirectory = join(fixture.root, "helper");
  await mkdir(helperDirectory);
  expect(await runUpdateHelperCleanup([helperDirectory, String(child.pid)])).toBe(0);
  expect((await readdir(fixture.root)).includes("helper")).toBe(false);
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

function serve(body: unknown): typeof fetch {
  return async () => (body instanceof Response ? body : Response.json(body));
}
