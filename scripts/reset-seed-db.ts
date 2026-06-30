#!/usr/bin/env bun
/**
 * Resets the host database and re-seeds it with defaults.
 * Unlike reset-host-db.ts (which only deletes the file), this script
 * recreates the database immediately so you don't need to start the API.
 */
import { existsSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";

const rootDir = resolve(import.meta.dir, "..");
const dbPath = resolve(rootDir, "host.db");
const walPath = `${dbPath}-wal`;
const shmPath = `${dbPath}-shm`;

// 1. Delete existing database files
for (const file of [dbPath, walPath, shmPath]) {
	if (existsSync(file)) {
		unlinkSync(file);
		console.log(`Deleted ${file}`);
	}
}

// 2. Recreate and seed by instantiating HostDatabase
const { HostDatabase } = await import("../apps/host-api/src/db/host-database");
new HostDatabase(rootDir);

console.log("Host database reset and seeded successfully.");
