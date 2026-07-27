import {
  AesGcmSecretProtector,
  ExpoPushGateway,
  PostgresControlStore,
  PostgresDeviceRepository,
  PostgresPushTokenRepository,
  PostgresPushWorkQueue,
  SystemClock,
  UuidV7Generator,
} from "@pocket-omp/control-adapters";
import { PushApplication, PushWorker } from "@pocket-omp/control-core";

const databaseUrl = requiredEnvironment("CONTROL_DATABASE_URL");
const encryptionKey = decodeBase64Key(requiredEnvironment("PUSH_TOKEN_ENCRYPTION_KEY"));
const encryptionKeyId = requiredEnvironment("PUSH_TOKEN_ENCRYPTION_KEY_ID");
const workerId = process.env.WORKER_ID ?? `push-${Bun.randomUUIDv7()}`;
const abort = new AbortController();
process.on("SIGINT", () => abort.abort());
process.on("SIGTERM", () => abort.abort());

async function main(): Promise<void> {
  const store = await PostgresControlStore.connect(databaseUrl);
  try {
    await store.migrate();
    const clock = new SystemClock();
    const push = new PushApplication(
      new PostgresDeviceRepository(store),
      new PostgresPushTokenRepository(store),
      await AesGcmSecretProtector.fromRawKey(encryptionKey, encryptionKeyId),
      new ExpoPushGateway(),
      new UuidV7Generator(),
    );
    const worker = new PushWorker(new PostgresPushWorkQueue(store), push, clock, workerId);
    /* oxlint-disable eslint/no-await-in-loop -- The worker intentionally drains one lease batch before polling again. */
    while (!abort.signal.aborted) {
      const result = await worker.runOnce();
      await Bun.sleep(result.completed + result.failed === 0 ? 1_000 : 10);
    }
    /* oxlint-enable eslint/no-await-in-loop */
  } finally {
    await store.close();
  }
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) throw new Error(`${name} is required`);
  return value;
}

function decodeBase64Key(value: string): Uint8Array {
  const decoded = Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
  if (decoded.byteLength !== 32)
    throw new Error("PUSH_TOKEN_ENCRYPTION_KEY must decode to 32 bytes");
  return decoded;
}

await main();
