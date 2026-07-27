export interface StoredEncryptedObject {
  readonly objectId: string;
  readonly accountId: string;
  readonly ciphertextSize: bigint;
  readonly ciphertextHash: Uint8Array;
  readonly expiresAtMs: bigint;
  readonly status: "uploading" | "available" | "deleting";
  readonly uploadId?: string;
}

export interface EncryptedObjectRepository {
  usage(accountId: string): Promise<bigint>;
  reserve(object: StoredEncryptedObject, quotaBytes: bigint): Promise<void>;
  get(objectId: string): Promise<StoredEncryptedObject | undefined>;
  markAvailable(objectId: string): Promise<void>;
  listExpired(nowMs: bigint, limit: number): Promise<readonly StoredEncryptedObject[]>;
  listAccount(accountId: string): Promise<readonly StoredEncryptedObject[]>;
  remove(objectId: string): Promise<void>;
}

export interface MultipartBlobStore {
  begin(objectId: string): Promise<string>;
  putPart(
    uploadId: string,
    partNumber: number,
    ciphertext: Uint8Array,
    sha256: Uint8Array,
  ): Promise<string>;
  complete(
    uploadId: string,
    parts: readonly { readonly partNumber: number; readonly etag: string }[],
  ): Promise<void>;
  abort(uploadId: string): Promise<void>;
  delete(objectId: string): Promise<void>;
  replicate(
    objectId: string,
    targetRegion: string,
  ): Promise<{ readonly ciphertextHash: Uint8Array }>;
}

export class EncryptedStorageApplication {
  public constructor(
    private readonly objects: EncryptedObjectRepository,
    private readonly blobs: MultipartBlobStore,
    private readonly quotaBytes: bigint,
  ) {}

  public async begin(input: {
    readonly objectId: string;
    readonly accountId: string;
    readonly ciphertextSize: bigint;
    readonly ciphertextHash: Uint8Array;
    readonly expiresAtMs: bigint;
    readonly nowMs: bigint;
  }): Promise<string> {
    if (
      !identifier(input.objectId) ||
      !identifier(input.accountId) ||
      input.ciphertextSize <= 0n ||
      input.ciphertextSize > 512n * 1024n * 1024n ||
      input.ciphertextHash.byteLength !== 32 ||
      input.expiresAtMs <= input.nowMs ||
      input.expiresAtMs > input.nowMs + 7n * 86_400_000n
    )
      throw new StorageInvariantError("INVALID_OBJECT", "Invalid encrypted object reservation");
    if ((await this.objects.get(input.objectId)) !== undefined)
      throw new StorageInvariantError("DUPLICATE_OBJECT", "Encrypted object already exists");
    if ((await this.objects.usage(input.accountId)) + input.ciphertextSize > this.quotaBytes)
      throw new StorageInvariantError("QUOTA_EXCEEDED", "Encrypted storage quota exceeded");
    const uploadId = await this.blobs.begin(input.objectId);
    try {
      await this.objects.reserve(
        {
          objectId: input.objectId,
          accountId: input.accountId,
          ciphertextSize: input.ciphertextSize,
          ciphertextHash: input.ciphertextHash.slice(),
          expiresAtMs: input.expiresAtMs,
          status: "uploading",
          uploadId,
        },
        this.quotaBytes,
      );
      return uploadId;
    } catch (error) {
      await this.blobs.abort(uploadId);
      throw error;
    }
  }

  public async uploadPart(
    uploadId: string,
    partNumber: number,
    ciphertext: Uint8Array,
    expectedHash: Uint8Array,
  ): Promise<string> {
    if (
      !identifier(uploadId) ||
      !Number.isSafeInteger(partNumber) ||
      partNumber < 1 ||
      partNumber > 10_000 ||
      ciphertext.byteLength === 0 ||
      ciphertext.byteLength > 8 * 1024 * 1024 ||
      expectedHash.byteLength !== 32
    )
      throw new StorageInvariantError("INVALID_PART", "Invalid encrypted multipart chunk");
    const actual = new Uint8Array(new Bun.CryptoHasher("sha256").update(ciphertext).digest());
    if (!equal(actual, expectedHash))
      throw new StorageInvariantError("PART_HASH_MISMATCH", "Encrypted part hash mismatch");
    return this.blobs.putPart(uploadId, partNumber, ciphertext, expectedHash);
  }

  public async complete(
    objectId: string,
    parts: readonly { readonly partNumber: number; readonly etag: string }[],
  ): Promise<void> {
    const object = await this.objects.get(objectId);
    if (object?.status !== "uploading" || object.uploadId === undefined)
      throw new StorageInvariantError("INVALID_STATE", "Encrypted object is not uploading");
    if (
      parts.length === 0 ||
      parts.some((part, index) => part.partNumber !== index + 1 || !identifier(part.etag))
    )
      throw new StorageInvariantError("INVALID_PART", "Multipart completion is not contiguous");
    await this.blobs.complete(object.uploadId, parts);
    await this.objects.markAvailable(objectId);
  }

  public async expire(nowMs: bigint, limit = 100): Promise<number> {
    const expired = await this.objects.listExpired(nowMs, limit);
    await Promise.all(
      expired.map(async (object) => {
        if (object.uploadId !== undefined && object.status === "uploading") {
          await this.blobs.abort(object.uploadId);
        } else {
          await this.blobs.delete(object.objectId);
        }
        await this.objects.remove(object.objectId);
      }),
    );
    return expired.length;
  }

  public async replicate(objectId: string, targetRegion: string): Promise<void> {
    const object = await this.objects.get(objectId);
    if (object?.status !== "available" || !identifier(targetRegion))
      throw new StorageInvariantError("INVALID_STATE", "Encrypted object is not replicable");
    const receipt = await this.blobs.replicate(objectId, targetRegion);
    if (!equal(receipt.ciphertextHash, object.ciphertextHash))
      throw new StorageInvariantError(
        "REPLICATION_HASH_MISMATCH",
        "Replicated ciphertext hash mismatch",
      );
  }

  public async deleteAccount(accountId: string): Promise<number> {
    const objects = await this.objects.listAccount(accountId);
    await Promise.all(
      objects.map(async (object) => {
        if (object.uploadId !== undefined && object.status === "uploading") {
          await this.blobs.abort(object.uploadId);
        } else {
          await this.blobs.delete(object.objectId);
        }
        await this.objects.remove(object.objectId);
      }),
    );
    return objects.length;
  }
}

export interface EncryptedSnapshot {
  readonly snapshotId: string;
  readonly sessionId: string;
  readonly createdAtMs: bigint;
  readonly objectId: string;
}

export interface EncryptedSnapshotRepository {
  listSession(sessionId: string): Promise<readonly EncryptedSnapshot[]>;
  remove(snapshotId: string): Promise<void>;
}

export class SnapshotRetentionApplication {
  public constructor(
    private readonly snapshots: EncryptedSnapshotRepository,
    private readonly blobs: MultipartBlobStore,
  ) {}

  public async enforce(
    sessionId: string,
    nowMs: bigint,
    maximumAgeMs: bigint,
    maximumCount: number,
  ): Promise<number> {
    if (
      !identifier(sessionId) ||
      maximumAgeMs <= 0n ||
      !Number.isSafeInteger(maximumCount) ||
      maximumCount < 1
    )
      throw new StorageInvariantError("INVALID_OBJECT", "Invalid snapshot retention policy");
    const snapshots = [...(await this.snapshots.listSession(sessionId))].toSorted((left, right) =>
      left.createdAtMs > right.createdAtMs ? -1 : left.createdAtMs < right.createdAtMs ? 1 : 0,
    );
    const expired = snapshots.filter(
      (snapshot, index) => index >= maximumCount || nowMs - snapshot.createdAtMs > maximumAgeMs,
    );
    await Promise.all(
      expired.map(async (snapshot) => {
        await this.blobs.delete(snapshot.objectId);
        await this.snapshots.remove(snapshot.snapshotId);
      }),
    );
    return expired.length;
  }
}

function identifier(value: string): boolean {
  return /^[\x21-\x7e]{1,128}$/.test(value);
}
function equal(left: Uint8Array, right: Uint8Array): boolean {
  let difference = left.byteLength ^ right.byteLength;
  const length = Math.max(left.byteLength, right.byteLength);
  for (let index = 0; index < length; index += 1)
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  return difference === 0;
}
export class StorageInvariantError extends Error {
  public constructor(
    public readonly code:
      | "INVALID_OBJECT"
      | "DUPLICATE_OBJECT"
      | "QUOTA_EXCEEDED"
      | "INVALID_PART"
      | "PART_HASH_MISMATCH"
      | "INVALID_STATE"
      | "REPLICATION_HASH_MISMATCH",
    message: string,
  ) {
    super(message);
    this.name = "StorageInvariantError";
  }
}
