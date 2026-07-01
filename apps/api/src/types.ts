import type { ProjectDocker, ProjectManager } from "@agent-manager/projects";
import type { OrchestratorDatabase, ProjectDatabase } from "./db";
import type { EventHub } from "./lib/event-hub";
import type { Logger } from "./lib/logger";

export type HonoOrchestratorVariables = {
	manager: ProjectManager;
	docker: ProjectDocker;
	projectDatabaseManager: ProjectDatabase;
	hub: EventHub;
	logger: Logger;
	requestId: string;
	orchestratorDb: OrchestratorDatabase;
};

export type HonoOrchestratorEnv = {
	Variables: HonoOrchestratorVariables;
};
