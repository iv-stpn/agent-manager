import type { Db } from "./db";

export type HonoProjectVariables = {
	db: Db;
};

export type HonoProjectEnv = {
	Variables: HonoProjectVariables;
};
