import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "sqlite",
  schema: "./src/persistence/schema.ts",
  out: "./drizzle",
  dbCredentials: {
    url: "./data/watcher/watcher.db",
  },
});
