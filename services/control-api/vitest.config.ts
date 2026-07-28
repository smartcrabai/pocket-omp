import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "../../wrangler.jsonc" },
      miniflare: {
        bindings: {
          RELAY_AUTH_DISABLED: "true",
          ADMIN_AUTH_DISABLED: "true",
          REVIEW_HOST_ENABLED: "true",
          DEPLOYMENT_PURPOSE: "app-review",
        },
      },
    }),
  ],
  test: { include: ["test/**/*.ts"] },
});
