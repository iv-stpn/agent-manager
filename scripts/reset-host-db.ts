#!/usr/bin/env bun
/**
 * Deletes the host database so it gets recreated (with fresh seeds) on next API start.
 */
import { existsSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";

const rootDir = resolve(import.meta.dir, "..");
const dbPath = join(rootDir, "host.db");
const walPath = `${dbPath}-wal`;
const shmPath = `${dbPath}-shm`;

for (const file of [dbPath, walPath, shmPath]) {
	if (existsSync(file)) {
		unlinkSync(file);
		console.log(`Deleted ${file}`);
	}
}

console.log("Host database reset. It will be recreated on next API start.");
