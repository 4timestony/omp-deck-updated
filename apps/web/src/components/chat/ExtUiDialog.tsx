/**
 * Modal renderer for SDK extension-UI dialogs (the `ask` tool surface +
 * generic `ctx.ui.*` calls from extensions).
 *
 * Mounted at chat surface; subscribed via the store to `ext_ui_dialog_open`
 * frames for the active session only. Submits answers as
 * `ext_ui_dialog_response`. Esc cancels.
 *
 * Multi-question `ask` flows arrive as a sequence of single-select dialogs —
 * the SDK awaits each one before sending the next, so a single-modal-per-
 * session UX is sufficient for v1.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { ServerFrame } from "@omp-deck/protocol";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { useStore } from "@/lib/store";

type OpenFrame = Extract<ServerFrame, { type: "ext_ui_dialog_open" }>;

const OTHER_OPTION_SENTINEL = "__omp_deck_other__";

export function ExtUiDialog(): JSX.Element | null {
	const activeId = useStore((s) => s.activeId);
	const dialog = useStore((s) => (activeId ? s.pendingDialogs[activeId] : undefined));
	const respond = useStore((s) => s.respondToExtUiDialog);

	if (!dialog || !activeId) return null;

	return (
		<DialogBody
			key={dialog.dialogId}
			sessionId={activeId}
			dialog={dialog}
			onRespond={respond}
		/>
	);
}

interface BodyProps {
	sessionId: string;
	dialog: OpenFrame;
	onRespond: (
		sessionId: string,
		dialogId: string,
		response: { value?: string; values?: string[]; confirmed?: boolean; cancelled?: true },
	) => void;
}

function DialogBody({ sessionId, dialog, onRespond }: BodyProps): JSX.Element {
	const cancel = (): void => onRespond(sessionId, dialog.dialogId, { cancelled: true });

	return (
		<Modal open onClose={cancel} widthClass="max-w-lg">
			<div className="flex flex-col gap-4 p-5">
				<header className="flex flex-col gap-1">
					<div className="font-mono text-2xs uppercase tracking-meta text-ink-3">
						Agent question
					</div>
					<h2 className="text-base font-semibold text-ink">{dialog.prompt}</h2>
					{dialog.kind === "confirm" && dialog.message ? (
						<p className="text-sm text-ink-2">{dialog.message}</p>
					) : null}
					{dialog.helpText ? (
						<p className="text-2xs text-ink-3">{dialog.helpText}</p>
					) : null}
				</header>

				{dialog.kind === "select" ? (
					<SelectBody
						dialog={dialog}
						onSubmit={(value) => onRespond(sessionId, dialog.dialogId, { value })}
						onCancel={cancel}
					/>
				) : null}

				{dialog.kind === "editor" ? (
					<EditorBody
						dialog={dialog}
						onSubmit={(value) => onRespond(sessionId, dialog.dialogId, { value })}
						onCancel={cancel}
					/>
				) : null}

				{dialog.kind === "input" ? (
					<InputBody
						dialog={dialog}
						onSubmit={(value) => onRespond(sessionId, dialog.dialogId, { value })}
						onCancel={cancel}
					/>
				) : null}

				{dialog.kind === "confirm" ? (
					<ConfirmBody
						onConfirm={() => onRespond(sessionId, dialog.dialogId, { confirmed: true })}
						onDeny={() => onRespond(sessionId, dialog.dialogId, { confirmed: false })}
					/>
				) : null}
			</div>
		</Modal>
	);
}

// ─── kind: "select" ────────────────────────────────────────────────────────

interface SelectBodyProps {
	dialog: OpenFrame;
	onSubmit: (value: string) => void;
	onCancel: () => void;
}

/**
 * Radio list with optional "(Recommended)" marker and free-form
 * "Other (type your own)" input. Mirrors the TUI's `ask` UX so users coming
 * from `omp` see the same options.
 *
 * SDK 17: each option is normalized by the bridge to `{ label; description?
 * }` (was a bare string). Selection state tracks the option object itself
 * (not the label) since labels can collide — reference equality against the
 * `dialog.options` array element disambiguates duplicates. The submitted
 * value is still `opt.label`, matching the `select()` contract.
 */
function SelectBody({ dialog, onSubmit, onCancel }: SelectBodyProps): JSX.Element {
	const options = dialog.options ?? [];
	const initial = useMemo(() => {
		if (typeof dialog.initialIndex === "number") return options[dialog.initialIndex];
		if (typeof dialog.recommended === "number") return options[dialog.recommended];
		return options[0];
	}, [dialog.initialIndex, dialog.recommended, options]);

	type SelectOption = NonNullable<OpenFrame["options"]>[number];
	const [selection, setSelection] = useState<SelectOption | typeof OTHER_OPTION_SENTINEL | undefined>(initial);
	const [customValue, setCustomValue] = useState("");
	const customRef = useRef<HTMLInputElement>(null);
	const isCustom = selection === OTHER_OPTION_SENTINEL;

	// Auto-focus the custom input when the user selects "Other".
	useEffect(() => {
		if (isCustom) customRef.current?.focus();
	}, [isCustom]);

	function submit(): void {
		if (isCustom) {
			const v = customValue.trim();
			if (!v) return;
			onSubmit(v);
			return;
		}
		if (selection === undefined) return;
		onSubmit(selection.label);
	}

	return (
		<form
			className="flex flex-col gap-3"
			onSubmit={(e) => {
				e.preventDefault();
				submit();
			}}
		>
			<div className="flex flex-col gap-1.5">
				{options.map((opt, idx) => {
					const isRecommended = idx === dialog.recommended;
					return (
						<label
							key={`${opt.label}-${idx}`}
							className="flex cursor-pointer items-center gap-2 rounded border border-line/60 px-2.5 py-1.5 text-sm text-ink hover:border-line"
						>
							<input
								type="radio"
								name="ext-ui-select"
								value={opt.label}
								checked={selection === opt}
								onChange={() => setSelection(opt)}
							/>
							<span className="flex-1">
								<span>{opt.label}</span>
								{opt.description ? (
									<span className="block text-2xs text-ink-3">{opt.description}</span>
								) : null}
							</span>
							{isRecommended ? (
								<span className="font-mono text-2xs uppercase tracking-meta text-accent">
									Recommended
								</span>
							) : null}
						</label>
					);
				})}
				<label className="flex cursor-pointer items-center gap-2 rounded border border-line/60 px-2.5 py-1.5 text-sm text-ink hover:border-line">
					<input
						type="radio"
						name="ext-ui-select"
						value={OTHER_OPTION_SENTINEL}
						checked={isCustom}
						onChange={() => setSelection(OTHER_OPTION_SENTINEL)}
					/>
					<span className="text-ink-3">Other (type your own)</span>
				</label>
				{isCustom ? (
					<input
						ref={customRef}
						type="text"
						value={customValue}
						onChange={(e) => setCustomValue(e.target.value)}
						placeholder="Custom answer"
						className="rounded border border-line bg-paper px-2 py-1.5 font-mono text-2xs"
					/>
				) : null}
			</div>
			<DialogFooter
				submitLabel="Send"
				disabled={isCustom ? !customValue.trim() : selection === undefined}
				onCancel={onCancel}
			/>
		</form>
	);
}

// ─── kind: "editor" ────────────────────────────────────────────────────────

interface EditorBodyProps {
	dialog: OpenFrame;
	onSubmit: (value: string) => void;
	onCancel: () => void;
}

function EditorBody({ dialog, onSubmit, onCancel }: EditorBodyProps): JSX.Element {
	const [value, setValue] = useState(dialog.prefill ?? "");
	const taRef = useRef<HTMLTextAreaElement>(null);

	useEffect(() => {
		taRef.current?.focus();
		// Place cursor at end of prefill so the user can append.
		if (taRef.current) {
			const len = taRef.current.value.length;
			taRef.current.setSelectionRange(len, len);
		}
	}, []);

	return (
		<form
			className="flex flex-col gap-3"
			onSubmit={(e) => {
				e.preventDefault();
				onSubmit(value);
			}}
		>
			<textarea
				ref={taRef}
				value={value}
				onChange={(e) => setValue(e.target.value)}
				onKeyDown={(e) => {
					// Ctrl/Cmd+Enter submits, plain Enter inserts newline.
					if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
						e.preventDefault();
						onSubmit(value);
					}
				}}
				rows={8}
				className="min-h-32 resize-y rounded border border-line bg-paper px-3 py-2 font-mono text-2xs leading-relaxed text-ink focus:border-accent focus:outline-none"
			/>
			<DialogFooter
				submitLabel="Send"
				hint="Ctrl/Cmd+Enter to send"
				disabled={false}
				onCancel={onCancel}
			/>
		</form>
	);
}

// ─── kind: "input" ─────────────────────────────────────────────────────────

interface InputBodyProps {
	dialog: OpenFrame;
	onSubmit: (value: string) => void;
	onCancel: () => void;
}

function InputBody({ dialog, onSubmit, onCancel }: InputBodyProps): JSX.Element {
	const [value, setValue] = useState("");
	return (
		<form
			className="flex flex-col gap-3"
			onSubmit={(e) => {
				e.preventDefault();
				if (!value.trim()) return;
				onSubmit(value);
			}}
		>
			<input
				type="text"
				value={value}
				onChange={(e) => setValue(e.target.value)}
				placeholder={dialog.placeholder ?? ""}
				className="rounded border border-line bg-paper px-2 py-1.5 font-mono text-2xs"
				// biome-ignore lint/a11y/noAutofocus: modal opens for explicit user attention
				autoFocus
			/>
			<DialogFooter submitLabel="Send" disabled={!value.trim()} onCancel={onCancel} />
		</form>
	);
}

// ─── kind: "confirm" ───────────────────────────────────────────────────────

interface ConfirmBodyProps {
	onConfirm: () => void;
	onDeny: () => void;
}

function ConfirmBody({ onConfirm, onDeny }: ConfirmBodyProps): JSX.Element {
	return (
		<div className="flex justify-end gap-2 border-t border-line pt-3">
			<Button variant="ghost" onClick={onDeny}>
				No
			</Button>
			<Button variant="primary" onClick={onConfirm}>
				Yes
			</Button>
		</div>
	);
}

// ─── Shared footer ─────────────────────────────────────────────────────────

interface FooterProps {
	submitLabel: string;
	disabled: boolean;
	onCancel: () => void;
	hint?: string;
}

function DialogFooter({ submitLabel, disabled, onCancel, hint }: FooterProps): JSX.Element {
	return (
		<div className="flex items-center justify-between gap-2 border-t border-line pt-3">
			{hint ? <span className="font-mono text-2xs text-ink-3">{hint}</span> : <span />}
			<div className="flex gap-2">
				<Button variant="ghost" type="button" onClick={onCancel}>
					Cancel
				</Button>
				<Button variant="primary" type="submit" disabled={disabled}>
					{submitLabel}
				</Button>
			</div>
		</div>
	);
}
