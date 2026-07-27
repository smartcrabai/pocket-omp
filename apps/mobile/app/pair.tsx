import { CameraView, useCameraPermissions, type BarcodeScanningResult } from "expo-camera";
import { router } from "expo-router";
import * as SecureStore from "expo-secure-store";
import { useState, type ReactElement } from "react";
import { ActivityIndicator, Pressable, SafeAreaView, StyleSheet, Text, View } from "react-native";
import {
  derivePairwiseKey,
  generateX25519KeyPair,
  pairingConfirmationCode,
  pairingTranscriptHash,
} from "@pocket-omp/crypto";
import { useAuth } from "../src/auth";
import { palette, spacing } from "../src/theme";

interface PairingQr {
  protocolVersion: number;
  pairingId: string;
  challenge: string;
  hostPublicKey: string;
  expiresAtMs: number;
  serviceIdentifier: string;
}
interface EstablishedPairing {
  readonly pairingId: string;
  readonly routeId: string;
  readonly confirmationCode: string;
}

export default function PairScreen(): ReactElement {
  const auth = useAuth();
  const [permission, requestPermission] = useCameraPermissions();
  const [working, setWorking] = useState(false);
  const [established, setEstablished] = useState<EstablishedPairing>();
  const [failure, setFailure] = useState<string>();
  const controlUrl = process.env.EXPO_PUBLIC_CONTROL_URL;
  const onScan = async ({ data }: BarcodeScanningResult): Promise<void> => {
    if (working || established !== undefined) return;
    setWorking(true);
    setFailure(undefined);
    try {
      if (auth.accessToken === undefined || controlUrl === undefined)
        throw new Error("Control Plane is not configured");
      const qr = parsePairingQr(data);
      if (BigInt(qr.expiresAtMs) < BigInt(Date.now())) throw new Error("Pairing code has expired");
      const mobile = generateX25519KeyPair({
        bytes: (length) => crypto.getRandomValues(new Uint8Array(length)),
      });
      const response = await fetch(
        `${controlUrl}/v1/pairings/${encodeURIComponent(qr.pairingId)}/claim`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${auth.accessToken}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ mobile_public_key: hex(mobile.publicKey) }),
        },
      );
      if (!response.ok) throw new Error(`Pairing claim failed (${response.status})`);
      const claim: unknown = await response.json();
      if (
        typeof claim !== "object" ||
        claim === null ||
        !("route_id" in claim) ||
        typeof claim.route_id !== "string" ||
        claim.route_id.length === 0
      )
        throw new Error("Pairing response is invalid");
      const hostPublicKey = fromHex(qr.hostPublicKey);
      const transcriptHash = pairingTranscriptHash({
        protocolVersion: qr.protocolVersion,
        serviceIdentifier: qr.serviceIdentifier,
        pairingId: qr.pairingId,
        challenge: fromHex(qr.challenge),
        hostPublicKey,
        mobilePublicKey: mobile.publicKey,
        expiresAtMs: BigInt(qr.expiresAtMs),
      });
      const pairwiseKey = derivePairwiseKey({
        localSecretKey: mobile.secretKey,
        peerPublicKey: hostPublicKey,
        pairingTranscriptHash: transcriptHash,
        routeId: claim.route_id,
        localDeviceId: "mobile",
        peerDeviceId: "host",
      });
      const routeIds = readRouteIds(await SecureStore.getItemAsync("pocket-omp.paired-routes"));
      if (!routeIds.includes(claim.route_id)) routeIds.push(claim.route_id);
      await Promise.all([
        SecureStore.setItemAsync(`pairing.${qr.pairingId}.secret`, base64(mobile.secretKey), {
          keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
        }),
        SecureStore.setItemAsync(`route.${claim.route_id}.key`, base64(pairwiseKey), {
          keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
        }),
        SecureStore.setItemAsync("pocket-omp.paired-routes", JSON.stringify(routeIds), {
          keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
        }),
      ]);
      setEstablished({
        pairingId: qr.pairingId,
        routeId: claim.route_id,
        confirmationCode: pairingConfirmationCode(transcriptHash, pairwiseKey),
      });
    } catch (error) {
      setFailure(error instanceof Error ? error.message : "Pairing failed");
    } finally {
      setWorking(false);
    }
  };
  const confirm = async (): Promise<void> => {
    if (established === undefined || auth.accessToken === undefined || controlUrl === undefined)
      return;
    setWorking(true);
    try {
      const response = await fetch(
        `${controlUrl}/v1/pairings/${encodeURIComponent(established.pairingId)}/complete`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${auth.accessToken}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            actor: "mobile",
            confirmation_code: established.confirmationCode,
          }),
        },
      );
      if (!response.ok) throw new Error(`Pairing confirmation failed (${response.status})`);
      router.replace("/");
    } catch (error) {
      setFailure(error instanceof Error ? error.message : "Pairing confirmation failed");
      setWorking(false);
    }
  };
  if (permission === null)
    return (
      <SafeAreaView style={styles.center}>
        <ActivityIndicator color={palette.signal} />
      </SafeAreaView>
    );
  if (!permission.granted)
    return (
      <SafeAreaView style={styles.center}>
        <Text style={styles.title}>
          Camera access is required only to scan the one-time Host code.
        </Text>
        <Pressable
          style={styles.primary}
          onPress={() => {
            void requestPermission();
          }}
        >
          <Text style={styles.primaryText}>ALLOW CAMERA</Text>
        </Pressable>
      </SafeAreaView>
    );
  return (
    <SafeAreaView style={styles.shell}>
      {established === undefined ? (
        <>
          <View style={styles.cameraFrame}>
            <CameraView
              style={StyleSheet.absoluteFill}
              barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
              onBarcodeScanned={(result) => {
                void onScan(result);
              }}
            />
            <View style={styles.reticle} />
          </View>
          <Text style={styles.step}>PAIRING / SCAN</Text>
          <Text style={styles.body}>
            The code expires after five minutes and never contains a bearer token or private key.
          </Text>
        </>
      ) : (
        <View style={styles.confirm}>
          <Text style={styles.step}>PAIRING / VERIFY BOTH SCREENS</Text>
          <Text
            accessibilityLabel={`Confirmation code ${established.confirmationCode}`}
            style={styles.code}
          >
            {established.confirmationCode.slice(0, 3)} {established.confirmationCode.slice(3)}
          </Text>
          <Text style={styles.body}>Continue only if this exact code appears on the Host.</Text>
          <Pressable
            testID="confirm-pairing-button"
            disabled={working}
            style={styles.primary}
            onPress={() => {
              void confirm();
            }}
          >
            <Text style={styles.primaryText}>CODES MATCH</Text>
          </Pressable>
        </View>
      )}
      {working ? <ActivityIndicator color={palette.signal} /> : null}
      {failure === undefined ? null : (
        <Text accessibilityRole="alert" style={styles.error}>
          {failure}
        </Text>
      )}
    </SafeAreaView>
  );
}

function parsePairingQr(data: string): PairingQr {
  const value: unknown = JSON.parse(data);
  if (
    typeof value !== "object" ||
    value === null ||
    !("protocolVersion" in value) ||
    value.protocolVersion !== 1 ||
    !("pairingId" in value) ||
    typeof value.pairingId !== "string" ||
    !("challenge" in value) ||
    typeof value.challenge !== "string" ||
    !/^[0-9a-f]{64}$/.test(value.challenge) ||
    !("hostPublicKey" in value) ||
    typeof value.hostPublicKey !== "string" ||
    !/^[0-9a-f]{64}$/.test(value.hostPublicKey) ||
    !("expiresAtMs" in value) ||
    typeof value.expiresAtMs !== "number" ||
    !("serviceIdentifier" in value) ||
    value.serviceIdentifier !== "pocket-omp"
  )
    throw new Error("Pairing QR contract is invalid");
  return {
    protocolVersion: value.protocolVersion,
    pairingId: value.pairingId,
    challenge: value.challenge,
    hostPublicKey: value.hostPublicKey,
    expiresAtMs: value.expiresAtMs,
    serviceIdentifier: value.serviceIdentifier,
  };
}
function readRouteIds(value: string | null): string[] {
  if (value === null) return [];
  const parsed: unknown = JSON.parse(value);
  return Array.isArray(parsed) && parsed.every((item) => typeof item === "string") ? parsed : [];
}
function fromHex(value: string): Uint8Array {
  const result = new Uint8Array(value.length / 2);
  for (let index = 0; index < result.length; index += 1)
    result[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  return result;
}
const hex = (value: Uint8Array): string =>
  [...value].map((byte) => byte.toString(16).padStart(2, "0")).join("");
const base64 = (value: Uint8Array): string => btoa(String.fromCharCode(...value));
const styles = StyleSheet.create({
  shell: { flex: 1, backgroundColor: palette.ink, padding: spacing.lg, gap: spacing.md },
  center: {
    flex: 1,
    backgroundColor: palette.ink,
    padding: spacing.lg,
    justifyContent: "center",
    gap: spacing.lg,
  },
  cameraFrame: {
    flex: 1,
    maxHeight: 480,
    overflow: "hidden",
    borderWidth: 1,
    borderColor: palette.line,
  },
  reticle: {
    position: "absolute",
    left: "15%",
    top: "20%",
    width: "70%",
    aspectRatio: 1,
    borderWidth: 2,
    borderColor: palette.signal,
  },
  step: { color: palette.signal, fontSize: 11, fontWeight: "800", letterSpacing: 1.5 },
  title: { color: palette.paper, fontSize: 28, fontWeight: "300" },
  body: { color: palette.muted, fontSize: 16, lineHeight: 24 },
  confirm: { flex: 1, justifyContent: "center", gap: spacing.lg },
  code: { color: palette.paper, fontSize: 58, fontVariant: ["tabular-nums"], letterSpacing: 4 },
  primary: {
    minHeight: 56,
    backgroundColor: palette.signal,
    alignItems: "center",
    justifyContent: "center",
    padding: spacing.md,
  },
  primaryText: { color: palette.ink, fontWeight: "900", letterSpacing: 1 },
  error: { color: palette.danger },
});
