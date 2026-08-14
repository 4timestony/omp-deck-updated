/**
 * Which project the kanban board is currently scoped to.
 *
 * Kept as a tagged union rather than `string | null | undefined` because the
 * three states are genuinely different and a bare `null` in component props
 * reads as "not loaded yet" to every future maintainer.
 */
export type ProjectFilter =
	| { kind: "all" }
	| { kind: "unassigned" }
	| { kind: "cwd"; cwd: string };

export const ALL_PROJECTS: ProjectFilter = { kind: "all" };

const STORAGE_KEY = "omp-deck:kanban-project";

/** Every real project key carries this prefix, so it can never be mistaken
 *  for one of the two bare sentinels below — even for a cwd literally named
 *  "all". */
const CWD_PREFIX = "cwd:";
const KEY_ALL = "all";
const KEY_UNASSIGNED = "unassigned";

/**
 * Translate a filter into the `cwd` query param for `GET /api/tasks`:
 * `undefined` omits the param (all projects), `null` sends `?cwd=`
 * (unassigned), a string sends the path.
 */
export function toQueryCwd(filter: ProjectFilter): string | null | undefined {
	switch (filter.kind) {
		case "all":
			return undefined;
		case "unassigned":
			return null;
		case "cwd":
			return filter.cwd;
	}
}

/** Stable string key for `<select>` values, React keys, and localStorage. */
export function filterKey(filter: ProjectFilter): string {
	switch (filter.kind) {
		case "all":
			return KEY_ALL;
		case "unassigned":
			return KEY_UNASSIGNED;
		case "cwd":
			return `${CWD_PREFIX}${filter.cwd}`;
	}
}

/** Inverse of `filterKey`. Unknown input falls back to "all". */
export function filterFromKey(key: string): ProjectFilter {
	if (key.startsWith(CWD_PREFIX)) return { kind: "cwd", cwd: key.slice(CWD_PREFIX.length) };
	if (key === KEY_UNASSIGNED) return { kind: "unassigned" };
	return ALL_PROJECTS;
}

/**
 * Read the persisted selection. Selection lives in localStorage rather than
 * the server so two browser tabs can sit on different projects — which is the
 * whole point of having projects.
 */
export function loadProjectFilter(): ProjectFilter {
	try {
		const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
		if (!raw) return ALL_PROJECTS;
		return filterFromKey(raw);
	} catch {
		// Private-mode / disabled storage: scoping still works for the session.
		return ALL_PROJECTS;
	}
}

export function saveProjectFilter(filter: ProjectFilter): void {
	try {
		globalThis.localStorage?.setItem(STORAGE_KEY, filterKey(filter));
	} catch {
		// Non-fatal: the board just forgets the selection on reload.
	}
}
