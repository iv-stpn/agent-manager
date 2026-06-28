import type { MasterDatabase, ProjectDatabase, ProjectDocker, ProjectManager } from "@agent-manager/projects";
import type { EventHub } from "./lib/event-hub";
import type { Logger } from "./lib/logger";

export type HonoMasterVariables = {
	manager: ProjectManager;
	docker: ProjectDocker;
	projectDatabaseManager: ProjectDatabase;
	hub: EventHub;
	logger: Logger;
	requestId: string;
	masterDb: MasterDatabase;
};

export type HonoMasterEnv = {
	Variables: HonoMasterVariables;
};
