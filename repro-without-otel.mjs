// Same as repro.mjs but WITHOUT OTEL instrumentation
// This demonstrates that MSW alone works fine

import { setupServer } from "msw/node";
import { http, passthrough } from "msw";

setupServer(
	http.all("*", ({ request }) => {
		if (request.url.includes("launchdarkly")) {
			console.log("\n[MSW] Intercepted:", request.url);
			console.log("[MSW] Auth header:", request.headers.get("authorization"));
			console.log(
				"[MSW] All headers:",
				Object.fromEntries(request.headers.entries()),
			);
		}
		return passthrough();
	}),
).listen({
	onUnhandledRequest: "bypass",
});

console.log("MSW server started (NO OTEL)\n");

const ld = await import("@launchdarkly/node-server-sdk");
const client = ld.default.init(process.env.LAUNCHDARKLY_SDK_KEY);

try {
	await client.waitForInitialization({ timeout: 15 });
	console.log("\n✅ SUCCESS: LaunchDarkly initialized");
	process.exit(0);
} catch (e) {
	console.log("\n❌ FAILED:", e.message);
	process.exit(1);
}
