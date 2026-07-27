import { expect, test } from "bun:test";
import { KeyringSecureKeyStore } from "../src/index";

class MemoryKeyringEntry {
  public constructor(
    private readonly key: string,
    private readonly secrets: Map<string, Uint8Array>,
  ) {}
  public async setSecret(secret: Uint8Array): Promise<void> {
    this.secrets.set(this.key, secret.slice());
  }
  public async getSecret(): Promise<Uint8Array | undefined> {
    return this.secrets.get(this.key)?.slice();
  }
  public async deleteCredential(): Promise<boolean> {
    return this.secrets.delete(this.key);
  }
}

test("secure key store isolates handles and does not alias secret buffers", async () => {
  const secrets = new Map<string, Uint8Array>();
  const store = new KeyringSecureKeyStore(
    "com.pocket-omp.test",
    (service, handle) => new MemoryKeyringEntry(`${service}:${handle}`, secrets),
  );
  const source = new Uint8Array([1, 2, 3]);
  await store.put("route:device:key-1", source);
  source.fill(9);
  const loaded = await store.get("route:device:key-1");
  expect(loaded).toEqual(new Uint8Array([1, 2, 3]));
  loaded?.fill(8);
  expect(await store.get("route:device:key-1")).toEqual(new Uint8Array([1, 2, 3]));
  expect(await store.get("route:device:key-2")).toBeUndefined();
  await store.delete("route:device:key-1");
  expect(await store.get("route:device:key-1")).toBeUndefined();
});

test("secure key store rejects malformed identifiers and secrets", async () => {
  const store = new KeyringSecureKeyStore(
    "com.pocket-omp.test",
    () => new MemoryKeyringEntry("x", new Map()),
  );
  expect(store.put("../escape", new Uint8Array([1]))).rejects.toMatchObject({
    code: "INVALID_HANDLE",
  });
  expect(store.put("valid", new Uint8Array())).rejects.toMatchObject({
    code: "INVALID_SECRET",
  });
  expect(() => new KeyringSecureKeyStore("service with spaces")).toThrow(
    "Invalid secure-store service",
  );
});

test("secure key store keeps backend failures distinct from missing secrets", async () => {
  const store = new KeyringSecureKeyStore("com.pocket-omp.test", () => ({
    setSecret: async () => {
      throw new Error("locked");
    },
    getSecret: async () => {
      throw new Error("locked");
    },
    deleteCredential: async () => {
      throw new Error("locked");
    },
  }));
  expect(store.get("valid")).rejects.toMatchObject({ code: "BACKEND_FAILURE" });
  expect(store.put("valid", new Uint8Array([1]))).rejects.toMatchObject({
    code: "BACKEND_FAILURE",
  });
  expect(store.delete("valid")).rejects.toMatchObject({ code: "BACKEND_FAILURE" });
});
