import { defineConfig } from "@playwright/test";
export default defineConfig({ testDir: "./e2e", workers: 1, timeout: 75_000, reporter: "list" });
