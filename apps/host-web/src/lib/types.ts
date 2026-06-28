import type { ProjectConfig, ProjectStats } from "@agent-manager/projects";

export type {
	AgentConfig,
	ProjectConfig,
	ProjectStats,
	SessionRecord,
} from "@agent-manager/projects";

// Docker status — mirrors the inline return type of ProjectDocker.getProjectStatus().
export interface ProjectDockerContainer {
	name: string;
	status: string;
	ports: string;
}

export interface ProjectDockerStatus {
	running: boolean;
	containers: ProjectDockerContainer[];
}

export type EnrichedProject = ProjectConfig & {
	dockerStatus: ProjectDockerStatus;
	stats: ProjectStats;
	logLines: number | null;
};

export type Project = EnrichedProject;

// Lightweight session shape from the project overview's recentSessions field.
export interface RecentSession {
	id: string;
	title: string | null;
	created_at: string;
	updated_at: string;
}
