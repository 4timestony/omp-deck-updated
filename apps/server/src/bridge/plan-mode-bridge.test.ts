/**
 * PlanModeBridge tests — ported to the SDK 17 `xd://propose` architecture.
 *
 * Exercises the per-session plan-mode state machine end-to-end without
 * spinning up a real `AgentSession`. The session-facing surface is small
 * enough that a hand-rolled stub captures it cleanly; the real SDK
 * `writeDeviceDispatch`/`PROPOSE_DEVICE_NAME` parse every propose dispatch
 * built here, so a future wire-shape drift in the SDK fails these tests
 * instead of silently passing. No `session.subscribe` wiring is needed —
 * tests drive `bridge.onToolExecutionEnd` directly, mirroring how
 * `InProcessAgentBridge.attach` calls it from the real event stream.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import type { AgentToolResult } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import type { PlanApprovalDetails } from "@oh-my-pi/pi-coding-agent/plan-mode/approved-plan";
import { PROPOSE_DEVICE_NAME } from "@oh-my-pi/pi-coding-agent/tools/resolve";
import type { ServerFrame } from "@omp-deck/protocol";

import {
	PlanModeBridge,
	type PlanModeFrame,
	type PlanModeSessionSurface,
	type PlanToolExecutionEndEvent,
} from "./plan-mode-bridge.ts";

type PromptCall = {
	text: string;
	options?: { synthetic?: boolean; streamingBehavior?: "steer" | "followUp" };
};

class StubSession implements PlanModeSessionSurface {
	private activeTools: string[];
	planModeStateCalls: Array<
		{ enabled: boolean; planFilePath: string; workflow: "parallel" | "iterative" } | undefined
	> = [];
	planProposalHandlerCalls: Array<((title: string) => Promise<AgentToolResult<unknown>>) | null> = [];
	setPlanReferencePathCalls: string[] = [];
	markPlanReferenceSentCount = 0;
	markPlanInternalAbortPendingCount = 0;
	clearPlanInternalAbortPendingCount = 0;
	abortCount = 0;
	abortShouldThrow = false;
	promptCalls: PromptCall[] = [];
	setActiveToolsCalls: string[][] = [];
	isStreaming = false;

	constructor(initialTools: string[] = ["search", "find", "lsp", "web_search", "edit"]) {
		this.activeTools = [...initialTools];
	}

	getActiveToolNames(): string[] {
		return [...this.activeTools];
	}

	async setActiveToolsByName(toolNames: string[]): Promise<void> {
		this.activeTools = [...toolNames];
		this.setActiveToolsCalls.push([...toolNames]);
	}

	setPlanModeState(
		state: { enabled: boolean; planFilePath: string; workflow: "parallel" | "iterative" } | undefined,
	): void {
		this.planModeStateCalls.push(state);
	}

	setPlanProposalHandler(handler: ((title: string) => Promise<AgentToolResult<unknown>>) | null): void {
		this.planProposalHandlerCalls.push(handler);
	}

	async preparePlanForReview(title: string): Promise<AgentToolResult<PlanApprovalDetails>> {
		// Not exercised directly — tests drive `onToolExecutionEnd` with
		// hand-built propose dispatches instead of routing through the
		// installed handler. Present only to satisfy the interface.
		return {
			content: [{ type: "text", text: "Plan ready for review." }],
			details: { planFilePath: "local://PLAN.md", title, planExists: true },
		};
	}

	setPlanReferencePath(planPath: string): void {
		this.setPlanReferencePathCalls.push(planPath);
	}

	markPlanReferenceSent(): void {
		this.markPlanReferenceSentCount += 1;
	}

	markPlanInternalAbortPending(): void {
		this.markPlanInternalAbortPendingCount += 1;
	}

	clearPlanInternalAbortPending(): void {
		this.clearPlanInternalAbortPendingCount += 1;
	}

	async abort(): Promise<void> {
		this.abortCount += 1;
		if (this.abortShouldThrow) throw new Error("abort failed");
	}

	async prompt(
		text: string,
		options?: { synthetic?: boolean; streamingBehavior?: "steer" | "followUp" },
	): Promise<unknown> {
		this.promptCalls.push({ text, ...(options ? { options } : {}) });
		return true;
	}
}

function collect(bridge: PlanModeBridge): { frames: PlanModeFrame[]; unsub: () => void } {
	const frames: PlanModeFrame[] = [];
	const unsub = bridge.subscribeFrames((frame) => {
		frames.push(frame);
	});
	return { frames, unsub };
}

/** Builds a `tool_execution_end` event shaped so the REAL SDK
 *  `writeDeviceDispatch` parses it — catches future wire drift instead of
 *  testing against our own assumptions about the shape. */
function proposeEvent(
	inner: unknown,
	overrides: { toolName?: string; tool?: string; mode?: "help" | "execute"; isError?: boolean } = {},
): PlanToolExecutionEndEvent {
	return {
		toolName: overrides.toolName ?? "write",
		isError: overrides.isError,
		result: {
			content: [{ type: "text", text: "Plan ready for review." }],
			details: {
				xdev: {
					tool: overrides.tool ?? PROPOSE_DEVICE_NAME,
					mode: overrides.mode ?? "execute",
					args: { title: "plan" },
					inner,
				},
			},
		},
	};
}

/** Polls until `predicate` is true or the deadline passes. Real timers (not
 *  setImmediate/microtasks) — bun's test loop can starve fs.promises-driven
 *  continuations under microtask-only yields. */
async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate() && Date.now() < deadline) {
		await new Promise<void>((r) => setTimeout(r, 1));
	}
}

interface Harness {
	dir: string;
	planFile: string;
	planFileUrl: string;
	session: StubSession;
	bridge: PlanModeBridge;
	frames: PlanModeFrame[];
	openFrames: ServerFrame[]; // for assertions on the wire-level types
	cleanup: () => Promise<void>;
}

async function makeHarness(initialTools?: string[]): Promise<Harness> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "plan-mode-bridge-test-"));
	// The SDK's `local://` resolver scopes paths to `<artifactsDir>/local/`.
	const localDir = path.join(dir, "local");
	await fs.mkdir(localDir, { recursive: true });
	const session = new StubSession(initialTools);
	const bridge = new PlanModeBridge({
		sessionId: "s_test",
		session,
		getArtifactsDir: () => dir,
		getSessionId: () => "s_test",
	});
	const { frames } = collect(bridge);
	return {
		dir,
		planFile: path.join(localDir, "PLAN.md"),
		planFileUrl: "local://PLAN.md",
		session,
		bridge,
		frames,
		openFrames: frames as unknown as ServerFrame[],
		async cleanup() {
			await bridge.exit("session_disposed");
			bridge.dispose();
			await fs.rm(dir, { recursive: true, force: true });
		},
	};
}

/** Enters plan mode, writes the plan file, dispatches a valid propose event,
 *  and waits for the resulting `plan_proposed` frame. Returns it. */
async function proposePlan(
	h: Harness,
	opts: { title?: string; planContent?: string } = {},
): Promise<Extract<PlanModeFrame, { type: "plan_proposed" }>> {
	await h.bridge.enter();
	await fs.writeFile(h.planFile, opts.planContent ?? "# Yo\n\nDo a thing.\n");
	const result = h.bridge.onToolExecutionEnd(
		proposeEvent({ planFilePath: h.planFileUrl, title: opts.title ?? "plan", planExists: true }),
	);
	expect(result).toBeUndefined();
	await waitFor(() => h.bridge.hasPendingApproval());
	const proposed = h.frames.find(
		(f): f is Extract<PlanModeFrame, { type: "plan_proposed" }> => f.type === "plan_proposed",
	);
	if (!proposed) throw new Error("propose dispatch never produced a plan_proposed frame");
	return proposed;
}

describe("PlanModeBridge", () => {
	let harness: Harness;

	beforeEach(async () => {
		harness = await makeHarness();
	});

	afterEach(async () => {
		await harness.cleanup();
	});

	// ─── enter/exit lifecycle ─────────────────────────────────────────────

	it("enter() snapshots tools, splices in write, and broadcasts plan_mode_changed", async () => {
		const previousTools = harness.session.getActiveToolNames();
		expect(previousTools.includes("write")).toBe(false);

		await harness.bridge.enter();

		expect(harness.session.getActiveToolNames()).toEqual([...previousTools, "write"]);
		expect(harness.session.planModeStateCalls).toEqual([
			{ enabled: true, planFilePath: "local://PLAN.md", workflow: "parallel" },
		]);
		expect(harness.session.planProposalHandlerCalls.length).toBe(1);
		expect(harness.session.planProposalHandlerCalls[0]).toBeTypeOf("function");
		expect(harness.frames).toEqual([
			{
				type: "plan_mode_changed",
				sessionId: "s_test",
				enabled: true,
				planFilePath: "local://PLAN.md",
			},
		]);
		expect(harness.bridge.isEnabled()).toBe(true);
		expect(harness.bridge.getPlanModeContext()).toEqual({
			enabled: true,
			planFilePath: "local://PLAN.md",
		});
	});

	it("enter() is idempotent — second call is a no-op", async () => {
		await harness.bridge.enter();
		const framesAfterFirst = harness.frames.length;
		const stateCallsAfterFirst = harness.session.planModeStateCalls.length;

		await harness.bridge.enter();

		expect(harness.frames.length).toBe(framesAfterFirst);
		expect(harness.session.planModeStateCalls.length).toBe(stateCallsAfterFirst);
	});

	it("does not duplicate write when it is already in the active tool set", async () => {
		const session = new StubSession(["read", "write"]);
		const bridge = new PlanModeBridge({
			sessionId: "s_with_write",
			session,
			getArtifactsDir: () => harness.dir,
			getSessionId: () => "s_with_write",
		});
		await bridge.enter();
		expect(session.getActiveToolNames()).toEqual(["read", "write"]);
		bridge.dispose();
	});

	it("exit() restores tools, clears the plan-proposal handler, broadcasts off, and is idempotent", async () => {
		await harness.bridge.enter();
		const previousTools = harness.session.getActiveToolNames().filter((t) => t !== "write");
		await harness.bridge.exit("user_cancelled");

		expect(harness.session.getActiveToolNames()).toEqual(previousTools);
		expect(harness.session.planProposalHandlerCalls.at(-1)).toBeNull();
		expect(harness.session.planModeStateCalls.at(-1)).toBeUndefined();
		expect(harness.frames.at(-1)).toEqual({
			type: "plan_mode_changed",
			sessionId: "s_test",
			enabled: false,
		});
		expect(harness.bridge.isEnabled()).toBe(false);

		// Second exit is a no-op.
		const framesAfter = harness.frames.length;
		await harness.bridge.exit("user_cancelled");
		expect(harness.frames.length).toBe(framesAfter);
	});

	// ─── onToolExecutionEnd gating ────────────────────────────────────────

	it("onToolExecutionEnd returns undefined synchronously — proxy for the no-await constraint", async () => {
		await harness.bridge.enter();
		await fs.writeFile(harness.planFile, "# Title\n");
		const result = harness.bridge.onToolExecutionEnd(
			proposeEvent({ planFilePath: harness.planFileUrl, title: "Title", planExists: true }),
		);
		expect(result).toBeUndefined();
		// Drain the detached dispatch so it doesn't leak into the next test.
		await waitFor(() => harness.bridge.hasPendingApproval());
	});

	it("ignores a dispatch on a tool other than write (gate on the write tool)", async () => {
		await harness.bridge.enter();
		await fs.writeFile(harness.planFile, "# Title\n");
		harness.bridge.onToolExecutionEnd(
			proposeEvent(
				{ planFilePath: harness.planFileUrl, title: "Title", planExists: true },
				{ toolName: "task" },
			),
		);
		await new Promise<void>((r) => setTimeout(r, 20));
		expect(harness.bridge.hasPendingApproval()).toBe(false);
		expect(harness.session.abortCount).toBe(0);
	});

	it("ignores a non-propose device dispatch (e.g. resolve)", async () => {
		await harness.bridge.enter();
		await fs.writeFile(harness.planFile, "# Title\n");
		harness.bridge.onToolExecutionEnd(
			proposeEvent(
				{ action: "apply", reason: "done" },
				{ tool: "resolve" },
			),
		);
		await new Promise<void>((r) => setTimeout(r, 20));
		expect(harness.bridge.hasPendingApproval()).toBe(false);
		expect(harness.session.abortCount).toBe(0);
	});

	it("ignores a propose dispatch in help mode", async () => {
		await harness.bridge.enter();
		await fs.writeFile(harness.planFile, "# Title\n");
		harness.bridge.onToolExecutionEnd(
			proposeEvent(
				{ planFilePath: harness.planFileUrl, title: "Title", planExists: true },
				{ mode: "help" },
			),
		);
		await new Promise<void>((r) => setTimeout(r, 20));
		expect(harness.bridge.hasPendingApproval()).toBe(false);
		expect(harness.session.abortCount).toBe(0);
	});

	it("rejects a propose dispatch with a malformed inner payload", async () => {
		await harness.bridge.enter();
		await fs.writeFile(harness.planFile, "# Title\n");
		// planExists is a string, not boolean — fails the duck-type guard.
		harness.bridge.onToolExecutionEnd(
			proposeEvent({ planFilePath: harness.planFileUrl, title: "Title", planExists: "yes" }),
		);
		await new Promise<void>((r) => setTimeout(r, 20));
		expect(harness.bridge.hasPendingApproval()).toBe(false);
		expect(harness.session.abortCount).toBe(0);
	});

	it("ignores a propose dispatch once plan mode has been exited", async () => {
		await harness.bridge.enter();
		await harness.bridge.exit("user_cancelled");
		const result = harness.bridge.onToolExecutionEnd(
			proposeEvent({ planFilePath: harness.planFileUrl, title: "Title", planExists: true }),
		);
		expect(result).toBeUndefined();
		await new Promise<void>((r) => setTimeout(r, 20));
		expect(harness.bridge.hasPendingApproval()).toBe(false);
		expect(harness.session.abortCount).toBe(0);
	});

	it("ignores a second propose dispatch while one is already pending", async () => {
		const proposed = await proposePlan(harness, { title: "first" });
		const abortCountAfterFirst = harness.session.abortCount;
		harness.bridge.onToolExecutionEnd(
			proposeEvent({ planFilePath: harness.planFileUrl, title: "second", planExists: true }),
		);
		await new Promise<void>((r) => setTimeout(r, 20));
		expect(harness.session.abortCount).toBe(abortCountAfterFirst);
		expect(harness.bridge.getPendingPlanApproval()?.proposalId).toBe(proposed.proposalId);
	});

	// ─── silent-abort marker pairing (constraint 2) ────────────────────────

	it("marks and clears the internal-abort flag around the silent abort", async () => {
		await proposePlan(harness);
		expect(harness.session.markPlanInternalAbortPendingCount).toBe(1);
		expect(harness.session.clearPlanInternalAbortPendingCount).toBe(1);
		expect(harness.session.abortCount).toBe(1);
	});

	it("clears the internal-abort flag even when abort() throws (finally proof)", async () => {
		harness.session.abortShouldThrow = true;
		await harness.bridge.enter();
		await fs.writeFile(harness.planFile, "# Title\n");
		harness.bridge.onToolExecutionEnd(
			proposeEvent({ planFilePath: harness.planFileUrl, title: "Title", planExists: true }),
		);
		await waitFor(() => harness.session.clearPlanInternalAbortPendingCount > 0);

		expect(harness.session.markPlanInternalAbortPendingCount).toBe(1);
		expect(harness.session.clearPlanInternalAbortPendingCount).toBe(1);
		expect(harness.bridge.hasPendingApproval()).toBe(false);
		expect(harness.bridge.isEnabled()).toBe(true);
	});

	it("a missing plan file logs and leaves plan mode on (no card, no crash)", async () => {
		await harness.bridge.enter();
		// No plan file written.
		harness.bridge.onToolExecutionEnd(
			proposeEvent({ planFilePath: harness.planFileUrl, title: "Title", planExists: true }),
		);
		await waitFor(() => harness.session.clearPlanInternalAbortPendingCount > 0);
		await new Promise<void>((r) => setTimeout(r, 20));

		expect(harness.bridge.hasPendingApproval()).toBe(false);
		expect(harness.bridge.isEnabled()).toBe(true);
		expect(harness.frames.some((f) => f.type === "plan_proposed")).toBe(false);
	});

	// ─── handler-capture fallback (eval / Python bridge route) ─────────────
	//
	// The SDK's own `write`-path signal (`writeDeviceDispatch` echoing the
	// envelope onto the tool result) never fires for a propose routed through
	// the eval tool: the enclosing `tool_execution_end` is `toolName ===
	// "eval"` and its result carries `EvalToolDetails`, not the envelope.
	// These tests drive the real fallback — invoke the `setPlanProposalHandler`
	// callback the bridge installed in `enter()` directly (mirroring what
	// `dispatchResolutionDevice` does for both `write` and `eval` routes), then
	// end an `eval` tool with no xdev envelope anywhere on its result.

	/** Fires the plan-proposal handler `enter()` installed on the stub
	 *  session, as `dispatchResolutionDevice` would for either transport. */
	async function fireHandlerCapture(h: Harness, title = "plan"): Promise<void> {
		const handler = h.session.planProposalHandlerCalls.at(-1);
		if (!handler) throw new Error("enter() did not install a plan-proposal handler");
		await handler(title);
	}

	/** An `eval` tool's `tool_execution_end` result shape — no xdev envelope
	 *  anywhere, per `EvalToolDetails` (language/cells/…). */
	function evalToolEndEvent(overrides: { isError?: boolean } = {}): PlanToolExecutionEndEvent {
		return {
			toolName: "eval",
			isError: overrides.isError,
			result: {
				content: [{ type: "text", text: "cell output" }],
				details: { language: "py", cells: [] },
			},
		};
	}

	it("accepts a propose dispatch routed through the eval tool via the handler capture (Python eval bridge path)", async () => {
		await harness.bridge.enter();
		await fs.writeFile(harness.planFile, "# Yo\n\nDo a thing.\n");
		await fireHandlerCapture(harness);

		const result = harness.bridge.onToolExecutionEnd(evalToolEndEvent());
		expect(result).toBeUndefined();
		await waitFor(() => harness.bridge.hasPendingApproval());

		expect(harness.session.markPlanInternalAbortPendingCount).toBe(1);
		expect(harness.session.clearPlanInternalAbortPendingCount).toBe(1);
		expect(harness.session.abortCount).toBe(1);

		const proposed = harness.frames.find(
			(f): f is Extract<PlanModeFrame, { type: "plan_proposed" }> => f.type === "plan_proposed",
		);
		expect(proposed?.planFilePath).toBe("local://PLAN.md");
		expect(proposed?.planContent).toMatch(/Do a thing/);
		expect(harness.bridge.getPendingPlanApproval()?.proposalId).toBe(proposed?.proposalId);
	});

	it("ignores an xdev envelope carried on a non-allowlisted tool (e.g. bash) absent a prior handler capture", async () => {
		await harness.bridge.enter();
		await fs.writeFile(harness.planFile, "# Yo\n\nDo a thing.\n");
		harness.bridge.onToolExecutionEnd(
			proposeEvent(
				{ planFilePath: harness.planFileUrl, title: "plan", planExists: true },
				{ toolName: "bash" },
			),
		);
		await new Promise<void>((r) => setTimeout(r, 20));
		expect(harness.bridge.hasPendingApproval()).toBe(false);
		expect(harness.session.abortCount).toBe(0);
		expect(harness.frames.some((f) => f.type === "plan_proposed")).toBe(false);
	});

	it("clears a handler capture when the enclosing tool ends in error, and does not resurrect it on a later tool end", async () => {
		await harness.bridge.enter();
		await fs.writeFile(harness.planFile, "# Yo\n\nDo a thing.\n");
		await fireHandlerCapture(harness);

		harness.bridge.onToolExecutionEnd(evalToolEndEvent({ isError: true }));
		await new Promise<void>((r) => setTimeout(r, 20));
		expect(harness.bridge.hasPendingApproval()).toBe(false);
		expect(harness.session.abortCount).toBe(0);

		// A later, unrelated tool end must not resurrect the cleared capture.
		harness.bridge.onToolExecutionEnd({ toolName: "bash", result: { content: [], details: {} } });
		await new Promise<void>((r) => setTimeout(r, 20));
		expect(harness.bridge.hasPendingApproval()).toBe(false);
		expect(harness.session.abortCount).toBe(0);
	});

	it("two handler captures before the next tool boundary still yield exactly one card", async () => {
		await harness.bridge.enter();
		await fs.writeFile(harness.planFile, "# Yo\n\nDo a thing.\n");
		await fireHandlerCapture(harness, "first");
		await fireHandlerCapture(harness, "second");

		harness.bridge.onToolExecutionEnd(evalToolEndEvent());
		await waitFor(() => harness.bridge.hasPendingApproval());
		await new Promise<void>((r) => setTimeout(r, 20));

		const proposedFrames = harness.frames.filter((f) => f.type === "plan_proposed");
		expect(proposedFrames.length).toBe(1);
		expect(harness.session.abortCount).toBe(1);
	});

	it("exit() clears a handler capture so a later tool end doesn't surface it", async () => {
		await harness.bridge.enter();
		await fs.writeFile(harness.planFile, "# Yo\n\nDo a thing.\n");
		await fireHandlerCapture(harness);

		await harness.bridge.exit("user_cancelled");
		// Re-enter so the assertion below exercises the cleared capture, not
		// the (also-correct-but-different) `!this.enabled` guard.
		await harness.bridge.enter();

		harness.bridge.onToolExecutionEnd(evalToolEndEvent());
		await new Promise<void>((r) => setTimeout(r, 20));
		expect(harness.bridge.hasPendingApproval()).toBe(false);
		expect(harness.session.abortCount).toBe(0);
	});

	// ─── propose → card → approve/reject ───────────────────────────────────

	it("propose broadcasts plan_proposed and exposes it for snapshot replay", async () => {
		const initialFrameCount = harness.frames.length;
		const proposed = await proposePlan(harness, { title: "My feature", planContent: "# My feature\n\nDo a thing.\n" });

		expect(proposed.suggestedTitle).toBe("My-feature");
		expect(proposed.planFilePath).toBe("local://PLAN.md");
		expect(proposed.planContent).toMatch(/Do a thing/);
		expect(harness.frames.length).toBeGreaterThan(initialFrameCount);

		const pending = harness.bridge.getPendingPlanApproval();
		expect(pending?.proposalId).toBe(proposed.proposalId);
		expect((pending as { suggestedFinalPath?: unknown } | undefined)?.suggestedFinalPath).toBeUndefined();

		const replay = harness.bridge.getReplayFrames();
		expect(replay.map((f) => f.type as string).sort()).toEqual(["plan_mode_changed", "plan_proposed"].sort());
	});

	it("approve happy path: restores tools with read forced in, dispatches a visible followUp prompt", async () => {
		const proposed = await proposePlan(harness, { title: "My feature", planContent: "# My feature\n\nDo a thing.\n" });

		const outcome = await harness.bridge.respond(proposed.proposalId, { approved: true });
		expect(outcome).toBe("settled");

		// Tools restored to the pre-plan set, `write` dropped, `read` forced in.
		const lastSet = harness.session.setActiveToolsCalls.at(-1);
		expect(lastSet?.includes("write")).toBe(false);
		expect(lastSet?.includes("read")).toBe(true);
		expect(lastSet).toEqual(["search", "find", "lsp", "web_search", "edit", "read"]);

		// Plan-proposal handler cleared, plan mode exited.
		expect(harness.session.planProposalHandlerCalls.at(-1)).toBeNull();
		expect(harness.bridge.isEnabled()).toBe(false);
		expect(harness.bridge.hasPendingApproval()).toBe(false);

		// Plan reference wiring for subagent handoff.
		expect(harness.session.setPlanReferencePathCalls).toEqual(["local://PLAN.md"]);
		expect(harness.session.markPlanReferenceSentCount).toBe(1);

		// Execution prompt dispatched as a visible (non-synthetic) followUp —
		// the deck's deliberate deviation from the TUI's hidden dispatch.
		expect(harness.session.promptCalls.length).toBe(1);
		const queued = harness.session.promptCalls[0]!;
		expect(queued.text).toMatch(/Plan approved\. You MUST execute it now\./);
		expect(queued.text).toMatch(/Do a thing/);
		expect(queued.text).toMatch(/local:\/\/PLAN\.md/);
		expect(queued.options?.streamingBehavior).toBe("followUp");
		expect(queued.options?.synthetic).toBeUndefined();

		const resolvedFrame = harness.frames.find(
			(f): f is Extract<PlanModeFrame, { type: "plan_proposal_resolved" }> => f.type === "plan_proposal_resolved",
		);
		expect(resolvedFrame?.outcome).toBe("approved");
	});

	it("approve with edited content writes it back to the SAME path (no rename)", async () => {
		const proposed = await proposePlan(harness, { planContent: "# Orig\n" });

		await harness.bridge.respond(proposed.proposalId, {
			approved: true,
			editedContent: "# Replaced\n\nNew body.\n",
		});

		const written = await fs.readFile(harness.planFile, "utf-8");
		expect(written).toBe("# Replaced\n\nNew body.\n");
		expect(harness.session.promptCalls[0]!.text).toMatch(/New body\./);
	});

	it("reject path exits plan mode, broadcasts rejected, and touches nothing on disk", async () => {
		const proposed = await proposePlan(harness, { planContent: "# Foo\n" });

		const outcome = await harness.bridge.respond(proposed.proposalId, { approved: false });
		expect(outcome).toBe("settled");

		expect(harness.bridge.isEnabled()).toBe(false);
		expect(harness.session.promptCalls.length).toBe(0);
		expect(harness.session.markPlanReferenceSentCount).toBe(0);
		const resolvedFrame = harness.frames.find(
			(f): f is Extract<PlanModeFrame, { type: "plan_proposal_resolved" }> => f.type === "plan_proposal_resolved",
		);
		expect(resolvedFrame?.outcome).toBe("rejected");
		// No forced-read on reject — restored to the plain pre-plan set.
		const lastSet = harness.session.setActiveToolsCalls.at(-1);
		expect(lastSet).toEqual(["search", "find", "lsp", "web_search", "edit"]);
		// Plan file untouched (no rename, no rewrite on reject) — readFile
		// itself throws if the rename ever comes back, so this is proof enough.
		const content = await fs.readFile(harness.planFile, "utf-8");
		expect(content).toBe("# Foo\n");
	});

	it("respond() returns 'unknown' for stale / mismatched proposalIds (double-click safety)", async () => {
		const proposed = await proposePlan(harness, { planContent: "# Hi\n" });

		expect(await harness.bridge.respond("pa_bogus_99", { approved: true })).toBe("unknown");
		expect(await harness.bridge.respond(proposed.proposalId, { approved: true })).toBe("settled");
		// Second click on the same (now-resolved) id is unknown.
		expect(await harness.bridge.respond(proposed.proposalId, { approved: true })).toBe("unknown");
	});

	it("exit() mid-approval broadcasts a rejected resolution (no promise to reject anymore)", async () => {
		await proposePlan(harness, { planContent: "# Hi\n" });
		expect(harness.bridge.hasPendingApproval()).toBe(true);

		await harness.bridge.exit("user_cancelled");

		expect(harness.bridge.hasPendingApproval()).toBe(false);
		expect(harness.bridge.isEnabled()).toBe(false);
		const resolvedFrame = harness.frames.find(
			(f): f is Extract<PlanModeFrame, { type: "plan_proposal_resolved" }> => f.type === "plan_proposal_resolved",
		);
		expect(resolvedFrame?.outcome).toBe("rejected");
	});

	it("dispose() while approval is pending broadcasts an expired resolution and clears state", async () => {
		await proposePlan(harness, { planContent: "# Hi\n" });

		harness.bridge.dispose();
		// The pendingApproval branch inside exit() runs synchronously (before
		// exit()'s first await), so it lands before dispose() clears listeners.
		expect(harness.bridge.hasPendingApproval()).toBe(false);
		const resolvedFrame = harness.frames.find(
			(f): f is Extract<PlanModeFrame, { type: "plan_proposal_resolved" }> => f.type === "plan_proposal_resolved",
		);
		expect(resolvedFrame?.outcome).toBe("expired");
	});

	it("snapshot replay frames cover both mode-changed and pending proposal", async () => {
		await harness.bridge.enter();
		await fs.writeFile(harness.planFile, "# Yo\n");

		// Before any proposal: only the mode-changed replay.
		expect(harness.bridge.getReplayFrames().map((f) => f.type)).toEqual(["plan_mode_changed"]);

		harness.bridge.onToolExecutionEnd(
			proposeEvent({ planFilePath: harness.planFileUrl, title: "Title", planExists: true }),
		);
		await waitFor(() => harness.bridge.hasPendingApproval());

		const replay = harness.bridge.getReplayFrames();
		expect(replay.map((f) => f.type as string).sort()).toEqual(["plan_mode_changed", "plan_proposed"].sort());
	});
});
