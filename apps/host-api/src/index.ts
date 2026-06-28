import { join } from "node:path";
import { HostDatabase, ProjectDatabase, ProjectDocker, ProjectManager, resolveWorkspaceRoot } from "@agent-manager/projects";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { EventHub } from "./lib/event-hub";
import { createLogger } from "./lib/logger";
import { requestLogger, responseLogger } from "./middleware/logging";
import { resolveChromium } from "./render/chromium";
import { guidelineCategoriesRouter } from "./routes/guideline-categories";
import { guidelinesRouter } from "./routes/guidelines";
import { projectsRouter } from "./routes/projects";
import { renderRouter } from "./routes/render";
import { techStacksRouter } from "./routes/tech-stacks";
import type { HonoHostEnv } from "./types";

const PORT = Number(process.env.HOST_PORT ?? 3100);

const rootDir = resolveWorkspaceRoot(import.meta.dir);

const manager = new ProjectManager(rootDir);
const docker = new ProjectDocker(manager);
const projectDatabaseManager = new ProjectDatabase(manager);
const hub = new EventHub(manager, docker);
const hostDb = new HostDatabase(rootDir);

const logger = createLogger({ DISCORD_WEBHOOK_URL: process.env.DISCORD_WEBHOOK_URL });

const app = new Hono<HonoHostEnv>()
	.use(
		"*",
		cors({
			origin: [process.env.HOST_WEB_URL ?? "http://localhost:3101"],
			allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
			allowHeaders: ["Content-Type", "Authorization"],
			exposeHeaders: ["X-Request-Id"],
		})
	)
	.use("*", requestLogger)
	.use("*", responseLogger)
	.use("*", (c, next) => {
		c.set("manager", manager);
		c.set("docker", docker);
		c.set("projectDatabaseManager", projectDatabaseManager);
		c.set("hub", hub);
		c.set("hostDb", hostDb);
		return next();
	})
	.get("/", (c) => c.text("Hello from Agent Manager API"))
	.get("/health", (c) => c.json({ ok: true, ts: Date.now(), service: "agent-manager-api" }))
	.route("/api/projects", projectsRouter)
	.route("/api/tech-stacks", techStacksRouter)
	.route("/api/guideline-categories", guidelineCategoriesRouter)
	.route("/api/guidelines", guidelinesRouter)
	.route("/api/render", renderRouter);

const chromium = resolveChromium();
if (chromium) {
	logger.info(`Rendering enabled — Chromium: ${chromium}`);
} else {
	logger.warn(
		"Chromium not found — /api/render (mermaid + screenshots) will fail. " +
			"Install Chromium on this host or set PUPPETEER_EXECUTABLE_PATH."
	);
}

logger.info(`Workspace root: ${rootDir}`);
logger.info(`Projects dir: ${join(rootDir, ".projects")}`);

// Only the type travels to host-web — no server code is bundled.
export type AppType = typeof app;
export default { port: PORT, fetch: app.fetch, idleTimeout: 120 };
