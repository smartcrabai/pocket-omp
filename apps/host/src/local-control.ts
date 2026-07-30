import { create } from "@bufbuild/protobuf";
import {
  authenticateHostLocalFrame,
  decodeHostLocalFrame,
  encodeHostLocalFrame,
  HOST_LOCAL_FRAME_MAX_BYTES,
  HOST_LOCAL_PROTOCOL_VERSION,
  verifyHostLocalFrameAuthentication,
} from "@pocket-omp/host-local-protocol";
import {
  HostLocalErrorSchema,
  type HostLocalFrame,
  HostLocalFrameSchema,
} from "@pocket-omp/proto/hostlocal/v1";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { verifyCurrentUserPeer } from "./peer-credentials";

export interface LocalControlPaths {
  readonly directory: string;
  readonly endpoint: string;
  readonly secretPath: string;
}

export type LocalControlHandler = (request: HostLocalFrame) => Promise<HostLocalFrame["body"]>;

interface ConnectionState {
  bytes: Uint8Array;
  handled: boolean;
  peerVerified: Promise<boolean>;
}

export class LocalControlServer implements AsyncDisposable {
  readonly #listener: Bun.UnixSocketListener<ConnectionState>;
  readonly #paths: LocalControlPaths;

  private constructor(listener: Bun.UnixSocketListener<ConnectionState>, paths: LocalControlPaths) {
    this.#listener = listener;
    this.#paths = paths;
  }

  public static async start(input: {
    readonly paths: LocalControlPaths;
    readonly secret: Uint8Array;
    readonly handler: LocalControlHandler;
  }): Promise<LocalControlServer> {
    if (input.secret.byteLength < 32) throw new LocalControlError("SECRET", "Secret is too short");
    await mkdir(input.paths.directory, { recursive: true, mode: 0o700 });
    if (process.platform !== "win32") await chmod(input.paths.directory, 0o700);
    await rm(input.paths.endpoint, { force: true });
    await writeFile(input.paths.secretPath, input.secret, { mode: 0o600 });
    if (process.platform !== "win32") await chmod(input.paths.secretPath, 0o600);

    const listener = Bun.listen<ConnectionState>({
      unix: input.paths.endpoint,
      socket: {
        open(socket) {
          socket.data = {
            bytes: new Uint8Array(),
            handled: false,
            peerVerified: verifyCurrentUserPeer(socket),
          };
        },
        data(socket, incoming) {
          if (socket.data.handled) return;
          socket.data.bytes = append(socket.data.bytes, incoming);
          let expected: number | undefined;
          try {
            expected = framedLength(socket.data.bytes);
          } catch {
            socket.data.handled = true;
            socket.end();
            return;
          }
          if (expected === undefined || socket.data.bytes.byteLength < expected) return;
          if (socket.data.bytes.byteLength !== expected) {
            socket.data.handled = true;
            socket.end();
            return;
          }
          socket.data.handled = true;
          void respond(socket, socket.data.bytes, input.secret, input.handler);
        },
        error() {},
      },
    });
    if (process.platform !== "win32") await chmod(input.paths.endpoint, 0o600);
    return new LocalControlServer(listener, input.paths);
  }

  public async close(): Promise<void> {
    this.#listener.stop(true);
    await rm(this.#paths.secretPath, { force: true });
    if (process.platform !== "win32") await rm(this.#paths.endpoint, { force: true });
  }

  public async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }
}

export async function requestLocalControl(
  body: HostLocalFrame["body"],
  paths = localControlPaths(),
): Promise<HostLocalFrame> {
  if (body.case === undefined) throw new LocalControlError("BODY", "Request body is missing");
  const secret = new Uint8Array(await readFile(paths.secretPath));
  const requestId = crypto.randomUUID();
  const request = authenticateHostLocalFrame(
    create(HostLocalFrameSchema, {
      protocolVersion: HOST_LOCAL_PROTOCOL_VERSION,
      requestId,
      body,
    }),
    secret,
  );
  const { promise, resolve, reject } = Promise.withResolvers<HostLocalFrame>();
  {
    let response: Uint8Array = new Uint8Array();
    void Bun.connect({
      unix: paths.endpoint,
      socket: {
        open(socket) {
          socket.write(encodeHostLocalFrame(request));
          socket.flush();
        },
        data(socket, incoming) {
          response = append(response, incoming);
          const expected = framedLength(response);
          if (expected === undefined || response.byteLength < expected) return;
          socket.end();
          try {
            const frame = decodeHostLocalFrame(response);
            if (
              frame.requestId !== requestId ||
              !verifyHostLocalFrameAuthentication(frame, secret)
            ) {
              throw new LocalControlError(
                "AUTHENTICATION",
                "Daemon response authentication failed",
              );
            }
            resolve(frame);
          } catch (error) {
            reject(error);
          }
        },
        connectError(_socket, error) {
          reject(
            new LocalControlError("CONNECT", "Unable to connect to Host Daemon", { cause: error }),
          );
        },
        error(_socket, error) {
          reject(new LocalControlError("IO", "Host local control socket failed", { cause: error }));
        },
        close() {},
      },
    }).catch(reject);
  }
  return promise;
}

export function localControlPaths(environment = process.env): LocalControlPaths {
  const directory =
    environment.POCKET_OMP_RUNTIME_DIR ??
    (process.platform === "win32"
      ? join(environment.LOCALAPPDATA ?? tmpdir(), "pocket-omp")
      : join(
          environment.XDG_RUNTIME_DIR ?? tmpdir(),
          `pocket-omp-${process.getuid?.() ?? "user"}`,
        ));
  return {
    directory,
    endpoint:
      process.platform === "win32"
        ? `\\\\.\\pipe\\pocket-omp-${environment.USERNAME ?? "user"}`
        : join(directory, "control.sock"),
    secretPath: join(directory, "control.secret"),
  };
}

async function respond(
  socket: Bun.Socket<ConnectionState>,
  bytes: Uint8Array,
  secret: Uint8Array,
  handler: LocalControlHandler,
): Promise<void> {
  try {
    if (!(await socket.data.peerVerified)) {
      socket.end();
      return;
    }
    const request = decodeHostLocalFrame(bytes);
    if (!verifyHostLocalFrameAuthentication(request, secret)) {
      socket.end();
      return;
    }
    let body: HostLocalFrame["body"];
    try {
      body = await handler(request);
    } catch (error) {
      body = {
        case: "error",
        value: create(HostLocalErrorSchema, {
          code: error instanceof LocalControlError ? error.code : "INTERNAL",
          message: error instanceof Error ? error.message : String(error),
        }),
      };
    }
    const response = authenticateHostLocalFrame(
      create(HostLocalFrameSchema, {
        protocolVersion: HOST_LOCAL_PROTOCOL_VERSION,
        requestId: request.requestId,
        body,
      }),
      secret,
    );
    socket.end(encodeHostLocalFrame(response));
  } catch {
    socket.end();
  }
}

function framedLength(bytes: Uint8Array): number | undefined {
  if (bytes.byteLength < 4) return undefined;
  const length = new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0, false);
  if (length === 0 || length > HOST_LOCAL_FRAME_MAX_BYTES) {
    throw new LocalControlError("FRAME", "Invalid local control frame length");
  }
  return length + 4;
}

function append(left: Uint8Array, right: Uint8Array): Uint8Array {
  const result = new Uint8Array(left.byteLength + right.byteLength);
  result.set(left);
  result.set(right, left.byteLength);
  return result;
}

export class LocalControlError extends Error {
  public constructor(
    public readonly code:
      | "SECRET"
      | "BODY"
      | "AUTHENTICATION"
      | "CONNECT"
      | "IO"
      | "FRAME"
      | "INTERNAL"
      | "SESSION"
      | "HANDOFF",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "LocalControlError";
  }
}
