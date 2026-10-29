import { create } from "@bufbuild/protobuf";
import { afterEach, describe, expect, test } from "bun:test";
import {
  HostLocalErrorSchema,
  HostLocalFrameSchema,
  TuiExitedRequestSchema,
} from "@pocket-omp/proto/hostlocal/v1";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  type LocalControlPaths,
  LocalControlServer,
  requestLocalControl,
} from "../src/local-control";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe("Host local control error paths", () => {
  test("rejects a missing request body", async () => {
    const missingBody = create(HostLocalFrameSchema, {}).body;
    await expect(requestLocalControl(missingBody)).rejects.toThrow("Request body is missing");
  });

  test("rejects when the server endpoint is not listening", async () => {
    const paths = await temporaryPaths();
    await writeFile(paths.secretPath, new Uint8Array(32).fill(0x31));

    await expect(
      requestLocalControl(
        { case: "tuiExited", value: create(TuiExitedRequestSchema, { handoffTicket: "ticket" }) },
        paths,
      ),
    ).rejects.toThrow("Unable to connect");
  });

  test("converts handler exceptions to authenticated error responses", async () => {
    const paths = await temporaryPaths();
    const server = await LocalControlServer.start({
      paths,
      secret: new Uint8Array(32).fill(0x42),
      handler: async () => {
        throw new Error("handler failed");
      },
    });

    try {
      const response = await requestLocalControl(
        {
          case: "tuiExited",
          value: create(TuiExitedRequestSchema, { handoffTicket: "ticket" }),
        },
        paths,
      );
      expect(response.body).toEqual({
        case: "error",
        value: create(HostLocalErrorSchema, { code: "INTERNAL", message: "handler failed" }),
      });
    } finally {
      await server.close();
    }
  });

  test("rejects a response after the secret file changes", async () => {
    const paths = await temporaryPaths();
    const server = await LocalControlServer.start({
      paths,
      secret: new Uint8Array(32).fill(0x53),
      handler: async () => ({ case: undefined }),
    });

    try {
      await writeFile(paths.secretPath, new Uint8Array(32).fill(0x54));
      await expect(
        requestLocalControl(
          {
            case: "tuiExited",
            value: create(TuiExitedRequestSchema, { handoffTicket: "ticket" }),
          },
          paths,
        ),
      ).rejects.toThrow();
    } finally {
      await server.close();
    }
  });
});

async function temporaryPaths(): Promise<LocalControlPaths> {
  const directory = await mkdtemp(join(tmpdir(), "pocket-omp-local-control-errors-"));
  directories.push(directory);
  return {
    directory,
    endpoint:
      process.platform === "win32"
        ? `\\\\.\\pipe\\pocket-omp-test-${crypto.randomUUID()}`
        : join(directory, "control.sock"),
    secretPath: join(directory, "control.secret"),
  };
}
