import { useEffect, useState } from "react";
import { Archive, MessageSquarePlus, RotateCcw, Trash2, X } from "lucide-react";
import type { Task, TaskState } from "@omp-deck/protocol";

import { MarkdownEdit } from "@/components/MarkdownEdit";
import { Modal } from "@/components/ui/Modal";
import { cn } from "@/lib/utils";

interface Props {
	task: Task | null;
	states: TaskState[];
	onClose: () => void;
	onSave: (patch: { title?: string; body?: string; stateId?: string; cwd?: string | null }) => void;
	onDelete: () => void;
	onArchive: () => void;
	onOpenInChat: () => void;
}

/**
 * Centered modal for full task detail / edit. Title is a large inline-editable
 * input; body uses MarkdownEdit (rendered by default, click to edit). The
 * action bar mirrors the inbox reader for consistency: state-change on the
 * left, archive / delete / Open-in-chat / close on the right.
 */
export function TaskModal({
	task,
	states,
	onClose,
	onSave,
	onDelete,
	onArchive,
	onOpenInChat,
}: Props) {
	const open = task !== null;

	// Local mirror of editable fields so we can commit on blur without
	// thrashing the API on every keystroke.
	const [title, setTitle] = useState("");
	const [stateId, setStateId] = useState("");
	const [cwd, setCwd] = useState("");

	useEffect(() => {
		if (!task) return;
		setTitle(task.title);
		setStateId(task.stateId);
		setCwd(task.cwd ?? "");
	}, [task]);

	if (!task) return null;

	function commitTitle(): void {
		if (!task) return;
		if (title !== task.title) onSave({ title });
	}
	function commitState(next: string): void {
		setStateId(next);
		if (!task || next === task.stateId) return;
		onSave({ stateId: next });
	}
	function commitCwd(): void {
		if (!task) return;
		// A blank field clears the cwd (files the task back to Unassigned).
		const trimmed = cwd.trim();
		const next = trimmed === "" ? null : trimmed;
		if ((task.cwd ?? null) !== next) onSave({ cwd: next });
	}

	const isArchived = Boolean(task.archivedAt);

	return (
		<Modal open={open} onClose={onClose} widthClass="max-w-3xl">
			<header className="flex h-14 shrink-0 items-center gap-2 border-b border-line px-4">
				<select
					value={stateId}
					onChange={(e) => commitState(e.target.value)}
					className="field h-8 px-2 font-mono text-2xs uppercase tracking-meta"
				>
					{states.map((s) => (
						<option key={s.id} value={s.id}>
							{s.name}
						</option>
					))}
				</select>
				<div
					className="h-2 w-2 rounded-full"
					style={{
						backgroundColor:
							states.find((s) => s.id === stateId)?.color ?? "var(--ink-3, #6e6a62)",
					}}
				/>
				<div className="ml-auto flex shrink-0 items-center gap-1">
					<IconAction
						label={isArchived ? "Unarchive" : "Archive"}
						icon={isArchived ? RotateCcw : Archive}
						onClick={onArchive}
					/>
					<IconAction label="Delete" icon={Trash2} tone="danger" onClick={onDelete} />
					<button
						type="button"
						onClick={onOpenInChat}
						className="btn-primary h-8 shrink-0 gap-1.5 whitespace-nowrap px-2.5 text-sm"
						title="Open this task as a new chat session"
					>
						<MessageSquarePlus className="h-4 w-4 shrink-0" />
						<span>Open in chat</span>
					</button>
					<IconAction label="Close" icon={X} onClick={onClose} />
				</div>
			</header>

			<div className="shrink-0 border-b border-line px-6 pt-5 pb-3">
				<input
					value={title}
					onChange={(e) => setTitle(e.target.value)}
					onBlur={commitTitle}
					onKeyDown={(e) => {
						if (e.key === "Enter") (e.target as HTMLInputElement).blur();
					}}
					placeholder="Untitled task"
					className={cn(
						"w-full bg-transparent text-xl font-semibold text-ink placeholder:text-ink-4 focus:outline-none",
						isArchived && "text-ink-3 line-through",
					)}
				/>
				<div className="mt-1 grid grid-cols-[max-content_1fr_max-content_1fr] gap-x-4 gap-y-1 font-mono text-2xs text-ink-3">
					<span className="text-ink-4">created</span>
					<span>{new Date(task.createdAt).toLocaleString()}</span>
					<span className="text-ink-4">updated</span>
					<span>{new Date(task.updatedAt).toLocaleString()}</span>
					<span className="text-ink-4">cwd</span>
					<span className="col-span-3">
						<input
							value={cwd}
							onChange={(e) => setCwd(e.target.value)}
							onBlur={commitCwd}
							placeholder="(defaults to server cwd)"
							className="w-full bg-transparent font-mono text-2xs text-ink placeholder:text-ink-4 focus:outline-none"
						/>
					</span>
					{isArchived ? (
						<>
							<span className="text-warn">archived</span>
							<span>{new Date(task.archivedAt!).toLocaleString()}</span>
						</>
					) : null}
				</div>
			</div>

			<div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
				<MarkdownEdit
					value={task.body}
					onChange={(next) => onSave({ body: next })}
					placeholder="Click to add notes — markdown supported. Use this for context, acceptance criteria, links."
				/>
			</div>
		</Modal>
	);
}

function IconAction({
	label,
	icon: Icon,
	onClick,
	tone = "default",
}: {
	label: string;
	icon: typeof Trash2;
	onClick: () => void;
	tone?: "default" | "danger";
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			aria-label={label}
			title={label}
			className={cn(
				"flex h-8 w-8 items-center justify-center rounded-md transition-colors",
				tone === "danger"
					? "text-ink-3 hover:bg-danger/10 hover:text-danger"
					: "text-ink-3 hover:bg-paper-3 hover:text-ink",
			)}
		>
			<Icon className="h-4 w-4" />
		</button>
	);
}
