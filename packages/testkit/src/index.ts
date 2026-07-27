export class DeterministicBytes {
  #state: bigint;

  public constructor(seed: bigint) {
    if (seed === 0n) throw new Error("DeterministicBytes seed must be non-zero");
    this.#state = BigInt.asUintN(64, seed);
  }

  public bytes(length: number): Uint8Array {
    if (!Number.isSafeInteger(length) || length < 0) throw new RangeError("Invalid byte length");
    const output = new Uint8Array(length);
    for (let index = 0; index < length; index += 1) {
      let state = this.#state;
      state ^= state << 13n;
      state ^= state >> 7n;
      state ^= state << 17n;
      this.#state = BigInt.asUintN(64, state);
      output[index] = Number(this.#state & 0xffn);
    }
    return output;
  }
}

export class ManualClock {
  public constructor(public nowMs: bigint) {}

  public advance(milliseconds: bigint): void {
    if (milliseconds < 0n) throw new RangeError("Clock cannot move backwards");
    this.nowMs += milliseconds;
  }
}

export async function collectAsync<T>(source: AsyncIterable<T>, limit: number): Promise<T[]> {
  if (!Number.isSafeInteger(limit) || limit <= 0) throw new RangeError("Invalid collection limit");
  const collected: T[] = [];
  for await (const item of source) {
    collected.push(item);
    if (collected.length >= limit) break;
  }
  return collected;
}
