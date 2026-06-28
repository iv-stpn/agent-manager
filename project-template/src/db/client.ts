import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { env } from "../env";
import * as schema from "./schema";

export type Db = BunSQLiteDatabase<typeof schema>;

let _db: ReturnType<typeof drizzle> | null = null;

function ensureDir(path: string) {
	const dir = dirname(path);
	if (dir && dir !== ".") {
		mkdirSync(dir, { recursive: true });
	}
}

export function getDb(path = env.DATABASE_PATH) {
	if (_db) return _db;
	ensureDir(path);
	const sqlite = new Database(path, { create: true });
	sqlite.exec("PRAGMA journal_mode = WAL;");
	sqlite.exec("PRAGMA foreign_keys = ON;");
	_db = drizzle(sqlite, { schema });
	return _db;
}

export function initDb(path = env.DATABASE_PATH) {
	ensureDir(path);
	const sqlite = new Database(path, { create: true });
	sqlite.exec("PRAGMA journal_mode = WAL;");
	sqlite.exec("PRAGMA foreign_keys = ON;");
	sqlite.exec(`
		CREATE TABLE IF NOT EXISTS sessions (
			id TEXT PRIMARY KEY,
			name TEXT,
			task TEXT NOT NULL,
			status TEXT NOT NULL DEFAULT 'running',
			report_interval_mins INTEGER NOT NULL DEFAULT 15,
			total_timeout_mins INTEGER NOT NULL DEFAULT 240,
			freeze_report_mode TEXT NOT NULL DEFAULT 'never',
			freeze_report_custom_rule TEXT,
			freeze_ask_mode TEXT NOT NULL DEFAULT 'always',
			compact_threshold_tokens INTEGER NOT NULL DEFAULT 80000,
			stop_threshold_tokens INTEGER NOT NULL DEFAULT 400000,
			always_improve_mode TEXT NOT NULL DEFAULT 'no',
			always_improve_scope TEXT,
			total_input_tokens INTEGER NOT NULL DEFAULT 0,
			total_output_tokens INTEGER NOT NULL DEFAULT 0,
			total_cache_read_tokens INTEGER NOT NULL DEFAULT 0,
			total_cache_write_tokens INTEGER NOT NULL DEFAULT 0,
			discord_channel_id TEXT,
			created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
			updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
		);

		CREATE TABLE IF NOT EXISTS messages (
			id TEXT PRIMARY KEY,
			session_id TEXT NOT NULL REFERENCES sessions(id),
			role TEXT NOT NULL,
			content TEXT NOT NULL,
			input_tokens INTEGER DEFAULT 0,
			output_tokens INTEGER DEFAULT 0,
			cache_read_tokens INTEGER DEFAULT 0,
			cache_write_tokens INTEGER DEFAULT 0,
			error TEXT,
			error_details TEXT,
			created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
		);

		CREATE TABLE IF NOT EXISTS tool_calls (
			id TEXT PRIMARY KEY,
			session_id TEXT NOT NULL REFERENCES sessions(id),
			message_id TEXT NOT NULL REFERENCES messages(id),
			tool_name TEXT NOT NULL,
			tool_use_id TEXT NOT NULL,
			input TEXT NOT NULL,
			output TEXT,
			status TEXT NOT NULL DEFAULT 'pending',
			created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
			completed_at INTEGER
		);

		CREATE TABLE IF NOT EXISTS checkins (
			id TEXT PRIMARY KEY,
			session_id TEXT NOT NULL REFERENCES sessions(id),
			trigger TEXT NOT NULL,
			summary TEXT NOT NULL,
			discord_message_id TEXT,
			status TEXT NOT NULL DEFAULT 'pending',
			created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
			completed_at INTEGER
		);

		CREATE TABLE IF NOT EXISTS questions (
			id TEXT PRIMARY KEY,
			session_id TEXT NOT NULL REFERENCES sessions(id),
			checkin_id TEXT REFERENCES checkins(id),
			text TEXT NOT NULL,
			context TEXT,
			answer TEXT,
			is_urgent INTEGER NOT NULL DEFAULT 0,
			created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
			answered_at INTEGER
		);

		CREATE TABLE IF NOT EXISTS reports (
			id TEXT PRIMARY KEY,
			session_id TEXT NOT NULL REFERENCES sessions(id),
			trigger TEXT NOT NULL,
			title TEXT NOT NULL,
			content TEXT NOT NULL,
			created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
		);

		CREATE TABLE IF NOT EXISTS compactions (
			id TEXT PRIMARY KEY,
			session_id TEXT NOT NULL REFERENCES sessions(id),
			messages_before INTEGER NOT NULL,
			messages_after INTEGER NOT NULL,
			tokens_before INTEGER NOT NULL,
			tokens_after INTEGER NOT NULL,
			threshold_tokens INTEGER NOT NULL,
			summary TEXT NOT NULL DEFAULT '',
			created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
		);
	`);

	sqlite.exec(`
		CREATE TABLE IF NOT EXISTS tasks (
			id TEXT PRIMARY KEY,
			session_id TEXT REFERENCES sessions(id),
			text TEXT NOT NULL,
			status TEXT NOT NULL DEFAULT 'pending',
			metadata TEXT,
			created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
			updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
		);
	`);

	// Migrate legacy session-scoped `todos` into project-wide `tasks`, then drop
	// the old table. Wrapped in try/catch so it's a no-op once migrated.
	try {
		const hasTodos = sqlite.query("SELECT name FROM sqlite_master WHERE type='table' AND name='todos'").get();
		if (hasTodos) {
			sqlite.exec(`
				INSERT OR IGNORE INTO tasks (id, session_id, text, status, created_at, updated_at)
				SELECT id, session_id, text, status, created_at, updated_at FROM todos;
			`);
			sqlite.exec("DROP TABLE todos;");
		}
	} catch (_e) {
		// Nothing to migrate, ignore.
	}

	// Migrations for existing databases
	try {
		// Add name column to sessions if it doesn't exist
		sqlite.exec("ALTER TABLE sessions ADD COLUMN name TEXT");
	} catch (_e) {
		// Column already exists, ignore
	}

	try {
		// Add error columns to messages if they don't exist
		sqlite.exec("ALTER TABLE messages ADD COLUMN error TEXT");
		sqlite.exec("ALTER TABLE messages ADD COLUMN error_details TEXT");
	} catch (_e) {
		// Columns already exist, ignore
	}

	try {
		// Add cache token columns to sessions if they don't exist
		sqlite.exec("ALTER TABLE sessions ADD COLUMN total_cache_read_tokens INTEGER NOT NULL DEFAULT 0");
		sqlite.exec("ALTER TABLE sessions ADD COLUMN total_cache_write_tokens INTEGER NOT NULL DEFAULT 0");
	} catch (_e) {
		// Columns already exist, ignore
	}

	try {
		// Add cache token columns to messages if they don't exist
		sqlite.exec("ALTER TABLE messages ADD COLUMN cache_read_tokens INTEGER DEFAULT 0");
		sqlite.exec("ALTER TABLE messages ADD COLUMN cache_write_tokens INTEGER DEFAULT 0");
	} catch (_e) {
		// Columns already exist, ignore
	}

	return drizzle(sqlite, { schema });
}
