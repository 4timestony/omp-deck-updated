import type { ToolRendererProps } from "./ToolCallCard";
import { extractResultText } from "./shared";
import { cn } from "@/lib/utils";

interface Op {
	op: string;
	task?: string;
	phase?: string;
	text?: string;
	items?: string[];
}

/** SDK 17 todo tool args: a single operation, not a 15.x `{ ops: [...] }` array. */
interface TodoToolArgsV17 {
	op?: string;
	/** init: phased task list. */
	list?: { phase: string; items?: string[] }[];
	task?: string;
	phase?: string;
	/** append: task content to add. */
	items?: string[];
	/** block: blocker note. */
	reason?: string;
}

const OP_TONE: Record<string, string> = {
	init: "text-accent",
	start: "text-accent",
	done: "text-success",
	rm: "text-ink-3",
	drop: "text-warn",
	block: "text-warn",
	unblock: "text-accent",
	append: "text-accent",
	note: "text-ink-3",
	view: "text-ink-3",
};

/**
 * Normalize either shape into the `Op[]` this card renders:
 *  - 15.x transcripts: `args.ops` is already an `Op[]` — used verbatim.
 *  - SDK 17: `args` IS a single op `{op, list?, task?, phase?, items?,
 *    reason?}` — synthesize one row per `list` phase for `init`, else a
 *    single row carrying `task`/`items`/`reason` (rendered via the existing
 *    `text` field).
 */
function toOps(args: Record<string, unknown>): Op[] {
	const legacyOps = (args as { ops?: unknown }).ops;
	if (Array.isArray(legacyOps)) return legacyOps as Op[];

	const a = args as TodoToolArgsV17;
	if (!a.op) return [];
	if (a.op === "init" && Array.isArray(a.list)) {
		return a.list.map((p) => ({ op: a.op as string, phase: p.phase, items: p.items }));
	}
	return [{ op: a.op, task: a.task, phase: a.phase, items: a.items, text: a.reason }];
}

export function TodoWriteTool({ args, stream }: ToolRendererProps) {
	const ops = toOps(args);
	const result = stream?.result;
	const resultText = result ? extractResultText(result) : "";

	return (
		<div className="space-y-1">
			<ul className="space-y-0.5 text-[13px]">
				{ops.map((op, i) => (
					<li key={i} className="flex items-start gap-2">
						<span className={cn("min-w-[44px] shrink-0 font-mono text-2xs uppercase tracking-meta", OP_TONE[op.op] ?? "text-ink-3")}>
							{op.op}
						</span>
						<div className="min-w-0 flex-1">
							{op.phase ? <span className="text-thinking font-mono text-xs">{op.phase}</span> : null}
							{op.phase && (op.task || op.text || op.items) ? <span className="text-ink-3"> · </span> : null}
							{op.task ? <span className="text-ink">{op.task}</span> : null}
							{op.text ? <span className="text-ink-3"> — {op.text}</span> : null}
							{op.items ? (
								<ul className="ml-3 mt-0.5 list-disc text-ink-2">
									{op.items.map((it, j) => (
										// Items are strings per the schema, but SDK 17's shape change is
										// exactly why we don't trust that without a defensive coercion.
										<li key={j}>{String(it)}</li>
									))}
								</ul>
							) : null}
						</div>
					</li>
				))}
			</ul>
			{resultText ? (
				<div className="font-mono text-2xs text-ink-3">{resultText}</div>
			) : null}
		</div>
	);
}
