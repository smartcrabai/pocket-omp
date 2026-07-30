import { randomUUID } from "node:crypto";
import { create } from "@bufbuild/protobuf";
import { afterEach, describe, expect, test } from "bun:test";
import {
  PrepareTuiHandoffRequestSchema,
  PrepareTuiHandoffResponseSchema,
} from "@pocket-omp/proto/hostlocal/v1";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  type LocalControlPaths,
  LocalControlServer,
  localControlPaths,
  requestLocalControl,
} from "../src/local-control";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe("Host local control", () => {
  test("authenticates both peers over the current-user local transport", async () => {
    const paths = await temporaryPaths();
    const server = await LocalControlServer.start({
      paths,
      secret: new Uint8Array(32).fill(0x42),
      handler: async (request) => {
        expect(request.body.case).toBe("prepareTuiHandoff");
        return {
          case: "handoffReady",
          value: create(PrepareTuiHandoffResponseSchema, {
            handoffTicket: "ticket-1",
            sessionPath: "/session.jsonl",
            cwd: "/workspace",
            tuiVersion: "17.1.5",
            fileFingerprint: new Uint8Array(32),
            expiresAtMs: BigInt(Date.now() + 10_000),
          }),
        };
      },
    });
    try {
      const response = await requestLocalControl(
        {
          case: "prepareTuiHandoff",
          value: create(PrepareTuiHandoffRequestSchema, {
            sessionId: "session-1",
            abortActiveRun: false,
          }),
        },
        paths,
      );
      expect(response.body.case).toBe("handoffReady");
      if (response.body.case === "handoffReady") {
        expect(response.body.value.handoffTicket).toBe("ticket-1");
      }
      if (process.platform !== "win32") {
        expect((await stat(paths.directory)).mode & 0o777).toBe(0o700);
        expect((await stat(paths.endpoint)).mode & 0o777).toBe(0o600);
        expect((await stat(paths.secretPath)).mode & 0o777).toBe(0o600);
      }
    } finally {
      await server[Symbol.asyncDispose]();
    }
  });
  test("derives the current-user control endpoint from the runtime directory", () => {
    const paths = localControlPaths({
      POCKET_OMP_RUNTIME_DIR: "/runtime",
      USERNAME: "user",
    });
    expect(paths.directory).toContain("runtime");
    expect(paths.endpoint).toBe(
      process.platform === "win32"
        ? "\\\\.\\pipe\\pocket-omp-user"
        : join("/runtime", "control.sock"),
    );
    expect(paths.secretPath).toEndWith("control.secret");
  });
});

async function temporaryPaths(): Promise<LocalControlPaths> {
  const directory = await mkdtemp(join(tmpdir(), "pocket-omp-local-control-"));
  directories.push(directory);
  return {
    directory,
    endpoint:
      process.platform === "win32"
        ? `\\\\.\\pipe\\pocket-omp-test-${randomUUID()}`
        : join(directory, "control.sock"),
    secretPath: join(directory, "control.secret"),
  };
}
