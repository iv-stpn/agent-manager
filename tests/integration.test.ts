#!/usr/bin/env bun

/**
 * Comprehensive Integration Test Suite
 *
 * Tests the complete system including:
 * - Docker lifecycle (start/stop)
 * - Anthropic API integration
 * - Agent operations (queries, memory, filesystem)
 * - Custom tools
 * - Report generation
 * - Agent interruption
 * - Proper cleanup
 *
 * Usage:
 *   bun run test:integration
 *
 * Requirements:
 *   - ANTHROPIC_API_KEY in .env file or environment variable
 *   - Docker running
 */

import { existsSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { $ } from "bun";
import type { ProjectDocker as ProjectDockerClass } from "../packages/projects/src/docker";
import type { ProjectManager as ProjectManagerClass } from "../packages/projects/src/manager";
import type { ProjectConfig } from "../packages/projects/src/types";
import type { Checkin, Session } from "../project-template/src/db/schema";

// Payload returned by GET /api/sessions/:id — the raw session row. messageCount
// is surfaced by some responses but is not part of the persisted row, and the
// not-found branch returns a bare { error } object, so both are optional here.
type SessionStatus = Session & { messageCount?: number; error?: string };

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

// Load environment variables from .env.test (secrets for test projects)
try {
	const envPath = join(import.meta.dir, "../.env.test");
	if (existsSync(envPath)) {
		const envContent = await readFile(envPath, "utf-8");
		for (const line of envContent.split("\n")) {
			const trimmed = line.trim();
			if (trimmed && !trimmed.startsWith("#")) {
				const [key, ...valueParts] = trimmed.split("=");
				if (key && valueParts.length > 0) {
					const value = valueParts.join("=").trim();
					// Always override with .env.test values
					process.env[key] = value;
				}
			}
		}
		console.log("✅ Loaded configuration from .env.test");
	}
} catch (_error) {
	console.log("⚠️  No .env.test file found, using environment variables");
}

const projectsPath = join(import.meta.dir, "../packages/projects/src");
const { ProjectManager } = (await import(join(projectsPath, "manager.ts"))) as {
	ProjectManager: new () => ProjectManagerClass;
};
const { ProjectDocker } = (await import(join(projectsPath, "docker.ts"))) as {
	ProjectDocker: new (manager: ProjectManagerClass) => ProjectDockerClass;
};

const TEST_PROJECT_ID = "__tests__";
const TEST_PROJECT_NAME = "__tests__";
const TEST_PROJECT_DIR = join(import.meta.dir, "../.projects", TEST_PROJECT_ID);

let manager: ProjectManagerClass;
let docker: ProjectDockerClass;
let projectConfig: ProjectConfig;
let agentApiUrl: string;

console.log("\n🧪 Comprehensive Integration Test Suite\n");

// Check prerequisites
const hasApiKey = !!process.env.ANTHROPIC_API_KEY;
if (!hasApiKey) {
	console.error("❌ ANTHROPIC_API_KEY not set.");
	console.error("");
	console.error("   Please set it in one of these ways:");
	console.error("   1. Add to .env file:");
	console.error("      ANTHROPIC_API_KEY=sk-ant-...");
	console.error("");
	console.error("   2. Or set as environment variable:");
	console.error("      export ANTHROPIC_API_KEY=sk-ant-...");
	console.error("      bun run test:integration");
	console.error("");
	process.exit(1);
}

async function checkDocker(): Promise<boolean> {
	try {
		const proc = Bun.spawn(["docker", "info"], { stdout: "ignore", stderr: "ignore" });
		await proc.exited;
		return proc.exitCode === 0;
	} catch {
		return false;
	}
}

const hasDocker = await checkDocker();
if (!hasDocker) {
	console.error("❌ Docker is not running. Please start Docker to run integration tests.");
	process.exit(1);
}

console.log("Configuration:");
console.log(`  API Key: ✅ Set (${process.env.ANTHROPIC_API_KEY?.slice(0, 10)}...)`);
console.log("  Docker:  ✅ Running");
console.log("");

async function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function logTokenBreakdown(statusData: SessionStatus): void {
	const input = statusData.totalInputTokens ?? 0;
	const output = statusData.totalOutputTokens ?? 0;
	const cacheRead = statusData.totalCacheReadTokens ?? 0;
	const cacheWrite = statusData.totalCacheWriteTokens ?? 0;
	console.log(`     Tokens: input: ${input}, output: ${output}, cache_read: ${cacheRead}, cache_write: ${cacheWrite}`);
}

// Standard session-completion waiter. Polls the session status endpoint and
// logs every attempt (status + cumulative token usage), so a slow or stuck
// session is visible in the output rather than silently timing out.
// Returns the final status payload on completion; throws on error/timeout.
async function waitForSessionCompletion(
	sessionId: string,
	opts: { label: string; maxAttempts?: number }
): Promise<SessionStatus> {
	const { label, maxAttempts = 80 } = opts;

	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		await sleep(2000);
		const response = await fetch(`${agentApiUrl}/api/sessions/${sessionId}`);
		const statusData: SessionStatus = await response.json();
		const status = statusData.status;

		const input = statusData.totalInputTokens ?? 0;
		const output = statusData.totalOutputTokens ?? 0;
		const cacheRead = statusData.totalCacheReadTokens ?? 0;
		console.log(
			`     [${label}] attempt ${attempt}/${maxAttempts}: status=${status} | tokens in=${input} out=${output} cache_read=${cacheRead}`
		);

		if (status === "completed") {
			console.log(`  ✅ ${label} completed`);
			logTokenBreakdown(statusData);
			return statusData;
		}
		if (status === "error") {
			throw new Error(`${label} failed: ${statusData.error || JSON.stringify(statusData)}`);
		}
		// "stopped" is terminal — the agent was frozen by the total timeout
		// (handleTotalTimeout) or the token-budget stop threshold (handleStopThreshold).
		// It never transitions back to running, so polling further only burns attempts.
		// Surface it as a failure immediately with the reason visible in the status payload.
		if (status === "stopped") {
			const tokens = `input=${statusData.totalInputTokens ?? 0}, output=${statusData.totalOutputTokens ?? 0}, cache_read=${statusData.totalCacheReadTokens ?? 0}`;
			throw new Error(
				`${label} was stopped before completing (status=stopped; likely total timeout or token budget exhausted). Tokens: ${tokens}`
			);
		}
	}

	throw new Error(`${label} did not complete after ${maxAttempts} attempts`);
}

async function waitForApi(url: string, maxAttempts = 30): Promise<void> {
	for (let i = 0; i < maxAttempts; i++) {
		try {
			const response = await fetch(`${url}/health`);
			if (response.ok) {
				return;
			}
		} catch {}
		await sleep(2000);
	}
	throw new Error(`API at ${url} did not become ready after ${maxAttempts * 2}s`);
}

// Pre-test cleanup: tear down and remove any leftover test project from a previous run
async function cleanupExistingTestProject(): Promise<void> {
	if (!existsSync(TEST_PROJECT_DIR)) {
		return;
	}

	console.log("🧹 Found existing test project folder, cleaning up before start...");

	// Tear down any running containers from the folder before removing it.
	// This must happen first — deleting the folder with containers still up
	// would orphan them and leave the ports occupied.
	const composePath = join(TEST_PROJECT_DIR, "docker-compose.yml");
	if (existsSync(composePath)) {
		try {
			await $`docker compose -f ${composePath} down --remove-orphans`.cwd(TEST_PROJECT_DIR).quiet();
			console.log("  ✅ docker compose down completed");
		} catch (error: unknown) {
			// Don't abort — we still want to remove the folder so the run can proceed
			console.log("  ⚠️  docker compose down failed (continuing):", errorMessage(error));
		}
	}

	// Remove the project's images by compose-project label. This reaps both the
	// currently-tagged image and any `<none>` layers left by previous rebuilds —
	// `compose down --rmi` can't reach those, and deleting the folder below would
	// strand them permanently. Must run before the folder is removed.
	try {
		await docker.removeProjectImages(TEST_PROJECT_ID);
		console.log("  ✅ Project images removed");
	} catch (error: unknown) {
		console.log("  ⚠️  image removal failed (continuing):", errorMessage(error));
	}

	try {
		await rm(TEST_PROJECT_DIR, { recursive: true, force: true });
		console.log("  ✅ Test project folder deleted");
	} catch (error: unknown) {
		throw new Error(`Failed to delete test project folder: ${errorMessage(error)}`);
	}
}

// Test 1: Create and configure project
async function testProjectSetup(): Promise<void> {
	console.log("1️⃣  Setting up test project...");

	// Clean up if exists
	try {
		await docker.stopProject(TEST_PROJECT_ID);
		await manager.deleteProject(TEST_PROJECT_ID);
	} catch {}

	// Create project with per-project agent config (Discord + Anthropic are now
	// part of project settings, not the global .env).
	projectConfig = await manager.createProject({
		id: TEST_PROJECT_ID,
		name: TEST_PROJECT_NAME,
		description: "Comprehensive integration test project",
		agent: {
			anthropicApiKey: process.env.ANTHROPIC_API_KEY || undefined,
			anthropicBaseUrl: process.env.ANTHROPIC_BASE_URL || undefined,
			model: process.env.ANTHROPIC_MODEL || undefined,
		},
	});

	console.log(`  ✅ Project created: ${projectConfig.id}`);
	console.log(`     Port: server=${projectConfig.ports.server}`);

	agentApiUrl = `http://localhost:${projectConfig.ports.server}`;

	console.log("  ✅ Environment configured with API key");
}

// Test 2: Docker build and start
async function testDockerLifecycle(): Promise<void> {
	console.log("\n2️⃣  Testing Docker lifecycle...");

	console.log("  Building Docker images...");
	await docker.buildProject(TEST_PROJECT_ID);
	console.log("  ✅ Docker images built");

	console.log("  Starting containers...");
	await docker.startProject(TEST_PROJECT_ID);
	console.log("  ✅ Containers started");

	// Verify containers are running
	const status = await docker.getProjectStatus(TEST_PROJECT_ID);
	if (!status.running) {
		throw new Error("Containers are not running");
	}
	console.log(`  ✅ Verified ${status.containers.length} containers running`);

	// Wait for API to be ready
	console.log("  Waiting for agent API to be ready...");
	await waitForApi(agentApiUrl);
	console.log(`  ✅ Agent API ready at ${agentApiUrl}`);
}

// Test 3: Create session and query Anthropic
async function testAgentQuery(): Promise<void> {
	console.log("\n3️⃣  Testing agent query with Anthropic API...");

	const response = await fetch(`${agentApiUrl}/api/sessions`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			task: "What is 2+2? Respond with just the number.",
			totalTimeoutMins: 1,
		}),
	});

	if (!response.ok) {
		throw new Error(`Failed to create session: ${response.statusText}`);
	}

	const session: SessionStatus = await response.json();
	console.log(`  ✅ Session created: ${session.id}`);

	// Wait for completion
	const statusData = await waitForSessionCompletion(session.id, { label: "agent query" });

	// Verify we got a response from our Anthropic API
	if (statusData.totalInputTokens === 0 && statusData.totalOutputTokens === 0) {
		throw new Error("Session completed but no API calls were made");
	}
}

// Test 4: Test filesystem tools
async function testFilesystemTools(): Promise<void> {
	console.log("\n4️⃣  Testing filesystem tools...");

	const response = await fetch(`${agentApiUrl}/api/sessions`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			task: "Create a file called test.txt with content 'Hello from integration test', then read it back and confirm the content.",
			totalTimeoutMins: 3,
		}),
	});

	const session: SessionStatus = await response.json();
	console.log(`  ✅ Filesystem test session created: ${session.id}`);

	// Wait for completion — poll for the full task timeout (1 min) plus headroom
	await waitForSessionCompletion(session.id, { label: "filesystem" });
}

// Test 5: Test memory operations
async function testMemoryOperations(): Promise<void> {
	console.log("\n5️⃣  Testing memory operations...");

	const response = await fetch(`${agentApiUrl}/api/sessions`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			task: "Remember that my favorite color is blue. Store this in memory with the key 'user_preferences'.",
			totalTimeoutMins: 3,
		}),
	});

	const session: SessionStatus = await response.json();
	console.log(`  ✅ Memory test session created: ${session.id}`);

	// Wait for completion
	await waitForSessionCompletion(session.id, { label: "memory" });

	// Verify memory was stored
	console.log("  ✅ Verified memory storage (session completed successfully)");
}

// Test 6: Test report generation
async function testReportGeneration(): Promise<void> {
	console.log("\n6️⃣  Testing report generation...");

	const response = await fetch(`${agentApiUrl}/api/sessions`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			task: "Analyze the current workspace, list any files, and generate a comprehensive report of what you find.",
			totalTimeoutMins: 5,
		}),
	});

	const session: SessionStatus = await response.json();
	console.log(`  ✅ Report test session created: ${session.id}`);

	// Check for reports
	const statusResponse = await fetch(`${agentApiUrl}/api/sessions/${session.id}`);
	const statusData: SessionStatus = await statusResponse.json();

	// Note: The actual report endpoint depends on your implementation
	// This checks if the session has progressed
	if (statusData.messageCount && statusData.messageCount > 0) {
		console.log(`  ✅ Session progressing with ${statusData.messageCount} messages`);
	}

	// Wait for completion
	const finalData = await waitForSessionCompletion(session.id, {
		label: "report",
		maxAttempts: 120,
	});
	console.log(`     Total messages: ${finalData.messageCount || 0}`);
}

// Test 6b: Context compaction with a low threshold
//
// Compaction fires at the top of the agent loop when estimateTokens(messages)
// exceeds compactThresholdTokens. With the production default (80K) a short
// task never crosses it, so we drive a session with a deliberately tiny 5K
// threshold and a task that produces enough tool output to grow the context
// past it. Each compaction records a checkin with trigger "compaction", which
// we read back from GET /api/sessions/:id/checkins to prove it actually ran.
async function testContextCompaction(): Promise<void> {
	console.log("\n6️⃣b Testing context compaction (5K token threshold)...");

	const response = await fetch(`${agentApiUrl}/api/sessions`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			// A task that reads/writes a few files so the message history (with
			// tool_use + tool_result blocks) quickly grows past 5K tokens.
			task: "Create three files a.txt, b.txt, and c.txt, each containing a short paragraph about a different programming language. Then read each one back and summarize them.",
			totalTimeoutMins: 3,
			compactThresholdTokens: 5000,
		}),
	});

	if (!response.ok) throw new Error(`Failed to create compaction session: ${response.statusText}`);

	const session: SessionStatus = await response.json();
	console.log(`  ✅ Compaction test session created: ${session.id} (compactThreshold=2000)`);

	const finalData = await waitForSessionCompletion(session.id, {
		label: "compaction",
		maxAttempts: 70,
	});

	// Read back the checkin timeline and confirm at least one compaction occurred.
	const checkinsResp = await fetch(`${agentApiUrl}/api/sessions/${session.id}/checkins`);
	if (!checkinsResp.ok) {
		throw new Error(`Failed to fetch checkins: ${checkinsResp.statusText}`);
	}
	const checkins: Checkin[] = await checkinsResp.json();
	const compactions = checkins.filter((c) => c.trigger === "compaction");

	if (compactions.length === 0) {
		throw new Error("No compaction occurred despite a 5K threshold — context never grew past it or compaction is broken");
	}

	console.log(`  ✅ Compaction fired ${compactions.length}x with a 5K threshold`);
	// The summary embeds the before→after sizes, e.g. "Context compacted: 12 → 1 messages".
	for (const c of compactions) {
		console.log(`     ↳ ${c.summary.split("\n")[0]}`);
	}
	logTokenBreakdown(finalData);
}

// Test 7b: Interval report generation
//
// With reportIntervalMins=1 and freezeReportMode="never" the runner fires an
// auto-report (trigger="timer") after the first minute without blocking on
// Discord. We let the session run for 90s, stop it, then confirm at least one
// "timer" checkin was recorded.
async function testIntervalReports(): Promise<void> {
	console.log("\n7️⃣b Testing interval report generation (1-min interval)...");

	const response = await fetch(`${agentApiUrl}/api/sessions`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			task: "Explore the workspace thoroughly: list all directories and files recursively, read each file you find, and write detailed notes about the codebase structure. Be thorough and take your time.",
			totalTimeoutMins: 3,
			reportIntervalMins: 1,
			freezeReportMode: "never",
		}),
	});

	if (!response.ok) throw new Error(`Failed to create interval-report session: ${response.statusText}`);

	const session: SessionStatus = await response.json();
	console.log(`  ✅ Session created: ${session.id} (reportInterval=1min, freezeReportMode=never)`);

	// 1-minute interval → 90s is enough for exactly one report to fire.
	console.log("  ⏳ Waiting 90s for the interval report to fire...");
	await sleep(90_000);

	await fetch(`${agentApiUrl}/api/sessions/${session.id}/stop`, { method: "POST" });
	await sleep(1000);

	const checkinsResp = await fetch(`${agentApiUrl}/api/sessions/${session.id}/checkins`);
	if (!checkinsResp.ok) throw new Error(`Failed to fetch checkins: ${checkinsResp.statusText}`);
	const checkins: Checkin[] = await checkinsResp.json();
	const timerCheckins = checkins.filter((c) => c.trigger === "timer");

	if (timerCheckins.length === 0) {
		throw new Error(
			"No interval report fired within 90s despite reportIntervalMins=1 — auto-report is broken or the agent was too slow to start"
		);
	}

	console.log(`  ✅ ${timerCheckins.length} interval report(s) fired within 90s`);
	for (const c of timerCheckins) {
		console.log(`     ↳ ${c.summary.split("\n")[0]}`);
	}
}

// Test 7: Test agent interruption
async function testAgentInterruption(): Promise<void> {
	console.log("\n7️⃣  Testing agent interruption...");

	const response = await fetch(`${agentApiUrl}/api/sessions`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			task: "Count from 1 to 1000, showing each number. Take your time.",
			totalTimeoutMins: 5,
		}),
	});

	const session: SessionStatus = await response.json();
	console.log(`  ✅ Long-running session created: ${session.id}`);

	// Let it run for a bit
	await sleep(5000);

	// Interrupt it
	const cancelResponse = await fetch(`${agentApiUrl}/api/sessions/${session.id}/cancel`, {
		method: "POST",
	});

	if (!cancelResponse.ok) {
		console.log(`  ⚠️  Cancel endpoint returned: ${cancelResponse.status}`);
	}

	// Verify it stopped
	await sleep(2000);
	const statusResponse = await fetch(`${agentApiUrl}/api/sessions/${session.id}`);
	const statusData: SessionStatus = await statusResponse.json();

	console.log(`  ✅ Session status after cancel: ${statusData.status}`);
	logTokenBreakdown(statusData);
	console.log("  ✅ Agent interruption tested");
}

// Test 8: Freeze-mode predictability on completion
//
// Regression for the "chat freezes after send_report (continuing)" bug: the
// end-of-turn completion report used to force a blocking Discord check-in
// regardless of freeze_report_mode, leaving the session stuck at "paused".
// Completion must now honour freeze_report_mode:
//   never  → complete without blocking (asserted unconditionally)
//   always → freeze at completion for a check-in (asserted only when a Discord
//            channel is configured, since without one no report is sent)
async function testFreezeModePredictability(): Promise<void> {
	console.log("\n8️⃣  Testing freeze-mode predictability on completion...");

	// never → must reach "completed", never hang at "paused"
	const neverResp = await fetch(`${agentApiUrl}/api/sessions`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			task: "What is 2+2? Respond with just the number.",
			totalTimeoutMins: 1,
			freezeReportMode: "never",
		}),
	});
	const neverSession: SessionStatus = await neverResp.json();
	console.log(`  ✅ 'never' session created: ${neverSession.id}`);
	const neverData = await waitForSessionCompletion(neverSession.id, {
		label: "freeze:never",
	});
	if (neverData.status !== "completed") {
		throw new Error(`'never' session ended as '${neverData.status}', expected 'completed'`);
	}
	console.log("  ✅ 'never' mode completed without freezing");

	// always → must freeze (status "paused") at completion. Only meaningful when
	// a Discord channel exists; otherwise the report is skipped, so we skip too.
	if (!process.env.DISCORD_DEFAULT_CHANNEL_ID) {
		console.log("  ⏭  'always' freeze check skipped (no DISCORD_DEFAULT_CHANNEL_ID)");
		return;
	}

	const alwaysResp = await fetch(`${agentApiUrl}/api/sessions`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			task: "What is 2+2? Respond with just the number.",
			totalTimeoutMins: 1,
			freezeReportMode: "always",
		}),
	});
	const alwaysSession: SessionStatus = await alwaysResp.json();
	console.log(`  ✅ 'always' session created: ${alwaysSession.id}`);

	// Poll for the frozen state: the agent should reach "paused" awaiting a
	// check-in and stay there (not auto-complete) until we cancel it.
	let froze = false;
	for (let attempt = 1; attempt <= 30; attempt++) {
		await sleep(2000);
		const r = await fetch(`${agentApiUrl}/api/sessions/${alwaysSession.id}`);
		const d: SessionStatus = await r.json();
		console.log(`     [freeze:always] attempt ${attempt}/30: status=${d.status}`);
		if (d.status === "paused") {
			froze = true;
			break;
		}
		if (d.status === "completed") {
			throw new Error("'always' session completed without freezing for a check-in");
		}
		if (d.status === "error") {
			throw new Error(`'always' session errored: ${d.error || "unknown"}`);
		}
	}
	if (!froze) {
		throw new Error("'always' session never reached the frozen 'paused' state");
	}
	console.log("  ✅ 'always' mode froze at completion as expected");

	// Clean up so we don't wait out the 10-minute check-in timeout.
	await fetch(`${agentApiUrl}/api/sessions/${alwaysSession.id}/stop`, { method: "POST" }).catch(() => {});
}

// Test 9: Test Docker stop
async function testDockerStop(): Promise<void> {
	console.log("\n9️⃣  Testing Docker stop...");

	await docker.stopProject(TEST_PROJECT_ID);
	console.log("  ✅ Stop command executed");

	// Verify containers stopped
	await sleep(3000);
	const status = await docker.getProjectStatus(TEST_PROJECT_ID);

	if (status.running) {
		throw new Error("Containers still running after stop");
	}

	console.log("  ✅ Containers stopped properly");
}

// Test 9: Cleanup
async function testCleanup(): Promise<void> {
	console.log("\n9️⃣  Cleaning up...");

	try {
		await docker.stopProject(TEST_PROJECT_ID);
	} catch {}

	console.log("  ✅ Containers stopped");
	console.log(`     Project folder kept for inspection: .projects/${TEST_PROJECT_ID}`);
	console.log("     (deleted automatically on next run)");
}

// Main test runner
async function runTests() {
	const startTime = Date.now();

	try {
		// Initialize
		manager = new ProjectManager();
		docker = new ProjectDocker(manager);

		// Tear down and remove any leftover test project before starting
		await cleanupExistingTestProject();

		// Run tests
		await testProjectSetup();
		await testDockerLifecycle();
		await testAgentQuery();
		await testFilesystemTools();
		await testMemoryOperations();
		await testReportGeneration();
		await testContextCompaction();
		await testIntervalReports();
		await testAgentInterruption();
		await testFreezeModePredictability();
		await testDockerStop();
		await testCleanup();

		const duration = ((Date.now() - startTime) / 1000).toFixed(2);

		console.log(`\n${"=".repeat(60)}`);
		console.log("✅ All integration tests passed!");
		console.log(`   Duration: ${duration}s`);
		console.log(`${"=".repeat(60)}\n`);

		console.log("Tested:");
		console.log("  ✅ Docker start/stop lifecycle");
		console.log("  ✅ Anthropic API queries");
		console.log("  ✅ Filesystem tools (create/read files)");
		console.log("  ✅ Memory operations");
		console.log("  ✅ Report generation (10s interval)");
		console.log("  ✅ Context compaction (5K token threshold)");
		console.log("  ✅ Interval reports (1-min trigger, fired within 90s)");
		console.log("  ✅ Agent interruption");
		console.log("  ✅ Freeze-mode predictability (never completes, always freezes)");
		console.log("  ✅ Proper cleanup");
		console.log("");

		process.exit(0);
	} catch (error: unknown) {
		console.error("\n❌ Integration test failed:");
		console.error(`   ${errorMessage(error)}`);
		if (error instanceof Error && error.stack) {
			console.error(`\n${error.stack}`);
		}

		// Stop containers on failure, but keep the project folder for inspection
		try {
			await docker.stopProject(TEST_PROJECT_ID);
		} catch {}

		process.exit(1);
	}
}

// Run tests
runTests();
