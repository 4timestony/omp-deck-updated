/**
 * Tasks + task-states REST surface.
 *
 * Mounted on the main router at `/api/tasks` and `/api/task-states`. All
 * payloads use the protocol types verbatim. Validation is intentionally light
 * — the schema enforces shape (FK, CHECK constraints), we surface DB errors
 * back as 400/500.
 */

import { Hono } from "hono";
import type {
	CreateTaskRequest,
	CreateTaskStateRequest,
	ListTasksResponse,
	MoveTaskRequest,
	TaskProject,
	UpdateTaskRequest,
	UpdateTaskStateRequest,
} from "@omp-deck/protocol";

import { logger } from "./log.ts";
import { broadcastBus } from "./broadcast-bus.ts";
import { deriveLabel } from "./workspace-label.ts";
import {
	createState,
	createTask,
	deleteState,
	deleteTask,
	getState,
	getTask,
	listStates,
	listTaskProjects,
	listTasks,
	moveTask,
	reorderStates,
	updateState,
	updateTask,
} from "./db/tasks.ts";

const log = logger("routes:tasks");

function notifyTasksChanged(): void {
	broadcastBus.broadcast({ type: "tasks_changed" });
}

/**
 * `cwd` must be absent, `null`, or a string — anything else (number, array,
 * object) would otherwise reach the DB layer and surface as a raw SQLite
 * driver TypeError instead of a clean 400.
 */
function cwdTypeError(value: unknown): string | undefined {
	if (value === undefined || value === null || typeof value === "string") return undefined;
	return "cwd must be a string";
}

export function buildTasksRouter(): Hono {
	const app = new Hono();

	// ─── Tasks ─────────────────────────────────────────────────────────────

	app.get("/tasks", (c) => {
		const includeArchived = c.req.query("includeArchived") === "1";
		// `?cwd=<path>` scopes the board to one project. `?cwd=` (present but
		// empty) selects the rows with no cwd recorded. Omitting the param
		// entirely returns every project, which is what pre-0.6.2 clients and
		// the routines/deck step already expect.
		const cwdParam = c.req.query("cwd");
		const cwd = cwdParam === undefined ? undefined : cwdParam === "" ? null : cwdParam;

		const tasks = listTasks({ includeArchived, cwd });
		const states = listStates();
		const projects: TaskProject[] = listTaskProjects({ includeArchived })
			.map((p) => ({
				cwd: p.cwd,
				label: p.cwd === null ? "Unassigned" : deriveLabel(p.cwd),
				taskCount: p.taskCount,
			}))
			// Named projects alphabetically; "Unassigned" pinned last so it reads
			// as the leftovers bucket it is. Ties break on the full path because
			// two checkouts of the same repo share a label.
			.sort((a, b) => {
				if (a.cwd === null) return 1;
				if (b.cwd === null) return -1;
				return a.label.localeCompare(b.label) || a.cwd.localeCompare(b.cwd);
			});

		const body: ListTasksResponse = { tasks, states, projects };
		return c.json(body);
	});

	app.post("/tasks", async (c) => {
		let body: CreateTaskRequest;
		try {
			body = (await c.req.json()) as CreateTaskRequest;
		} catch {
			return c.json({ error: "invalid json" }, 400);
		}
		if (!body.title || typeof body.title !== "string") {
			return c.json({ error: "title is required" }, 400);
		}
		const cwdError = cwdTypeError(body.cwd);
		if (cwdError) return c.json({ error: cwdError }, 400);
		try {
			const task = createTask(body);
			notifyTasksChanged();
			return c.json(task, 201);
		} catch (err) {
			log.error(`createTask failed`, err);
			return c.json({ error: String(err) }, 400);
		}
	});

	app.get("/tasks/:id", (c) => {
		const task = getTask(c.req.param("id"));
		if (!task) return c.json({ error: "not found" }, 404);
		return c.json(task);
	});

	app.patch("/tasks/:id", async (c) => {
		let body: UpdateTaskRequest;
		try {
			body = (await c.req.json()) as UpdateTaskRequest;
		} catch {
			return c.json({ error: "invalid json" }, 400);
		}
		const cwdError = cwdTypeError(body.cwd);
		if (cwdError) return c.json({ error: cwdError }, 400);
		try {
			const updated = updateTask(c.req.param("id"), body);
			if (!updated) return c.json({ error: "not found" }, 404);
			notifyTasksChanged();
			return c.json(updated);
		} catch (err) {
			log.error(`updateTask failed`, err);
			return c.json({ error: String(err) }, 400);
		}
	});

	app.delete("/tasks/:id", (c) => {
		const ok = deleteTask(c.req.param("id"));
		if (ok) notifyTasksChanged();
		return c.json({ ok });
	});

	app.post("/tasks/:id/move", async (c) => {
		let body: MoveTaskRequest;
		try {
			body = (await c.req.json()) as MoveTaskRequest;
		} catch {
			return c.json({ error: "invalid json" }, 400);
		}
		if (!body.stateId || typeof body.index !== "number") {
			return c.json({ error: "stateId and numeric index required" }, 400);
		}
		try {
			const moved = moveTask(c.req.param("id"), body.stateId, body.index);
			if (!moved) return c.json({ error: "task not found" }, 404);
			notifyTasksChanged();
			return c.json(moved);
		} catch (err) {
			log.error(`moveTask failed`, err);
			return c.json({ error: String(err) }, 400);
		}
	});

	// ─── States ────────────────────────────────────────────────────────────

	app.get("/task-states", (c) => c.json({ states: listStates() }));

	app.post("/task-states", async (c) => {
		let body: CreateTaskStateRequest;
		try {
			body = (await c.req.json()) as CreateTaskStateRequest;
		} catch {
			return c.json({ error: "invalid json" }, 400);
		}
		if (!body.name) return c.json({ error: "name required" }, 400);
		try {
			const state = createState(body);
			return c.json(state, 201);
		} catch (err) {
			log.error(`createState failed`, err);
			return c.json({ error: String(err) }, 400);
		}
	});

	app.post("/task-states/reorder", async (c) => {
		let body: { orderedIds?: unknown };
		try {
			body = (await c.req.json()) as { orderedIds?: unknown };
		} catch {
			return c.json({ error: "invalid json" }, 400);
		}
		if (!Array.isArray(body.orderedIds) || body.orderedIds.some((x) => typeof x !== "string")) {
			return c.json({ error: "orderedIds must be string[]" }, 400);
		}
		try {
			const states = reorderStates(body.orderedIds as string[]);
			notifyTasksChanged();
			return c.json({ states });
		} catch (err) {
			log.error(`reorderStates failed`, err);
			return c.json({ error: String(err) }, 400);
		}
	});

	app.patch("/task-states/:id", async (c) => {
		let body: UpdateTaskStateRequest;
		try {
			body = (await c.req.json()) as UpdateTaskStateRequest;
		} catch {
			return c.json({ error: "invalid json" }, 400);
		}
		const updated = updateState(c.req.param("id"), body);
		if (!updated) return c.json({ error: "not found" }, 404);
		return c.json(updated);
	});

	app.delete("/task-states/:id", (c) => {
		try {
			const result = deleteState(c.req.param("id"));
			return c.json(result);
		} catch (err) {
			return c.json({ error: String(err) }, 400);
		}
	});

	app.get("/task-states/:id", (c) => {
		const state = getState(c.req.param("id"));
		if (!state) return c.json({ error: "not found" }, 404);
		return c.json(state);
	});

	return app;
}
