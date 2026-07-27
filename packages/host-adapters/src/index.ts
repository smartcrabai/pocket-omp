import { AsyncEntry } from "@napi-rs/keyring";
import type { SecureKeyStore } from "@pocket-omp/host-core";

import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

export interface ValidatedWorkspacePath {
  readonly workspaceRoot: string;
  readonly canonicalPath: string;
  readonly relativePath: string;
  readonly kind: "file" | "directory";
}

export async function validateWorkspacePath(
  workspaceRoot: string,
  requestedPath: string,
): Promise<ValidatedWorkspacePath> {
  if (workspaceRoot.length === 0 || requestedPath.includes("\0")) {
    throw new WorkspacePathError("INVALID_PATH", "Invalid workspace path");
  }
  const canonicalRoot = await realpath(workspaceRoot);
  const candidate = isAbsolute(requestedPath)
    ? requestedPath
    : resolve(canonicalRoot, requestedPath.length === 0 ? "." : requestedPath);
  let canonicalPath: string;
  try {
    canonicalPath = await realpath(candidate);
  } catch (error) {
    throw new WorkspacePathError("NOT_FOUND", "Workspace path does not exist", { cause: error });
  }
  const relativePath = relative(canonicalRoot, canonicalPath);
  if (relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
    throw new WorkspacePathError("OUTSIDE_WORKSPACE", "Path resolves outside workspace");
  }
  const metadata = await lstat(canonicalPath);
  if (metadata.isSymbolicLink()) {
    throw new WorkspacePathError("SYMLINK", "Unresolved symbolic link is not allowed");
  }
  if (!metadata.isFile() && !metadata.isDirectory()) {
    throw new WorkspacePathError("SPECIAL_FILE", "Special files are not allowed");
  }
  if (relativePath === ".git" || relativePath.startsWith(`.git${sep}`)) {
    throw new WorkspacePathError("GIT_INTERNAL", "Direct access to .git is not allowed");
  }
  return {
    workspaceRoot: canonicalRoot,
    canonicalPath,
    relativePath,
    kind: metadata.isDirectory() ? "directory" : "file",
  };
}

export class WorkspacePathError extends Error {
  public constructor(
    public readonly code:
      | "INVALID_PATH"
      | "NOT_FOUND"
      | "OUTSIDE_WORKSPACE"
      | "SYMLINK"
      | "SPECIAL_FILE"
      | "GIT_INTERNAL",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "WorkspacePathError";
  }
}

interface KeyringEntry {
  setSecret(secret: Uint8Array): Promise<void>;
  getSecret(): Promise<Uint8Array | undefined>;
  deleteCredential(): Promise<boolean>;
}

export class KeyringSecureKeyStore implements SecureKeyStore {
  public constructor(
    private readonly service = "com.pocket-omp.host",
    private readonly createEntry: (service: string, handle: string) => KeyringEntry = (
      serviceName,
      handle,
    ) => new AsyncEntry(serviceName, handle),
  ) {
    if (!/^[A-Za-z0-9._-]{1,128}$/.test(service)) {
      throw new SecureKeyStoreError("INVALID_SERVICE", "Invalid secure-store service");
    }
  }

  public async put(handle: string, secret: Uint8Array): Promise<void> {
    const entry = this.entry(handle);
    if (secret.byteLength === 0 || secret.byteLength > 16_384) {
      throw new SecureKeyStoreError(
        "INVALID_SECRET",
        "Secret length is outside the secure-store boundary",
      );
    }
    try {
      await entry.setSecret(secret);
    } catch (error) {
      throw new SecureKeyStoreError("BACKEND_FAILURE", "Unable to write OS secure storage", {
        cause: error,
      });
    }
  }

  public async get(handle: string): Promise<Uint8Array | undefined> {
    try {
      const secret = await this.entry(handle).getSecret();
      return secret === undefined ? undefined : new Uint8Array(secret);
    } catch (error) {
      throw new SecureKeyStoreError("BACKEND_FAILURE", "Unable to read OS secure storage", {
        cause: error,
      });
    }
  }

  public async delete(handle: string): Promise<void> {
    try {
      await this.entry(handle).deleteCredential();
    } catch (error) {
      throw new SecureKeyStoreError("BACKEND_FAILURE", "Unable to delete from OS secure storage", {
        cause: error,
      });
    }
  }

  private entry(handle: string): KeyringEntry {
    if (!/^[A-Za-z0-9._:-]{1,256}$/.test(handle)) {
      throw new SecureKeyStoreError("INVALID_HANDLE", "Invalid secure-store handle");
    }
    return this.createEntry(this.service, handle);
  }
}

export class SecureKeyStoreError extends Error {
  public constructor(
    public readonly code:
      | "INVALID_SERVICE"
      | "INVALID_HANDLE"
      | "INVALID_SECRET"
      | "BACKEND_FAILURE",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "SecureKeyStoreError";
  }
}
