import { RedisClient, SQL } from "bun";
import { afterAll, describe, expect, test } from "bun:test";

const databases = [
  new SQL(
    process.env.RELAY_HOME_DATABASE_URL ??
      "postgres://pocket:pocket-dev-only@127.0.0.1:55432/relay_home",
  ),
  new SQL(
    process.env.RELAY_STANDBY_DATABASE_URL ??
      "postgres://pocket:pocket-dev-only@127.0.0.1:55433/relay_standby",
  ),
  new SQL(
    process.env.CONTROL_DATABASE_URL ?? "postgres://pocket:pocket-dev-only@127.0.0.1:55434/control",
  ),
];
const redis = new RedisClient(process.env.REDIS_URL ?? "redis://127.0.0.1:56379");

const objectOrigins = [
  process.env.OBJECT_HOME_ORIGIN ?? "http://127.0.0.1:59000",
  process.env.OBJECT_STANDBY_ORIGIN ?? "http://127.0.0.1:59010",
] as const;

afterAll(async () => {
  await Promise.all(databases.map(async (database) => database.close()));
  redis.close();
});

describe("multi-region development infrastructure", () => {
  test("all owned PostgreSQL databases are independent and writable", async () => {
    const markers = await Promise.all(
      databases.map(async (database, index) => {
        const result =
          await database`SELECT ${index}::integer AS marker, current_database() AS database`;
        return result[0];
      }),
    );
    expect(markers.map((row) => row?.marker)).toEqual([0, 1, 2]);
    expect(new Set(markers.map((row) => row?.database)).size).toBe(3);
  });

  test("Redis wake-up bus is reachable", async () => {
    await redis.set("pocket-omp:integration:health", "ready");
    expect(await redis.get("pocket-omp:integration:health")).toBe("ready");
    await redis.del("pocket-omp:integration:health");
  });

  test("both encrypted object storage regions are ready", async () => {
    const responses = await Promise.all(
      objectOrigins.map(async (origin) => fetch(`${origin}/minio/health/ready`)),
    );
    expect(responses.every((response) => response.ok)).toBe(true);
  });
});
