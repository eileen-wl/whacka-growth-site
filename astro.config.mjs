import { defineConfig } from "astro/config";
import { loadEnv } from "vite";
import sitemap from "@astrojs/sitemap";

// astro.config.mjs runs before Astro has loaded the project's env, so
// import.meta.env isn't available here — load .env manually instead.
// Empty prefix ("") loads every var regardless of prefix, not just PUBLIC_.
const { PUBLIC_SITE_URL } = loadEnv(process.env.NODE_ENV ?? "development", process.cwd(), "");

const SITE_URL = PUBLIC_SITE_URL || "http://localhost:4321";

// https://astro.build/config
export default defineConfig({
  site: SITE_URL,
  integrations: [sitemap()],
});
