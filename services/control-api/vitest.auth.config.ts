import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

// Relay-auth variant: RELAY_AUTH_DISABLED=false so the production authorize()
// path (JWT verification + claim/device/route enforcement) is exercised.
export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "../../wrangler.jsonc" },
      miniflare: {
        bindings: {
          RELAY_AUTH_DISABLED: "false",
          ADMIN_AUTH_DISABLED: "true",
          CONTROL_AUTH_DISABLED: "true",
          ENTITLEMENT_AUTO_GRANT: "true",
          SERVICE_IDENTIFIER: "pocket-omp",
          RELAY_SIGNING_PRIVATE_KEY:
            "eyJjcnYiOiJFZDI1NTE5IiwiZCI6IjRQTlhsU05TVVZiNlBmay1TUUhaMG5WUmxqYVFwbTRrM0Y1SFIxN0t5UlUiLCJrdHkiOiJPS1AiLCJ4IjoidHZYclNkOHY3RUJBNWdkNG9SUmxPQUJhQzcxZlBKSnBvcWZsVnhiWE1jVSIsImtpZCI6InJlbGF5LXNpZ25pbmctMSIsImFsZyI6IkVkRFNBIiwidXNlIjoic2lnIn0=",
          REVIEW_HOST_ENABLED: "true",
          DEPLOYMENT_PURPOSE: "app-review",
        },
      },
    }),
  ],
  test: { include: ["test-auth/**/*.ts"] },
});
