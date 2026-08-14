/**
 * Per-session bridge for omp plan mode.
 *
 * Mirrors the TUI's `InteractiveMode` plan-approval lifecycle on top of the
 * deck's WebSocket protocol, ported to SDK 17's inverted control flow (the
 * old blocking `setStandingResolveHandler` API is gone):
 *
 *   1. Client sends `set_plan_mode {enabled:true}` → `enter()`:
 *      - snapshot active tools, splice in `write` if missing (proposals ride
 *        a `write` to `xd://propose`)
 *      - `setActiveToolsByName(planTools)`
 *      - `setPlanModeState({ enabled, planFilePath, workflow })`
 *      - `setPlanProposalHandler(title => session.preparePlanForReview(title))`
 *      - broadcast `plan_mode_changed{enabled:true}`
 *
 *   2. Agent works under plan-mode restrictions (the SDK's system prompt +
 *      tool-decision intercept enforce read-only), writes
 *      `local://<slug>-plan.md`, then writes its title to `xd://propose`.
 *      `preparePlanForReview` returns immediately with `PlanApprovalDetails`
 *      — it does NOT block on the user's decision the way the 15.x standing
 *      handler did.
 *
 *   3. `onToolExecutionEnd` (wired to the session's `tool_execution_end`
 *      event by `InProcessAgentBridge.attach`) detects the propose dispatch
 *      via `deviceDispatchFromResult` — the SDK's own `writeDeviceDispatch`
 *      for `toolName === "write"`, plus a hand-parsed fallback for
 *      `toolName === "eval"` (a live session proved the model can route
 *      `xd://propose` through the Python eval bridge instead of a direct
 *      `write`, and the eval tool echoes the same dispatch envelope on its
 *      result) — and hands off to `#onProposeDispatch`, which:
 *      - silently aborts the in-flight turn (`markPlanInternalAbortPending`/
 *        `clearPlanInternalAbortPending` around `session.abort()`) so the
 *        model doesn't re-propose in a loop while the card is up
 *      - reads the plan file, derives a title via `resolvePlanTitle`
 *        (handles issue #1179's empty-`title` corner case)
 *      - broadcasts `plan_proposed` to the deck UI and waits — NOT by
 *        blocking a call chain, just by holding `pendingApproval` until the
 *        deck UI replies with `plan_response` → `respond(proposalId, ...)`
 *
 *   4. On approve: write edited content (if any) back to the SAME
 *      `local://` path — SDK 17 never renames an approved plan, so the
 *      artifact link stays valid — exit plan mode (restoring the previous
 *      tool set, force-including `read`), mark the plan reference sent, and
 *      dispatch the SDK's `plan-mode-approved` prompt as a visible followUp
 *      turn (deliberately not `synthetic` — the deck wants the handoff
 *      user-visible, unlike the TUI's hidden dispatch).
 *
 *   5. On reject: exit plan mode and broadcast a clear rejection outcome.
 *
 *   6. On cancel (user toggles plan mode off mid-approval) or session
 *      dispose: drain `pendingApproval` with a `plan_proposal_resolved`
 *      broadcast (`rejected`/`expired`) — there is no pending promise to
 *      reject anymore, since nothing blocks on the approval in SDK 17.
 *
 * Two hard constraints carried over from the SDK's own event-controller
 * (violating either breaks subtly — see SDK issue #7684):
 *   - `onToolExecutionEnd` MUST stay synchronous and MUST NOT be awaited by
 *     its caller. `AgentSession` fans out `session.subscribe` listeners
 *     synchronously; awaiting approval work inside that dispatch would hold
 *     up every other event on the same chain until execution finishes,
 *     leaving the chat blank for the whole turn.
 *   - the in-flight turn MUST be silently aborted (mark/clear pairing)
 *     before the card is surfaced, or the model re-submits the same
 *     proposal in a loop.
 *
 * SDK reference impl: `@oh-my-pi/pi-coding-agent/src/modes/interactive-mode.ts`
 * (`#enterPlanMode`, `handlePlanApproval`, `#exitPlanMode`, `#approvePlan`,
 * `#abortPlanApprovalTurnSilently`) and
 * `src/modes/controllers/event-controller.ts` (`#handleToolExecutionEnd`'s
 * propose-dispatch detection).
 */
import * as fs from "node:fs/promises";

import type { AgentSession } from "@oh-my-pi/pi-coding-agent";
import type { AgentToolResult } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import { resolveLocalUrlToPath } from "@oh-my-pi/pi-coding-agent/internal-urls";
import { type PlanApprovalDetails, resolvePlanTitle } from "@oh-my-pi/pi-coding-agent/plan-mode/approved-plan";
import { PROPOSE_DEVICE_NAME, writeDeviceDispatch } from "@oh-my-pi/pi-coding-agent/tools/resolve";
import type { XdevDispatch } from "@oh-my-pi/pi-coding-agent/tools/xdev";
import type {
	PendingPlanApprovalWire,
	PlanModeContextWire,
	ServerFrame,
} from "@omp-deck/protocol";

import type { PlanApprovalResponse } from "./types.ts";

import { logger } from "../log.ts";

const log = logger("bridge:plan-mode");

/** Default plan file URL used only for the `plan_mode_changed` broadcast and
 *  as a last-resort fallback. The SDK's own plan-mode system prompt has the
 *  agent choose `local://<slug>-plan.md` per plan, and `preparePlanForReview`
 *  (via `resolveApprovedPlan`) finds that real file over this default — the
 *  authoritative path for any given proposal is always `inner.planFilePath`
 *  from the propose dispatch, never this constant. */
const PLAN_FILE_URL = "local://PLAN.md";

/** Tool the SDK requires active for plan-mode submission — proposals ride a
 *  `write` to `xd://propose`. Spliced into the active tool set on enter if
 *  it isn't already there. */
const PLAN_GATE_TOOL = "write";

/** Workflow flavor passed to `setPlanModeState`. MVP only supports
 *  `"parallel"`; `"iterative"` (TUI-only) is explicitly out of scope. */
const PLAN_WORKFLOW = "parallel" as const;

/**
 * Pre-rendered companion to
 * `@oh-my-pi/pi-coding-agent/src/prompts/system/plan-mode-approved.md`
 * with the deck's fixed branches baked in:
 *   - `contextPreserved: true` (deck never compacts at the plan boundary;
 *     deferred to v1.1 — see design doc §"open questions" #2)
 *   - `tools` includes `todo_write` (deck's session tool set always has it)
 *   - plan content inlined verbatim in addition to the `{{planFilePath}}`
 *     reference the SDK's own template uses — the deck surfaces this as a
 *     normal, visible chat turn (not a hidden synthetic dispatch), so the
 *     executing model has the text in front of it without a forced first
 *     read
 *
 * No rename language: SDK 17 never renames an approved plan, so
 * `{{planFilePath}}` is the same path the agent wrote to during planning.
 *
 * Inlined because the SDK's `exports` map doesn't expose `.md` assets, and
 * we want a stable contract that's visible alongside the lifecycle code
 * rather than a fragile runtime fetch. **Mirror SDK changes here on
 * upgrade.** Diff against the upstream file when bumping
 * `@oh-my-pi/pi-coding-agent`.
 */
const PLAN_APPROVED_PROMPT_TEMPLATE = `<critical>
Plan approved. You MUST execute it now.
</critical>

You MUST read \`{{planFilePath}}\` before continuing — it is authoritative if it conflicts with anything below. Context preserved; use conversation history when useful.

## Plan

{{planContent}}

<instruction>
You MUST execute this plan step by step from \`{{planFilePath}}\`. You have full tool access.
You MUST verify each step before proceeding to the next.
Before execution, initialize todo tracking with \`todo_write\`.
After each completed step, immediately update \`todo_write\`.
If \`todo_write\` fails, fix the payload and retry before continuing.
</instruction>

<critical>
You MUST keep going until complete. This matters.
</critical>
`;

/**
 * `writeDeviceDispatch`, widened to also accept the `eval` tool's result.
 *
 * The SDK's own helper is hard write-gated (`toolName !== "write"` bails —
 * `@oh-my-pi/pi-coding-agent/src/tools/resolve.ts:99`), but a live session
 * proved the model can route an `xd://propose` submission through the Python
 * eval bridge instead of a direct `write` — `tool.write(path='xd://propose',
 * content='<title>')` inside an eval cell — and the eval tool propagates the
 * same dispatch envelope verbatim onto its own result's `details.xdev`.
 * Without this, that path is silently dropped: no approval card, no abort,
 * the model just re-proposes in a loop (upstream gap in the SDK; revisit on
 * the next `@oh-my-pi/pi-coding-agent` bump).
 *
 * For `"write"` this delegates to the real `writeDeviceDispatch` so SDK
 * envelope semantics — and any future change to them — stay authoritative.
 * For `"eval"` it mirrors the SDK's own envelope checks by hand (resolve.ts
 * lines 98-107) since the SDK helper won't take the tool name as a param.
 *
 * The tool-name allowlist is deliberately kept to exactly these two names —
 * widening it would let any tool that happens to echo an xdev-shaped
 * `details` object (by accident or adversarially) trigger a plan approval.
 */
function deviceDispatchFromResult(toolName: string, result: unknown): XdevDispatch | undefined {
	if (toolName === "write") return writeDeviceDispatch(toolName, result);
	if (toolName !== "eval") return undefined;
	if (!result || typeof result !== "object" || !("details" in result)) return undefined;
	const details = result.details;
	if (!details || typeof details !== "object" || !("xdev" in details)) return undefined;
	const xdev = details.xdev;
	if (!xdev || typeof xdev !== "object" || !("tool" in xdev) || !("mode" in xdev)) return undefined;
	// Envelope verified above; the eval tool propagated a real XdevDispatch here.
	return xdev as XdevDispatch;
}

type PlanModeChangedFrame = Extract<ServerFrame, { type: "plan_mode_changed" }>;
type PlanProposedFrame = Extract<ServerFrame, { type: "plan_proposed" }>;
type PlanProposalResolvedFrame = Extract<ServerFrame, { type: "plan_proposal_resolved" }>;
export type PlanModeFrame = PlanModeChangedFrame | PlanProposedFrame | PlanProposalResolvedFrame;

type FrameListener = (frame: PlanModeFrame) => void;

interface PendingApproval {
	proposalId: string;
	planFilePath: string;
	planContent: string;
	suggestedTitle: string;
}

/** Minimal shape of the SDK's `tool_execution_end` event this bridge needs —
 *  just enough for `writeDeviceDispatch` to parse it. */
export interface PlanToolExecutionEndEvent {
	toolName: string;
	result: unknown;
	isError?: boolean;
}

/**
 * Minimal `AgentSession` surface this bridge needs. Listed here as a
 * structural interface so tests can substitute a hand-rolled fake without
 * spinning up the full SDK.
 */
export interface PlanModeSessionSurface {
	getActiveToolNames(): string[];
	setActiveToolsByName(toolNames: string[]): Promise<void>;
	setPlanModeState(state: { enabled: boolean; planFilePath: string; workflow: "parallel" | "iterative" } | undefined): void;
	setPlanProposalHandler(handler: ((title: string) => Promise<AgentToolResult<unknown>>) | null): void;
	preparePlanForReview(title: string): Promise<AgentToolResult<PlanApprovalDetails>>;
	setPlanReferencePath(path: string): void;
	markPlanReferenceSent(): void;
	markPlanInternalAbortPending(): void;
	clearPlanInternalAbortPending(): void;
	readonly isStreaming: boolean;
	abort(): Promise<void>;
	prompt(
		text: string,
		options?: { synthetic?: boolean; streamingBehavior?: "steer" | "followUp" },
	): Promise<unknown>;
}

// Compile-time drift guard: if a future SDK bump renames/removes a member
// this bridge depends on, `Pick<AgentSession, keyof PlanModeSessionSurface>`
// fails to construct (a member does not exist on `AgentSession` at all) and
// this file stops compiling. Signature narrowing (e.g. a return type getting
// stricter) is not guaranteed to be caught — only member existence is. If
// `Pick` fails here, fix the interface above to match the real
// `AgentSession` (see `node_modules/@oh-my-pi/pi-coding-agent/dist/types/session/agent-session.d.ts`);
// do not delete the guard.
type _AssertSurfaceIsReal = PlanModeSessionSurface extends Pick<AgentSession, keyof PlanModeSessionSurface> ? true : never;

export interface PlanModeBridgeArgs {
	sessionId: string;
	session: PlanModeSessionSurface;
	/** SDK `sessionManager.getArtifactsDir()` — feeds `local://` resolution. */
	getArtifactsDir: () => string | null;
	/** SDK `sessionManager.getSessionId()` — feeds `local://` resolution. */
	getSessionId: () => string | null;
}

/** Bridge over the SDK's plan-mode primitives, scoped to one session. */
export class PlanModeBridge {
	private readonly sessionId: string;
	private readonly session: PlanModeSessionSurface;
	private readonly getArtifactsDir: () => string | null;
	private readonly getSessionId: () => string | null;
	private readonly listeners = new Set<FrameListener>();
	private nextProposalCounter = 1;
	private enabled = false;
	private planFilePath: string = PLAN_FILE_URL;
	private previousTools: string[] = [];
	private pendingApproval: PendingApproval | undefined;
	private disposed = false;

	constructor(args: PlanModeBridgeArgs) {
		this.sessionId = args.sessionId;
		this.session = args.session;
		this.getArtifactsDir = args.getArtifactsDir;
		this.getSessionId = args.getSessionId;
	}

	// ─── Snapshot + replay surface (consumed by InProcessAgentBridge) ─────

	isEnabled(): boolean {
		return this.enabled;
	}

	hasPendingApproval(): boolean {
		return this.pendingApproval !== undefined;
	}

	getPlanModeContext(): PlanModeContextWire | undefined {
		if (!this.enabled) return undefined;
		return { enabled: true, planFilePath: this.planFilePath };
	}

	getPendingPlanApproval(): PendingPlanApprovalWire | undefined {
		const p = this.pendingApproval;
		if (!p) return undefined;
		return {
			proposalId: p.proposalId,
			planFilePath: p.planFilePath,
			planContent: p.planContent,
			suggestedTitle: p.suggestedTitle,
		};
	}

	/** Replay frames sent verbatim to a late subscriber so a page-reload
	 *  during plan mode immediately re-renders the pill + any open card. */
	getReplayFrames(): PlanModeFrame[] {
		const out: PlanModeFrame[] = [];
		if (this.enabled) {
			out.push({
				type: "plan_mode_changed",
				sessionId: this.sessionId,
				enabled: true,
				planFilePath: this.planFilePath,
			});
		}
		const p = this.pendingApproval;
		if (p) {
			out.push({
				type: "plan_proposed",
				sessionId: this.sessionId,
				proposalId: p.proposalId,
				planFilePath: p.planFilePath,
				planContent: p.planContent,
				suggestedTitle: p.suggestedTitle,
			});
		}
		return out;
	}

	subscribeFrames(listener: FrameListener): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	// ─── Lifecycle ────────────────────────────────────────────────────────

	/** Enter plan mode. Idempotent — re-entry is a no-op. */
	async enter(): Promise<void> {
		if (this.disposed || this.enabled) return;

		const previousTools = this.session.getActiveToolNames();
		const planTools = previousTools.includes(PLAN_GATE_TOOL)
			? previousTools
			: [...previousTools, PLAN_GATE_TOOL];
		await this.session.setActiveToolsByName(planTools);

		this.previousTools = previousTools;
		this.planFilePath = PLAN_FILE_URL;
		this.enabled = true;

		this.session.setPlanModeState({
			enabled: true,
			planFilePath: this.planFilePath,
			workflow: PLAN_WORKFLOW,
		});
		this.session.setPlanProposalHandler((title) => this.session.preparePlanForReview(title));

		this.#broadcast({
			type: "plan_mode_changed",
			sessionId: this.sessionId,
			enabled: true,
			planFilePath: this.planFilePath,
		});
		log.info(`plan mode entered for ${this.sessionId}`);
	}

	/**
	 * Exit plan mode. Idempotent. There is nothing to reject anymore — SDK 17
	 * never blocks a tool call on the approval decision — so a pending
	 * approval is drained with a `plan_proposal_resolved` broadcast instead
	 * of a rejected promise.
	 *
	 * `reason` differentiates user-cancel (Shift+Tab off, Reject click) from
	 * server-side cleanup (session disposed) from the two terminal outcomes
	 * of `respond()` (`approved`/`rejected`), which pass `toolOverride`
	 * explicitly and have already cleared `pendingApproval` themselves.
	 */
	async exit(
		reason: "user_cancelled" | "session_disposed" | "approved" | "rejected" = "user_cancelled",
		options: { toolOverride?: string[] } = {},
	): Promise<void> {
		if (this.disposed && reason !== "session_disposed") return;
		if (!this.enabled && !this.pendingApproval) return;

		if (this.pendingApproval) {
			const pending = this.pendingApproval;
			this.pendingApproval = undefined;
			if (reason === "user_cancelled" || reason === "session_disposed") {
				this.#broadcast({
					type: "plan_proposal_resolved",
					sessionId: this.sessionId,
					proposalId: pending.proposalId,
					outcome: reason === "user_cancelled" ? "rejected" : "expired",
				});
			}
		}

		if (this.enabled) {
			const restoreTools = options.toolOverride ?? this.previousTools;
			if (restoreTools.length > 0) {
				try {
					await this.session.setActiveToolsByName(restoreTools);
				} catch (err) {
					log.warn(`tool restore failed during exit for ${this.sessionId}`, err);
				}
			}
			this.session.setPlanProposalHandler(null);
			this.session.setPlanModeState(undefined);
			this.enabled = false;
			this.previousTools = [];

			this.#broadcast({
				type: "plan_mode_changed",
				sessionId: this.sessionId,
				enabled: false,
			});
		}

		log.info(`plan mode exited for ${this.sessionId} (${reason})`);
	}

	/**
	 * Settle the pending approval. Returns `"unknown"` when the proposalId
	 * does not match the live pending entry (already-resolved by a sibling
	 * tab; the caller surfaces a 409 + the client rolls back optimistic UI).
	 */
	async respond(proposalId: string, response: PlanApprovalResponse): Promise<"settled" | "unknown"> {
		const pending = this.pendingApproval;
		if (!pending || pending.proposalId !== proposalId) {
			return "unknown";
		}
		// Clear synchronously, before any await below — double-click safety:
		// a second respond() racing in while this one is still working must
		// see "unknown", not settle the same proposal twice.
		this.pendingApproval = undefined;

		if (!response.approved) {
			await this.exit("rejected");
			this.#broadcast({
				type: "plan_proposal_resolved",
				sessionId: this.sessionId,
				proposalId,
				outcome: "rejected",
			});
			return "settled";
		}

		const planContent = response.editedContent ?? pending.planContent;
		if (response.editedContent !== undefined) {
			await this.#writePlanFile(pending.planFilePath, planContent);
		}

		// Approved-plan execution needs `read` to load the durable plan file
		// even when the pre-plan tool set didn't carry it.
		const executionTools = this.previousTools.includes("read")
			? this.previousTools
			: [...this.previousTools, "read"];
		await this.exit("approved", { toolOverride: executionTools });
		this.session.setPlanReferencePath(pending.planFilePath);
		this.session.markPlanReferenceSent();

		const executionPrompt = renderApprovedPrompt({
			planContent,
			planFilePath: pending.planFilePath,
		});
		// Deliberately NOT `synthetic` — unlike the TUI's hidden dispatch, the
		// deck wants the plan-approved handoff visible in the transcript as a
		// normal turn. `streamingBehavior: "followUp"` is safe unconditionally
		// here: the SDK's `prompt()` runs it immediately when idle and queues
		// it as a follow-up when a turn is still winding down from the silent
		// abort in `#onProposeDispatch` — no `isStreaming` branch needed. Not
		// awaited: the caller (`respond()`) must resolve once the decision is
		// recorded, not once the whole execution turn finishes.
		void this.session
			.prompt(executionPrompt, { streamingBehavior: "followUp" })
			.catch((err) => log.warn(`approved-plan followUp prompt failed for ${this.sessionId}`, err));

		this.#broadcast({
			type: "plan_proposal_resolved",
			sessionId: this.sessionId,
			proposalId,
			outcome: "approved",
		});
		return "settled";
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		// Fire-and-forget — dispose is sync; the SDK call chain in exit() is
		// best-effort during teardown.
		void this.exit("session_disposed");
		this.listeners.clear();
	}

	// ─── Internal ─────────────────────────────────────────────────────────

	#broadcast(frame: PlanModeFrame): void {
		for (const listener of this.listeners) {
			try {
				listener(frame);
			} catch (err) {
				log.warn(`plan-mode frame listener threw`, err);
			}
		}
	}

	/**
	 * SDK event hook: fires on every completed tool execution (wired by
	 * `InProcessAgentBridge.attach`'s `session.subscribe` callback). Detects
	 * an `xd://propose` dispatch — the agent submitting a plan for approval,
	 * whether it arrived via a direct `write` or the Python eval bridge (see
	 * `deviceDispatchFromResult`) — and hands off to `#onProposeDispatch`.
	 *
	 * MUST stay synchronous and MUST NOT be awaited by the caller:
	 * `AgentSession` fans out `session.subscribe` listeners synchronously, so
	 * awaiting approval work here would hold up every other event on the same
	 * dispatch chain until execution finishes — the chat would go blank for
	 * the whole turn (SDK issue #7684). `#onProposeDispatch` is invoked below
	 * as a detached `void` promise for exactly this reason.
	 */
	onToolExecutionEnd(event: PlanToolExecutionEndEvent): void {
		if (!this.enabled || this.pendingApproval) return;
		const dispatch = deviceDispatchFromResult(event.toolName, event.result);
		if (!dispatch || dispatch.tool !== PROPOSE_DEVICE_NAME || dispatch.mode !== "execute") return;
		const inner = dispatch.inner;
		if (
			!inner ||
			typeof inner !== "object" ||
			!("planFilePath" in inner) ||
			!("title" in inner) ||
			!("planExists" in inner) ||
			typeof (inner as { planFilePath: unknown }).planFilePath !== "string" ||
			typeof (inner as { title: unknown }).title !== "string" ||
			typeof (inner as { planExists: unknown }).planExists !== "boolean"
		) {
			return;
		}
		// MUST NOT be awaited here — see the doc comment above.
		void this.#onProposeDispatch(inner as PlanApprovalDetails).catch((err) => {
			log.warn(`propose dispatch handling failed for ${this.sessionId}`, err);
		});
	}

	/**
	 * Async continuation of a validated propose dispatch. Aborts the
	 * in-flight turn silently (constraint 2 — without this the model sees its
	 * own "ready for review" tool result and immediately re-proposes), reads
	 * the plan file, and surfaces the approval card. A missing plan file logs
	 * and returns with plan mode left enabled — the agent can retry, since
	 * nothing here failed in a way the user needs to see.
	 */
	async #onProposeDispatch(details: PlanApprovalDetails): Promise<void> {
		this.session.markPlanInternalAbortPending();
		try {
			await this.session.abort();
		} finally {
			this.session.clearPlanInternalAbortPending();
		}

		const planContent = await this.#readPlanFile(details.planFilePath);
		if (planContent === null) {
			log.warn(`plan file not found at ${details.planFilePath} for ${this.sessionId}; plan mode stays on`);
			return;
		}

		const { title } = resolvePlanTitle({
			suppliedTitle: details.title,
			planContent,
			planFilePath: details.planFilePath,
		});

		const proposalId = this.#allocateProposalId();
		this.pendingApproval = {
			proposalId,
			planFilePath: details.planFilePath,
			planContent,
			suggestedTitle: title,
		};

		this.#broadcast({
			type: "plan_proposed",
			sessionId: this.sessionId,
			proposalId,
			planFilePath: details.planFilePath,
			planContent,
			suggestedTitle: title,
		});
	}

	async #readPlanFile(planFilePath: string): Promise<string | null> {
		const fsPath = resolveLocalUrlToPath(planFilePath, {
			getArtifactsDir: this.getArtifactsDir,
			getSessionId: this.getSessionId,
		});
		try {
			return await fs.readFile(fsPath, "utf-8");
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
			throw err;
		}
	}

	async #writePlanFile(planFilePath: string, content: string): Promise<void> {
		const fsPath = resolveLocalUrlToPath(planFilePath, {
			getArtifactsDir: this.getArtifactsDir,
			getSessionId: this.getSessionId,
		});
		await fs.writeFile(fsPath, content, "utf-8");
	}

	#allocateProposalId(): string {
		const id = `pa_${this.sessionId}_${this.nextProposalCounter}`;
		this.nextProposalCounter += 1;
		return id;
	}
}

function renderApprovedPrompt(args: { planContent: string; planFilePath: string }): string {
	return PLAN_APPROVED_PROMPT_TEMPLATE.replaceAll("{{planContent}}", args.planContent).replaceAll(
		"{{planFilePath}}",
		args.planFilePath,
	);
}
