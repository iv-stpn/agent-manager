import { join } from "node:path";
import { ProjectDocker, ProjectManager, resolveWorkspaceRoot } from "@agent-manager/projects";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { OrchestratorDatabase, ProjectDatabase } from "./db";
import { destroyDiscordBot, startDiscordBot } from "./discord/bot";
import {
	archiveSessionChannel,
	type ChannelStore,
	createSessionChannel,
	ensureProjectCategory,
	ensureProjectPinnedChannels,
	setChannelStore,
} from "./discord/channels";
import { setProjectResolver } from "./discord/commands";
import { env } from "./env";
import { EventHub } from "./lib/event-hub";
import { createLogger } from "./lib/logger";
import { authGuard } from "./middleware/auth";
import { requestLogger, responseLogger } from "./middleware/logging";
import { checkChromium } from "./render/chromium";
import { discordRouter, setDiscordRouteChannelStore } from "./routes/discord";
import { guidelineCategoriesRouter } from "./routes/guideline-categories";
import { guidelinesRouter } from "./routes/guidelines";
import { llmClientsRouter } from "./routes/llm-clients";
import { memoryRouter } from "./routes/memory";
import { projectsRouter } from "./routes/projects";
import { renderRouter } from "./routes/render";
import { techStacksRouter } from "./routes/tech-stacks";
import { templatesRouter } from "./routes/templates";
import type { HonoOrchestratorEnv } from "./types";

export type {
	Guideline,
	GuidelineCategory,
	LlmClient,
	LlmProvider,
	StackEntry,
	StackLibrary,
	TechStack,
	Template,
	TemplateCategory,
} from "./db";
export type { WorkspaceFolderStatus } from "./routes/projects";

const rootDir = resolveWorkspaceRoot(import.meta.dir);

const manager = new ProjectManager(rootDir);
const docker = new ProjectDocker(manager);
const projectDatabaseManager = new ProjectDatabase(manager);
const hub = new EventHub(manager, docker);
const orchestratorDb = new OrchestratorDatabase(rootDir);

const logger = createLogger({ DISCORD_WEBHOOK_URL: env.DISCORD_WEBHOOK_URL });

const app = new Hono<HonoOrchestratorEnv>()
	.use("*", (c, next) => {
		c.env = env;
		return next();
	})
	.use(
		"*",
		cors({
			origin: [env.ORCHESTRATOR_WEB_URL],
			allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
			allowHeaders: ["Content-Type", "Authorization"],
			exposeHeaders: ["X-Request-Id"],
		})
	)
	.use("*", requestLogger)
	.use("*", responseLogger)
	.use("/api/*", authGuard)
	.use("*", (c, next) => {
		c.set("manager", manager);
		c.set("docker", docker);
		c.set("projectDatabaseManager", projectDatabaseManager);
		c.set("hub", hub);
		c.set("orchestratorDb", orchestratorDb);
		return next();
	})
	.get("/", (c) => c.text("Hello from Agent Manager API"))
	.get("/health", (c) => c.json({ ok: true, ts: Date.now(), service: "agent-manager-api" }))
	.route("/api/projects", projectsRouter)
	.route("/api/projects", discordRouter)
	.route("/api/tech-stacks", techStacksRouter)
	.route("/api/guideline-categories", guidelineCategoriesRouter)
	.route("/api/guidelines", guidelinesRouter)
	.route("/api/llm-clients", llmClientsRouter)
	.route("/api/render", renderRouter)
	.route("/api/memory", memoryRouter)
	.route("/api/templates", templatesRouter);

const chromiumReady = await checkChromium();
if (chromiumReady) {
	logger.info("Rendering enabled — connected to Chromium container");
} else {
	logger.warn(
		"Chromium container not reachable — /api/render (mermaid) will fail. " +
			"Start shared services: docker compose -f docker-compose.yml up -d"
	);
}

const lanceReady = await fetch(`${env.LANCEDB_URL}/health`, { signal: AbortSignal.timeout(3000) })
	.then((response) => response.ok)
	.catch(() => false);

if (lanceReady) {
	logger.info("Memory enabled — connected to LanceDB container");
} else {
	logger.warn(
		"LanceDB container not reachable — /api/memory will fail. " +
			"Start shared services: docker compose -f docker-compose.yml up -d"
	);
}

if (env.ORCHESTRATOR_API_TOKEN) {
	logger.info("API auth enabled — /api/* requires a bearer token");
} else {
	logger.warn(
		"ORCHESTRATOR_API_TOKEN is not set — the API is UNAUTHENTICATED. Anyone who can reach " +
			`port ${env.ORCHESTRATOR_PORT} can create/delete projects, read API keys and clear host paths. ` +
			"Set ORCHESTRATOR_API_TOKEN and bind to loopback unless this is a deliberate trusted-network setup."
	);
}

logger.info(`Workspace root: ${rootDir}`);
logger.info(`Projects dir: ${join(rootDir, ".projects")}`);

// ── Discord bot ──────────────────────────────────────────────────────────────
const discordToken = env.DISCORD_TOKEN;
const discordClientId = env.DISCORD_CLIENT_ID;
const discordGuildId = env.DISCORD_GUILD_ID;

if (discordToken && discordClientId && discordGuildId) {
	// Build a ChannelStore backed by OrchestratorDatabase
	const discordChannelStore: ChannelStore = {
		get(projectId, type) {
			return orchestratorDb.getDiscordChannelByProjectAndType(projectId, type);
		},
		getBySession(sessionId) {
			return orchestratorDb.getDiscordChannelBySession(sessionId);
		},
		save(channel) {
			orchestratorDb.saveDiscordChannel(channel);
		},
		delete(id) {
			orchestratorDb.deleteDiscordChannel(id);
		},
		listByProject(projectId) {
			return orchestratorDb.listDiscordChannelsByProject(projectId);
		},
	};

	setChannelStore(discordChannelStore);
	setDiscordRouteChannelStore(discordChannelStore);

	// Project resolver for slash commands: find running project port
	setProjectResolver(async (projectId: string) => {
		const project = await manager.getProject(projectId);
		if (!project) return null;
		return { port: project.ports.server };
	});

	// Subscribe to EventHub for channel lifecycle
	hub.subscribe(async (event) => {
		try {
			if (event.type === "session_created") {
				const data = event.data as { id: string; name?: string; task?: string };
				const project = await manager.getProject(event.projectId);
				if (!project) return;

				// Ensure category exists
				const categoryId = await ensureProjectCategory(event.projectId, project.name);
				if (!categoryId) return;
				await ensureProjectPinnedChannels(event.projectId, categoryId);

				// Create session channel
				const sessionName = data.name || data.task?.slice(0, 40) || data.id.slice(0, 8);
				await createSessionChannel(event.projectId, data.id, sessionName);
			}

			if (event.type === "session_updated") {
				const data = event.data as { id: string; status?: string };
				if (data.status === "aborted" || data.status === "completed") {
					await archiveSessionChannel(data.id);
				}
			}
		} catch (err) {
			logger.error(`[Discord] Channel lifecycle error: ${err}`);
		}
	});

	startDiscordBot(discordToken, discordGuildId, discordClientId)
		.then(() => logger.info("Discord bot started"))
		.catch((err) => logger.error(`Discord bot failed to start: ${err}`));
} else {
	logger.warn("[Discord] DISCORD_TOKEN, DISCORD_CLIENT_ID, or DISCORD_GUILD_ID not set — bot disabled");
}

// ── Graceful shutdown ─────────────────────────────────────────────────────────
// Close the DB, tear down EventHub upstreams, and destroy the Discord client on
// SIGINT/SIGTERM so the process exits cleanly instead of leaking sockets/handles.
//
// Container stop is gated behind ORCHESTRATOR_STOP_CONTAINERS_ON_SHUTDOWN (default
// off): with `bun --watch` in dev, every file save restarts the process, and a
// naive stopAllProjects() would kill every running project container on each
// reload. The DB/EventHub/Discord cleanup is always safe, so it runs regardless.
let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
	if (shuttingDown) return;
	shuttingDown = true;
	logger.info(`Received ${signal} — shutting down`);

	if (env.ORCHESTRATOR_STOP_CONTAINERS_ON_SHUTDOWN) {
		try {
			const stopped = await docker.stopAllProjects();
			if (stopped.length > 0) logger.info(`Stopped ${stopped.length} project container(s)`);
		} catch (err) {
			logger.error(`Error stopping project containers: ${err}`);
		}
	}

	try {
		hub.close();
	} catch (err) {
		logger.error(`Error closing EventHub: ${err}`);
	}

	try {
		await destroyDiscordBot();
	} catch (err) {
		logger.error(`Error destroying Discord client: ${err}`);
	}

	try {
		orchestratorDb.close();
	} catch (err) {
		logger.error(`Error closing orchestrator DB: ${err}`);
	}

	logger.info("Shutdown complete");
	process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

// Only the type travels to orchestrator web — no server code is bundled.
export type AppType = typeof app;
export default { port: env.ORCHESTRATOR_PORT, fetch: app.fetch, idleTimeout: 120 };
