import { expect, test } from "bun:test";
import {
  EncryptedStorageApplication,
  SnapshotRetentionApplication,
  type EncryptedObjectRepository,
  type MultipartBlobStore,
  type StoredEncryptedObject,
} from "../src/index";

class MemoryObjects implements EncryptedObjectRepository {
  public readonly values = new Map<string, StoredEncryptedObject>();
  public async usage(accountId: string): Promise<bigint> {
    return [...this.values.values()]
      .filter((item) => item.accountId === accountId)
      .reduce((sum, item) => sum + item.ciphertextSize, 0n);
  }
  public async reserve(object: StoredEncryptedObject): Promise<void> {
    this.values.set(object.objectId, object);
  }
  public async get(id: string): Promise<StoredEncryptedObject | undefined> {
    return this.values.get(id);
  }
  public async markAvailable(id: string): Promise<void> {
    const value = this.values.get(id);
    if (value !== undefined) this.values.set(id, { ...value, status: "available" });
  }
  public async listExpired(now: bigint): Promise<readonly StoredEncryptedObject[]> {
    return [...this.values.values()].filter((item) => item.expiresAtMs <= now);
  }
  public async listAccount(accountId: string): Promise<readonly StoredEncryptedObject[]> {
    return [...this.values.values()].filter((item) => item.accountId === accountId);
  }
  public async remove(id: string): Promise<void> {
    this.values.delete(id);
  }
}
class MemoryBlobs implements MultipartBlobStore {
  public readonly deleted: string[] = [];
  public hash = new Uint8Array(32).fill(1);
  public async begin(id: string): Promise<string> {
    return `upload-${id}`;
  }
  public async putPart(_upload: string, part: number): Promise<string> {
    return `etag-${part}`;
  }
  public async complete(): Promise<void> {}
  public async abort(id: string): Promise<void> {
    this.deleted.push(id);
  }
  public async delete(id: string): Promise<void> {
    this.deleted.push(id);
  }
  public async replicate(): Promise<{ readonly ciphertextHash: Uint8Array }> {
    return { ciphertextHash: this.hash };
  }
}
const hash = (bytes: Uint8Array): Uint8Array =>
  new Uint8Array(new Bun.CryptoHasher("sha256").update(bytes).digest());

test("encrypted multipart lifecycle enforces quota, chunk hashes, completion, replication, and expiry", async () => {
  const objects = new MemoryObjects();
  const blobs = new MemoryBlobs();
  const app = new EncryptedStorageApplication(objects, blobs, 100n);
  const ciphertext = new Uint8Array([1, 2, 3]);
  const fullHash = new Uint8Array(32).fill(1);
  const uploadId = await app.begin({
    objectId: "object-1",
    accountId: "account-1",
    ciphertextSize: 3n,
    ciphertextHash: fullHash,
    expiresAtMs: 2_000n,
    nowMs: 1_000n,
  });
  expect(uploadId).toBe("upload-object-1");
  expect(await app.uploadPart(uploadId, 1, ciphertext, hash(ciphertext))).toBe("etag-1");
  expect(app.uploadPart(uploadId, 1, ciphertext, new Uint8Array(32))).rejects.toMatchObject({
    code: "PART_HASH_MISMATCH",
  });
  await app.complete("object-1", [{ partNumber: 1, etag: "etag-1" }]);
  expect(app.replicate("object-1", "standby-1")).resolves.toBeUndefined();
  blobs.hash = new Uint8Array(32).fill(2);
  expect(app.replicate("object-1", "standby-1")).rejects.toMatchObject({
    code: "REPLICATION_HASH_MISMATCH",
  });
  expect(await app.expire(2_000n)).toBe(1);
  expect(objects.values.size).toBe(0);
});

test("privacy deletion removes every ciphertext while retention prunes old snapshots", async () => {
  const objects = new MemoryObjects();
  const blobs = new MemoryBlobs();
  const app = new EncryptedStorageApplication(objects, blobs, 100n);
  await app.begin({
    objectId: "object-1",
    accountId: "account-1",
    ciphertextSize: 1n,
    ciphertextHash: new Uint8Array(32),
    expiresAtMs: 2_000n,
    nowMs: 1_000n,
  });
  expect(await app.deleteAccount("account-1")).toBe(1);
  const removed: string[] = [];
  const retention = new SnapshotRetentionApplication(
    {
      listSession: async () => [
        { snapshotId: "s3", sessionId: "session-1", createdAtMs: 300n, objectId: "o3" },
        { snapshotId: "s2", sessionId: "session-1", createdAtMs: 200n, objectId: "o2" },
        { snapshotId: "s1", sessionId: "session-1", createdAtMs: 100n, objectId: "o1" },
      ],
      remove: async (id) => {
        removed.push(id);
      },
    },
    blobs,
  );
  expect(await retention.enforce("session-1", 350n, 1_000n, 2)).toBe(1);
  expect(removed).toEqual(["s1"]);
});
