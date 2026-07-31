import { describe, expect, test } from "bun:test";
import type {
  HostEnvelopeCrypto,
  HostInboundEnvelope,
  HostOutboxItem,
} from "@pocket-omp/host-core";

import {
  learningEnvelopeCrypto,
  RecipientDeviceIdLearner,
} from "../src/recipient-device-id-learner";

describe("RecipientDeviceIdLearner", () => {
  test("starts undefined when no initial value is given", () => {
    expect(new RecipientDeviceIdLearner().current).toBeUndefined();
  });

  test("can be seeded with an initial, config-provided value", () => {
    expect(new RecipientDeviceIdLearner("mobile-configured").current).toBe("mobile-configured");
  });

  test("learn() updates current, and ignores an empty id", () => {
    const learner = new RecipientDeviceIdLearner();
    learner.learn("mobile-1");
    expect(learner.current).toBe("mobile-1");
    learner.learn("");
    expect(learner.current).toBe("mobile-1");
    learner.learn("mobile-2");
    expect(learner.current).toBe("mobile-2");
  });
});

function fakeCrypto(openResult: Uint8Array, encrypted: unknown): HostEnvelopeCrypto {
  return {
    seal: async (recipientDeviceId: string, plaintext: Uint8Array): Promise<HostOutboxItem> => ({
      messageId: `sealed-for-${recipientDeviceId}-${plaintext.length}`,
      encrypted,
    }),
    open: async (): Promise<Uint8Array> => openResult,
  };
}

function inbound(encrypted: unknown): HostInboundEnvelope {
  return { messageId: "message-1", serverSequence: 1n, encrypted };
}

describe("learningEnvelopeCrypto", () => {
  test("learns senderDeviceId from a bare sealed-envelope-shaped object after a successful open()", async () => {
    const learner = new RecipientDeviceIdLearner();
    const plaintext = new Uint8Array([1, 2, 3]);
    const crypto = learningEnvelopeCrypto(
      fakeCrypto(plaintext, { senderDeviceId: "mobile-1", other: "field" }),
      learner,
    );

    const opened = await crypto.open(inbound({ senderDeviceId: "mobile-1" }));
    expect(opened).toBe(plaintext);
    expect(learner.current).toBe("mobile-1");
  });

  test("learns senderDeviceId from a DeliveredEnvelope-wrapped shape (envelope.senderDeviceId)", async () => {
    const learner = new RecipientDeviceIdLearner();
    const crypto = learningEnvelopeCrypto(
      fakeCrypto(new Uint8Array(), { envelope: { senderDeviceId: "mobile-2" } }),
      learner,
    );

    await crypto.open(inbound({ envelope: { senderDeviceId: "mobile-2" } }));
    expect(learner.current).toBe("mobile-2");
  });

  test("does not learn from an envelope that fails to open (unauthenticated)", async () => {
    const learner = new RecipientDeviceIdLearner();
    const failingCrypto: HostEnvelopeCrypto = {
      seal: async () => ({ messageId: "x", encrypted: {} }),
      open: async () => {
        throw new Error("AEAD authentication failed");
      },
    };
    const crypto = learningEnvelopeCrypto(failingCrypto, learner);

    await expect(crypto.open(inbound({ senderDeviceId: "attacker-controlled" }))).rejects.toThrow(
      "AEAD authentication failed",
    );
    expect(learner.current).toBeUndefined();
  });

  test("does not learn when the envelope shape carries no recognizable senderDeviceId", async () => {
    const learner = new RecipientDeviceIdLearner("mobile-existing");
    const crypto = learningEnvelopeCrypto(
      fakeCrypto(new Uint8Array(), { nothing: "useful" }),
      learner,
    );

    await crypto.open(inbound({ nothing: "useful" }));
    expect(learner.current).toBe("mobile-existing"); // unchanged
  });

  test("passes seal() through unchanged", async () => {
    const learner = new RecipientDeviceIdLearner();
    const crypto = learningEnvelopeCrypto(fakeCrypto(new Uint8Array(), {}), learner);
    const sealed = await crypto.seal("mobile-1", new Uint8Array([1, 2]));
    expect(sealed.messageId).toBe("sealed-for-mobile-1-2");
  });
});
