import type { Db } from "./db";

type HonoProjectVariables = {
	db: Db;
};

export type HonoProjectEnv = {
	Variables: HonoProjectVariables;
};
