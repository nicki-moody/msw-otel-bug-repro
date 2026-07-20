// Basic OpenTelemetry instrumentation setup
import { NodeSDK } from "@opentelemetry/sdk-node";
import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node";

const sdk = new NodeSDK({
	instrumentations: [getNodeAutoInstrumentations()],
});

sdk.start();

console.log("[OTEL] OpenTelemetry SDK started");
