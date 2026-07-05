import type { ProjectConfig, ProjectStats } from "@agent-manager/projects";

// Docker status — mirrors the inline return type of ProjectDocker.getProjectStatus().
interface ProjectDockerContainer {
	name: string;
	status: string;
	ports: string;
}

interface ProjectDockerStatus {
	running: boolean;
	containers: ProjectDockerContainer[];
}

export type EnrichedProject = ProjectConfig & {
	dockerStatus: ProjectDockerStatus;
	stats: ProjectStats;
	logLines: number | null;
};

export type Project = EnrichedProject;
