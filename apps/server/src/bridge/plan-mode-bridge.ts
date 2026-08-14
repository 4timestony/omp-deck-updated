/**
 * Per-session bridge for omp plan mode.
 *
 * Mirrors the TUI's `InteractiveMode` plan-approval lifecycle on top of the
 * deck's WebSocket protocol, ported to SDK 17's inverted control flow (the
 * old blocking `setStandingResolveHandler` API is gone):
 *
 *   1. Client sends `set_plan_mode {enabled:true}` → `enter()`:
 *      - snapshot the ENABLED tool set (top-level + xd://-mounted —
 *        `setActiveToolsByName` consumes this as the complete enabled
 *        selection, so a merely-active snapshot silently drops xd://-mounted
 *        tools; see `interactive-mode.ts:2674`), splice in the built-in
 *        `write` if missing (proposals ride a `write` to `xd://propose`)
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
 *   3. Propose detection has two triggers, because the SDK's own signal —
 *      `writeDeviceDispatch` echoing the dispatch envelope onto the `write`
 *      tool's result — only fires when the model calls `write` directly. A
 *      live session proved the model can instead route `xd://propose`
 *      through the Python eval bridge (`tool.write(path='xd://propose', …)`
 *      inside an eval cell); there the enclosing `tool_execution_end` has
 *      `toolName === "eval"` and its result carries `EvalToolDetails`
 *      (language/cells/…) — the envelope never reaches it, only the plan-
 *      proposal handler that `dispatchResolutionDevice` calls internally.
 *        - Primary (write path, SDK-authoritative): `onToolExecutionEnd`
 *          parses the propose dispatch straight off the tool result via
 *          `writeDeviceDispatch`.
 *        - Fallback (transport-agnostic): the `setPlanProposalHandler`
 *          callback installed in `enter()` runs for every propose regardless
 *          of transport, so it captures `PlanApprovalDetails` into
 *          `capturedPropose` the instant the handler runs.
 *          `onToolExecutionEnd` consumes that capture at the *next* tool
 *          boundary (any tool, not just `write`/`eval`) when the write-path
 *          parse didn't already find one — matching the SDK's own
 *          abort-after-result timing rather than aborting mid-dispatch.
 *      Either trigger hands off to `#onProposeDispatch`, which:
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
 *  `write` to `xd://propose`. Spliced into the enabled tool set on enter,
 *  but only when it resolves to the built-in `write` (see `enter()`). */
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
 * Duck-types a propose dispatch's `inner` payload as `PlanApprovalDetails`.
 * Shared by both propose triggers (the write-path envelope parse and the
 * handler-capture fallback — see the module doc) so a malformed payload is
 * rejected identically regardless of which one produced it.
 */
function isPlanApprovalDetailsShape(details: unknown): details is PlanApprovalDetails {
	return (
		!!details &&
		typeof details === "object" &&
		"planFilePath" in details &&
		"title" in details &&
		"planExists" in details &&
		typeof (details as { planFilePath: unknown }).planFilePath === "string" &&
		typeof (details as { title: unknown }).title === "string" &&
		typeof (details as { planExists: unknown }).planExists === "boolean"
	);
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
	/** Enabled top-level AND xd://-mounted tool names — the full inventory
	 *  `setActiveToolsByName` treats as the complete enabled selection. MUST
	 *  NOT be `getActiveToolNames` (top-level only): snapshotting only the
	 *  active set and replaying it through `setActiveToolsByName` silently
	 *  drops every xd://-mounted tool and, after one plan round, any enabled-
	 *  but-not-top-level tool (e.g. `write`) — see
	 *  `interactive-mode.ts:2674`. */
	getEnabledToolNames(): string[];
	/** Whether the live registry entry for `name` came from a built-in
	 *  factory, as opposed to a shadowing extension tool of the same name
	 *  (SDK issue #3165). Gates the `write` splice in `enter()`. */
	hasBuiltInTool(name: string): boolean;
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
	/** Propose seen by the `setPlanProposalHandler` callback but not yet
	 *  surfaced — consumed by `onToolExecutionEnd` at the next tool boundary.
	 *  See the module doc's fallback-trigger explanation. */
	private capturedPropose: PlanApprovalDetails | undefined;
	/** Set synchronously the instant a propose is launched into
	 *  `#onProposeDispatch`, cleared when that call settles (success, early
	 *  return, or throw). Closes the async gap before `pendingApproval` is
	 *  set, during which a second propose trigger could race in. */
	#proposeInFlight = false;
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

		const previousTools = this.session.getEnabledToolNames();
		// plan-mode-active.md has the agent draft with `write`/refine with
		// `edit`, and plan approval itself is a `write` to `xd://propose` —
		// `write` must be in the enabled set or the agent cannot submit. Only
		// re-activate the BUILT-IN write: a shadowing extension tool named
		// `write` must stay inactive (plan mode's read-only guarantee rides
		// the built-in guard). Mirrors interactive-mode.ts:2674-2690.
		const planAugmentations: string[] = this.session.hasBuiltInTool(PLAN_GATE_TOOL) ? [PLAN_GATE_TOOL] : [];
		const planTools = [...new Set([...previousTools, ...planAugmentations])];
		await this.session.setActiveToolsByName(planTools);

		this.previousTools = previousTools;
		this.planFilePath = PLAN_FILE_URL;
		this.enabled = true;

		this.session.setPlanModeState({
			enabled: true,
			planFilePath: this.planFilePath,
			workflow: PLAN_WORKFLOW,
		});
		this.session.setPlanProposalHandler(async (title) => {
			const result = await this.session.preparePlanForReview(title);
			if (isPlanApprovalDetailsShape(result?.details)) {
				// Captured, not yet surfaced: the approval flow must not start
				// inside the tool dispatch (constraint 1), and aborting before the
				// enclosing tool result lands would diverge from the SDK's
				// abort-after-result timing. `onToolExecutionEnd` consumes this at
				// the next tool boundary.
				this.capturedPropose = result.details;
			}
			return result;
		});

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
		// A handler capture is scoped to the plan-mode session that produced
		// it — any exit (including a no-op idempotent call below) invalidates
		// it so a later tool end can't surface a stale card. Synchronous, so
		// it lands before this function's first `await` regardless of caller.
		this.capturedPropose = undefined;
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
		this.capturedPropose = undefined;
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
	 * an `xd://propose` dispatch — the agent submitting a plan for approval —
	 * via either trigger described in the module doc, and hands off to
	 * `#onProposeDispatch`.
	 *
	 * MUST stay synchronous and MUST NOT be awaited by the caller:
	 * `AgentSession` fans out `session.subscribe` listeners synchronously, so
	 * awaiting approval work here would hold up every other event on the same
	 * dispatch chain until execution finishes — the chat would go blank for
	 * the whole turn (SDK issue #7684). `#onProposeDispatch` is invoked below
	 * as a detached `void` promise for exactly this reason.
	 */
	onToolExecutionEnd(event: PlanToolExecutionEndEvent): void {
		if (event.isError) {
			// A failed enclosing tool (e.g. a malformed eval cell) carries no
			// usable propose signal — drop any capture so it can't surface on
			// some later unrelated tool end.
			this.capturedPropose = undefined;
			return;
		}
		if (!this.enabled || this.pendingApproval || this.#proposeInFlight) return;

		let details: PlanApprovalDetails | undefined;
		// Primary, SDK-authoritative: a direct `write` to `xd://propose` echoes
		// the dispatch envelope on its own result.
		const dispatch = writeDeviceDispatch(event.toolName, event.result);
		if (dispatch && dispatch.tool === PROPOSE_DEVICE_NAME && dispatch.mode === "execute" && isPlanApprovalDetailsShape(dispatch.inner)) {
			details = dispatch.inner;
			// Same propose the handler may already have captured — clear it so
			// the fallback below can't fire it a second time.
			this.capturedPropose = undefined;
		} else if (this.capturedPropose) {
			// Fallback: the eval-bridge route never echoes the envelope onto the
			// enclosing `eval` tool's result (see module doc) — the handler saw
			// it instead. Consume the capture at this tool boundary.
			details = this.capturedPropose;
			this.capturedPropose = undefined;
		}
		if (!details) return;

		this.#proposeInFlight = true;
		// MUST NOT be awaited here — see the doc comment above.
		void this.#onProposeDispatch(details).catch((err) => {
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
		try {
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
		} finally {
			// Releases the launch guard set synchronously in
			// `onToolExecutionEnd` — on every path: success, the missing-plan-
			// file early return, or a thrown error — so a later tool end can
			// trigger the next propose.
			this.#proposeInFlight = false;
		}
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
