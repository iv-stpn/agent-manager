import type { ProjectDocker, ProjectManager } from "@agent-manager/projects";
import type { HostDatabase, ProjectDatabase } from "./db";
import type { EventHub } from "./lib/event-hub";
import type { Logger } from "./lib/logger";

export type HonoHostVariables = {
	manager: ProjectManager;
	docker: ProjectDocker;
	projectDatabaseManager: ProjectDatabase;
	hub: EventHub;
	logger: Logger;
	requestId: string;
	hostDb: HostDatabase;
};

export type HonoHostEnv = {
	Variables: HonoHostVariables;
};
