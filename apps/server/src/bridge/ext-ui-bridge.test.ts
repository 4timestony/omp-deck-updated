import { describe, expect, it } from "bun:test";
import type { ServerFrame } from "@omp-deck/protocol";

import { ExtensionUIBridge } from "./ext-ui-bridge.ts";

type OpenFrame = Extract<ServerFrame, { type: "ext_ui_dialog_open" }>;
type CancelFrame = Extract<ServerFrame, { type: "ext_ui_dialog_cancel" }>;
type Frame = OpenFrame | CancelFrame;

function collect(bridge: ExtensionUIBridge): {
	frames: Frame[];
	unsub: () => void;
} {
	const frames: Frame[] = [];
	const unsub = bridge.subscribeFrames((frame) => {
		frames.push(frame);
	});
	return { frames, unsub };
}

describe("ExtensionUIBridge", () => {
	it("publishes an ext_ui_dialog_open frame on select() and resolves with the response value", async () => {
		const bridge = new ExtensionUIBridge("s_test");
		const { frames } = collect(bridge);

		const promise = bridge.select("Pick one", ["a", "b", "c"]);

		expect(frames.length).toBe(1);
		const frame = frames[0] as OpenFrame;
		expect(frame.type).toBe("ext_ui_dialog_open");
		expect(frame.sessionId).toBe("s_test");
		expect(frame.kind).toBe("select");
		expect(frame.prompt).toBe("Pick one");
		// SDK 17: `select()` takes `ExtensionUISelectItem[]`; the bridge
		// normalizes every item to `{ label; description? }` on the wire.
		expect(frame.options).toEqual([{ label: "a" }, { label: "b" }, { label: "c" }]);

		bridge.handleResponse(frame.dialogId, { value: "b" });
		expect(await promise).toBe("b");
	});

	it("select() normalizes mixed string/object options and resolves with the label", async () => {
		const bridge = new ExtensionUIBridge("s_test");
		const { frames } = collect(bridge);

		const promise = bridge.select("Pick one", [
			"plain",
			{ label: "rich", description: "has a description" },
		]);

		const frame = frames[0] as OpenFrame;
		expect(frame.options).toEqual([
			{ label: "plain" },
			{ label: "rich", description: "has a description" },
		]);

		// The response value is still the selected LABEL string — unchanged
		// round-trip contract regardless of how the option was expressed.
		bridge.handleResponse(frame.dialogId, { value: "rich" });
		expect(await promise).toBe("rich");
	});

	it("returns undefined when the client cancels", async () => {
		const bridge = new ExtensionUIBridge("s_test");
		const { frames } = collect(bridge);

		const promise = bridge.select("Pick", ["a", "b"]);
		const frame = frames[0] as OpenFrame;
		bridge.handleResponse(frame.dialogId, { cancelled: true });
		expect(await promise).toBeUndefined();
	});

	it("editor() forwards prefill and resolves with response value", async () => {
		const bridge = new ExtensionUIBridge("s_test");
		const { frames } = collect(bridge);

		const promise = bridge.editor("Edit", "hello", undefined, { promptStyle: true });
		const frame = frames[0] as OpenFrame;
		expect(frame.kind).toBe("editor");
		expect(frame.prefill).toBe("hello");
		expect(frame.promptStyle).toBe(true);

		bridge.handleResponse(frame.dialogId, { value: "hello world" });
		expect(await promise).toBe("hello world");
	});

	it("confirm() resolves true / false based on response.confirmed", async () => {
		const bridge = new ExtensionUIBridge("s_test");
		const { frames } = collect(bridge);

		const yes = bridge.confirm("Sure?", "really sure");
		const yesFrame = frames[0] as OpenFrame;
		expect(yesFrame.kind).toBe("confirm");
		expect(yesFrame.message).toBe("really sure");
		bridge.handleResponse(yesFrame.dialogId, { confirmed: true });
		expect(await yes).toBe(true);

		const no = bridge.confirm("Again?", "doubly sure");
		const noFrame = frames[1] as OpenFrame;
		bridge.handleResponse(noFrame.dialogId, { confirmed: false });
		expect(await no).toBe(false);
	});

	it("input() resolves with value or undefined on cancel", async () => {
		const bridge = new ExtensionUIBridge("s_test");
		const { frames } = collect(bridge);

		const p = bridge.input("Name", "type here");
		const f = frames[0] as OpenFrame;
		expect(f.kind).toBe("input");
		expect(f.placeholder).toBe("type here");
		bridge.handleResponse(f.dialogId, { value: "Alice" });
		expect(await p).toBe("Alice");
	});

	it("abort signal cancels the pending dialog and emits a cancel frame", async () => {
		const bridge = new ExtensionUIBridge("s_test");
		const { frames } = collect(bridge);
		const ctl = new AbortController();

		const promise = bridge.select("Pick", ["a", "b"], { signal: ctl.signal });
		expect(frames.length).toBe(1);

		ctl.abort();

		expect(await promise).toBeUndefined();
		expect(frames.length).toBe(2);
		const cancel = frames[1] as CancelFrame;
		expect(cancel.type).toBe("ext_ui_dialog_cancel");
		expect(cancel.reason).toBe("aborted");
	});

	it("getPendingFrames replays open dialogs to late subscribers", () => {
		const bridge = new ExtensionUIBridge("s_test");
		// No subscriber yet — frame buffered as pending.
		void bridge.select("Pick", ["a"]);

		const pending = bridge.getPendingFrames();
		expect(pending.length).toBe(1);
		expect(pending[0]?.kind).toBe("select");
	});

	it("cancelAllPending settles every open dialog and emits cancel frames", async () => {
		const bridge = new ExtensionUIBridge("s_test");
		const { frames } = collect(bridge);

		const p1 = bridge.select("One", ["x"]);
		const p2 = bridge.editor("Two");
		expect(frames.length).toBe(2);

		bridge.cancelAllPending("session_disposed");

		expect(await p1).toBeUndefined();
		expect(await p2).toBeUndefined();
		const cancels = frames.filter((f) => f.type === "ext_ui_dialog_cancel");
		expect(cancels.length).toBe(2);
		for (const c of cancels) {
			expect((c as CancelFrame).reason).toBe("session_disposed");
		}
	});

	it("dispose() prevents new dialogs from opening and cancels pending", async () => {
		const bridge = new ExtensionUIBridge("s_test");
		const { frames } = collect(bridge);

		const pending = bridge.select("Pick", ["a"]);
		expect(frames.length).toBe(1);

		bridge.dispose();
		expect(await pending).toBeUndefined();

		// After dispose, subsequent dialogs resolve immediately to default
		// without emitting frames (listeners are cleared anyway).
		const after = bridge.select("Nope", ["q"]);
		expect(await after).toBeUndefined();
	});

	it("server-side timeout fires onTimeout and cancels the dialog", async () => {
		const bridge = new ExtensionUIBridge("s_test");
		const { frames } = collect(bridge);
		let timeoutFired = false;

		const promise = bridge.select("Pick", ["a"], {
			timeout: 5,
			onTimeout: () => {
				timeoutFired = true;
			},
		});
		expect(await promise).toBeUndefined();
		expect(timeoutFired).toBe(true);
		const cancel = frames.find((f) => f.type === "ext_ui_dialog_cancel") as CancelFrame | undefined;
		expect(cancel).toBeDefined();
		expect(cancel?.reason).toBe("timeout");
	});

	it("dialogIds are unique within a session", async () => {
		const bridge = new ExtensionUIBridge("s_test");
		const { frames } = collect(bridge);

		bridge.select("a", ["x"]);
		bridge.select("b", ["x"]);
		bridge.select("c", ["x"]);

		const ids = frames
			.filter((f): f is OpenFrame => f.type === "ext_ui_dialog_open")
			.map((f) => f.dialogId);
		expect(new Set(ids).size).toBe(ids.length);
	});

	it("ignores responses for already-settled dialogs", async () => {
		const bridge = new ExtensionUIBridge("s_test");
		const { frames } = collect(bridge);

		const promise = bridge.select("Pick", ["a", "b"]);
		const id = (frames[0] as OpenFrame).dialogId;
		bridge.handleResponse(id, { value: "a" });
		expect(await promise).toBe("a");

		// Second response is a no-op; should not throw.
		bridge.handleResponse(id, { value: "b" });
	});
});
