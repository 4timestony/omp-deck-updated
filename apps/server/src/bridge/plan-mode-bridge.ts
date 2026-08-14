/**
 * Per-session bridge for omp plan mode.
 *
 * Mirrors the TUI's `InteractiveMode.#enterPlanMode` lifecycle on top of
 * the deck's WebSocket protocol:
 *
 *   1. Client sends `set_plan_mode {enabled:true}` → `enter()`:
 *      - snapshot active tools, splice in `resolve` if missing
 *      - `setActiveToolsByName(planTools)`
 *      - `setPlanModeState({ enabled, planFilePath, workflow })`
 *      - `setStandingResolveHandler(#handlePlanResolve)`
 *      - broadcast `plan_mode_changed{enabled:true}`
 *
 *   2. Agent works under plan-mode restrictions (SDK's
 *      `#enforcePlanModeToolDecision` blocks writes via the system
 *      prompt + tool-decision intercept), writes `local://PLAN.md`,
 *      calls `resolve apply`. The SDK invokes our standing handler
 *      via `runResolveInvocation`.
 *
 *   3. `#handlePlanResolve`'s `apply` callback:
 *      - validates plan-mode is still active
 *      - reads the plan file via `local://` resolver
 *      - derives a title via `resolvePlanTitle` (handles issue #1179
 *        empty-`extra.title` corner case)
 *      - broadcasts `plan_proposed` to the deck UI
 *      - **blocks** on a Promise the deck UI settles via
 *        `plan_response` → `respond(proposalId, response)`
 *
 *   4. On approve: write edited content (if any), rename PLAN.md to
 *      the title-derived final path, exit plan mode (restoring the
 *      previous tool set + clearing handler + clearing SDK state),
 *      and queue the SDK's `planModeApprovedPrompt` as a follow-up
 *      so the next turn executes the plan with full tools.
 *
 *   5. On reject: exit plan mode and surface a clear rejection
 *      message to the agent.
 *
 *   6. On cancel (user toggles plan mode off mid-approval) or session
 *      dispose: reject the pending promise so the resolve tool
 *      returns with an error the agent can recover from.
 *
 * SDK reference impl: `@oh-my-pi/pi-coding-agent/src/modes/interactive-mode.ts`
 * (`#enterPlanMode`, `#runPlanApprovalResolve`, `#exitPlanMode`,
 * `#approvePlan`).
 */
import * as fs from "node:fs/promises";

import type { AgentSession } from "@oh-my-pi/pi-coding-agent";
import type { AgentToolResult } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import { resolveLocalUrlToPath } from "@oh-my-pi/pi-coding-agent/internal-urls";
// SDK 17 removed `renameApprovedPlanFile` (approved plans are no longer
// renamed, so `local://` links stay valid) and replaced `runResolveInvocation`
// with the `xd://propose` device model. Plan mode is disabled on 17 until the
// bridge is ported to that architecture — see `enter()` below.
import type { PlanApprovalDetails } from "@oh-my-pi/pi-coding-agent/plan-mode/approved-plan";
import { ToolError } from "@oh-my-pi/pi-coding-agent/tools/tool-errors";
import type {
	PendingPlanApprovalWire,
	PlanModeContextWire,
	ServerFrame,
} from "@omp-deck/protocol";

import type { PlanApprovalResponse } from "./types.ts";

import { logger } from "../log.ts";

const log = logger("bridge:plan-mode");

/** Canonical plan file URL. The SDK's `resolve` tool, the TUI, and the
 *  plan-mode system prompt all use this exact path; do not vary per-session. */
const PLAN_FILE_URL = "local://PLAN.md";

/** Tool the SDK requires for plan-mode submission. Spliced into the active
 *  tool set on enter if it isn't already there. */
const RESOLVE_TOOL = "resolve";

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

Finalized plan artifact: \`{{finalPlanFilePath}}\`
Context preserved. Use conversation history when useful; the finalized plan is the source of truth if it conflicts with earlier exploration.

## Plan

{{planContent}}

<instruction>
You MUST execute this plan step by step from \`{{finalPlanFilePath}}\`. You have full tool access.
You MUST verify each step before proceeding to the next.
Before execution, initialize todo tracking with \`todo_write\`.
After each completed step, immediately update \`todo_write\`.
If \`todo_write\` fails, fix the payload and retry before continuing.
</instruction>

<critical>
You MUST keep going until complete. This matters.
</critical>
`;

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
	suggestedFinalPath: string;
	resolve: (resp: PlanApprovalResponse) => void;
	reject: (err: Error) => void;
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
	setStandingResolveHandler(
		handler: ((input: unknown) => Promise<unknown> | unknown) | null,
	): void;
	markPlanReferenceSent(): void;
	readonly isStreaming: boolean;
	prompt(
		text: string,
		options?: { synthetic?: boolean; streamingBehavior?: "steer" | "followUp" },
	): Promise<void>;
}

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
			suggestedFinalPath: p.suggestedFinalPath,
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
				suggestedFinalPath: p.suggestedFinalPath,
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

		// SDK 17 port gap. On 15.x the approval flow blocked inside a standing
		// resolve handler; 17 removed `setStandingResolveHandler` outright and
		// moved plan proposals to `setPlanProposalHandler` + an out-of-band
		// `xd://propose` dispatch that the host observes without blocking.
		// Refuse at the door rather than let someone plan for twenty minutes
		// and discover the approval step is missing — or hit an undefined
		// method, which is what the old call path would do here.
		throw new Error(
			"Plan mode is not available on omp SDK 17 yet: the approval flow still targets the 15.x resolve-handler API. Everything else (models, MCP, skills, sessions) runs on 17.",
		);

		const previousTools = this.session.getActiveToolNames();
		const planTools = previousTools.includes(RESOLVE_TOOL)
			? previousTools
			: [...previousTools, RESOLVE_TOOL];
		await this.session.setActiveToolsByName(planTools);

		this.previousTools = previousTools;
		this.planFilePath = PLAN_FILE_URL;
		this.enabled = true;

		this.session.setPlanModeState({
			enabled: true,
			planFilePath: this.planFilePath,
			workflow: PLAN_WORKFLOW,
		});
		this.session.setStandingResolveHandler((input) => this.#handlePlanResolve(input));

		this.#broadcast({
			type: "plan_mode_changed",
			sessionId: this.sessionId,
			enabled: true,
			planFilePath: this.planFilePath,
		});
		log.info(`plan mode entered for ${this.sessionId}`);
	}

	/**
	 * Exit plan mode. Idempotent. Rejects any pending approval first so the
	 * standing handler unblocks with a clear error the agent can surface as
	 * the resolve tool's failure result.
	 *
	 * `reason` differentiates user-cancel (Shift+Tab off, Reject click) from
	 * server-side cleanup (session disposed, approve path that already did
	 * the rename + synthetic prompt).
	 */
	async exit(
		reason: "user_cancelled" | "session_disposed" | "approved" | "rejected" = "user_cancelled",
	): Promise<void> {
		if (this.disposed && reason !== "session_disposed") return;
		if (!this.enabled && !this.pendingApproval) return;

		if (this.pendingApproval) {
			const pending = this.pendingApproval;
			this.pendingApproval = undefined;
			if (reason === "user_cancelled" || reason === "session_disposed") {
				const message =
					reason === "user_cancelled"
						? "Plan approval cancelled: user exited plan mode."
						: "Plan approval abandoned: session disposed.";
				pending.reject(new Error(message));
				this.#broadcast({
					type: "plan_proposal_resolved",
					sessionId: this.sessionId,
					proposalId: pending.proposalId,
					outcome: reason === "user_cancelled" ? "rejected" : "expired",
				});
			}
		}

		if (this.enabled) {
			if (this.previousTools.length > 0) {
				try {
					await this.session.setActiveToolsByName(this.previousTools);
				} catch (err) {
					log.warn(`tool restore failed during exit for ${this.sessionId}`, err);
				}
			}
			this.session.setStandingResolveHandler(null);
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
	respond(proposalId: string, response: PlanApprovalResponse): "settled" | "unknown" {
		const pending = this.pendingApproval;
		if (!pending || pending.proposalId !== proposalId) {
			return "unknown";
		}
		// Do NOT clear pendingApproval here — the apply callback clears it
		// after the promise resolves so any concurrent respond() racing
		// with the resolve still sees "settled" until the callback exits.
		pending.resolve(response);
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
	 * Standing resolve handler — REMOVED for SDK 17.
	 *
	 * 15.x shape: `runResolveInvocation` validated the agent's `resolve` call
	 * and its `apply` callback blocked on the user's `plan_response`, so the
	 * approval decision could be returned as the tool's own result.
	 *
	 * 17.x shape: the agent writes to `xd://propose`; `preparePlanForReview`
	 * returns immediately with `PlanApprovalDetails`; the host watches for that
	 * dispatch and runs approval detached from the event chain (awaiting it
	 * inside the dispatch stalls every other event), aborting the in-flight
	 * turn first so the model does not re-propose in a loop.
	 *
	 * Porting means inverting this bridge's control flow, so it is deliberately
	 * left unimplemented rather than half-migrated. `enter()` refuses before
	 * anything can reach this path.
	 */
	#handlePlanResolve(_input: unknown): Promise<AgentToolResult<PlanApprovalDetails>> {
		return Promise.reject(
			new ToolError("Plan mode is not available on omp SDK 17 yet."),
		);
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

function renderApprovedPrompt(args: { planContent: string; finalPlanFilePath: string }): string {
	return PLAN_APPROVED_PROMPT_TEMPLATE.replaceAll(
		"{{planContent}}",
		args.planContent,
	).replaceAll("{{finalPlanFilePath}}", args.finalPlanFilePath);
}

/**
 * Validate a client-supplied override of the final plan path. Returns
 * `undefined` when the input is missing or shaped wrong; the caller falls
 * back to the SDK-suggested path. We deliberately don't throw — a malformed
 * `finalPath` shouldn't fail the whole approval; falling back to the
 * suggested path is the user-friendly default.
 */
function sanitizeFinalPath(input: string | undefined): string | undefined {
	if (!input) return undefined;
	const trimmed = input.trim();
	if (!trimmed.startsWith("local://")) return undefined;
	// Strip the scheme and reject anything that has path separators or `..`
	// anywhere — must be a single safe filename, NOT a nested path or
	// traversal attempt. (Stripping then taking the basename would silently
	// "sanitize" `local://../escape.md` into `escape.md`; reject instead.)
	const remainder = trimmed.replace(/^local:\/+/, "");
	if (remainder.includes("/") || remainder.includes("\\")) return undefined;
	if (remainder.includes("..")) return undefined;
	if (!remainder.endsWith(".md")) return undefined;
	const stem = remainder.slice(0, -".md".length);
	if (stem.length === 0) return undefined;
	if (!/^[A-Za-z0-9_-]+$/.test(stem)) return undefined;
	return `local://${remainder}`;
}

function extractFileName(localUrl: string): string {
	return localUrl.replace(/^local:\/+/, "").split(/[\\/]/).pop() ?? "";
}

function stripMdExtension(fileName: string): string {
	return fileName.replace(/\.md$/i, "");
}
