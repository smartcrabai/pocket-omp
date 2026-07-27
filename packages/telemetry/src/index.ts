import { metrics, trace, type Attributes, type Meter, type Tracer } from "@opentelemetry/api";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-proto";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { NodeSDK } from "@opentelemetry/sdk-node";

const FORBIDDEN_ATTRIBUTE_FRAGMENTS = [
  "ciphertext",
  "plaintext",
  "prompt",
  "token",
  "api_key",
  "authorization",
  "file.path",
  "push_token",
  "pairing_challenge",
] as const;

export interface TelemetryOptions {
  readonly serviceName: string;
  readonly serviceVersion: string;
  readonly deploymentEnvironment: string;
  readonly otlpHttpOrigin: URL;
}

export interface TelemetryHandle {
  readonly tracer: Tracer;
  readonly meter: Meter;
  shutdown(): Promise<void>;
}

export function initializeTelemetry(options: TelemetryOptions): TelemetryHandle {
  if (options.otlpHttpOrigin.protocol !== "http:" && options.otlpHttpOrigin.protocol !== "https:") {
    throw new TelemetryError("OTLP origin must use HTTP or HTTPS");
  }
  const origin = options.otlpHttpOrigin.href.replace(/\/$/, "");
  const sdk = new NodeSDK({
    resource: resourceFromAttributes({
      "service.name": options.serviceName,
      "service.version": options.serviceVersion,
      "deployment.environment.name": options.deploymentEnvironment,
    }),
    traceExporter: new OTLPTraceExporter({ url: `${origin}/v1/traces` }),
    metricReaders: [
      new PeriodicExportingMetricReader({
        exporter: new OTLPMetricExporter({ url: `${origin}/v1/metrics` }),
        exportIntervalMillis: 10_000,
      }),
    ],
  });
  sdk.start();
  return {
    tracer: trace.getTracer(options.serviceName, options.serviceVersion),
    meter: metrics.getMeter(options.serviceName, options.serviceVersion),
    shutdown: async () => sdk.shutdown(),
  };
}

export function safeAttributes(attributes: Attributes): Attributes {
  const safe: Attributes = {};
  for (const [key, value] of Object.entries(attributes)) {
    const normalized = key.toLowerCase();
    if (FORBIDDEN_ATTRIBUTE_FRAGMENTS.some((fragment) => normalized.includes(fragment))) {
      throw new TelemetryError(`Forbidden telemetry attribute: ${key}`);
    }
    if (typeof value === "string" && value.length > 256) {
      throw new TelemetryError(`Telemetry string attribute is too long: ${key}`);
    }
    safe[key] = value;
  }
  return safe;
}

export class TelemetryError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "TelemetryError";
  }
}
