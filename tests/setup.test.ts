#!/usr/bin/env bun

/**
 * Setup Verification Test
 *
 * Verifies the project environment is correctly configured.
 * Tests:
 * - Environment variables
 * - Dependencies installed
 * - Configuration files present
 * - Project structure
 */

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";

console.log("🧪 Setup Verification Test\n");

let passed = 0;
let failed = 0;

function pass(message: string) {
	console.log(`✅ ${message}`);
	passed++;
}

function fail(message: string) {
	console.log(`❌ ${message}`);
	failed++;
}

function warn(message: string) {
	console.log(`⚠️  ${message}`);
}

// Test 1: Check project structure
console.log("1️⃣  Checking project structure...");
const requiredDirs = ["apps/host-api", "apps/host-web", "apps/cli", "packages/projects", "project-template", "tests"];

for (const dir of requiredDirs) {
	if (existsSync(dir)) {
		pass(`Directory exists: ${dir}`);
	} else {
		fail(`Directory missing: ${dir}`);
	}
}

// Test 2: Check configuration files
console.log("\n2️⃣  Checking configuration files...");
const requiredFiles = ["package.json", "tsconfig.json", "biome.json", ".gitignore"];

for (const file of requiredFiles) {
	if (existsSync(file)) {
		pass(`Config file exists: ${file}`);
	} else {
		fail(`Config file missing: ${file}`);
	}
}

// Test 3: Check dependencies
console.log("\n3️⃣  Checking dependencies...");
if (existsSync("node_modules")) {
	pass("Dependencies installed (node_modules exists)");
} else {
	fail("Dependencies not installed - run: bun install");
}

// Test 4: Check environment files
console.log("\n4️⃣  Checking environment configuration...");
if (existsSync(".env.example")) {
	pass("Environment example exists");
} else {
	warn("No .env.example file");
}

if (process.env.ANTHROPIC_API_KEY) {
	if (process.env.ANTHROPIC_API_KEY.startsWith("sk-ant-")) {
		pass("ANTHROPIC_API_KEY is set");
	} else {
		warn("ANTHROPIC_API_KEY is set but may be invalid");
	}
} else {
	warn("ANTHROPIC_API_KEY not set (required for integration tests)");
}

// Test 5: Check package.json scripts
console.log("\n5️⃣  Checking package.json scripts...");
try {
	const pkg = JSON.parse(await readFile("package.json", "utf-8"));
	const requiredScripts = ["dev", "host", "host-web", "projects", "test:e2e", "test:integration"];

	for (const script of requiredScripts) {
		if (pkg.scripts[script]) {
			pass(`Script defined: ${script}`);
		} else {
			fail(`Script missing: ${script}`);
		}
	}
} catch (_error) {
	fail("Could not read package.json");
}

// Test 6: Check template structure
console.log("\n6️⃣  Checking template structure...");
const templateFiles = ["project-template/src/index.ts", "project-template/package.json", "project-template/Dockerfile"];

for (const file of templateFiles) {
	if (existsSync(file)) {
		pass(`Template file exists: ${file}`);
	} else {
		fail(`Template file missing: ${file}`);
	}
}

// Summary
console.log(`\n${"=".repeat(60)}`);
console.log(`Setup Verification: ${passed} passed, ${failed} failed`);
console.log("=".repeat(60));

if (failed === 0) {
	console.log("\n✅ Setup is correct! You can now:");
	console.log("   - Run tests: bun run test:e2e");
	console.log("   - Start host: bun run dev");
	console.log("   - Create projects: bun run projects create <name>");
	if (!process.env.ANTHROPIC_API_KEY) {
		console.log("\n⚠️  For full integration tests, set ANTHROPIC_API_KEY:");
		console.log("   export ANTHROPIC_API_KEY=sk-ant-...");
	}
	process.exit(0);
} else {
	console.log("\n❌ Setup has issues. Please fix the errors above.");
	process.exit(1);
}
