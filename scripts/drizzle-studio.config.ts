// Drizzle Kit config for browsing a project's agent.db in Drizzle Studio.
// Not used for migrations (those are hand-rolled in packages/db/src/migrate.ts).
// Consumed by scripts/db-studio.ts, which resolves the project and passes the
// database's absolute path via PROJECT_DB_PATH.
import { defineConfig } from "drizzle-kit";

const url = process.env.PROJECT_DB_PATH;
if (!url) throw new Error("PROJECT_DB_PATH not set — run via `bun db:studio <project>`");

export default defineConfig({
	dialect: "sqlite",
	schema: "packages/db/src/project-schema.ts",
	dbCredentials: { url },
});
