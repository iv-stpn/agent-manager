import type { HostDatabase, ProjectDatabase, ProjectDocker, ProjectManager } from "@agent-manager/projects";
import type { Env } from "./env";
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
	Bindings: Env;
	Variables: HonoHostVariables;
};
