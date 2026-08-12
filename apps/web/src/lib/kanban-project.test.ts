import { describe, expect, test } from "bun:test";

import {
	ALL_PROJECTS,
	filterFromKey,
	filterKey,
	toQueryCwd,
	type ProjectFilter,
} from "./kanban-project";

describe("toQueryCwd", () => {
	test("all projects omits the param", () => {
		expect(toQueryCwd(ALL_PROJECTS)).toBeUndefined();
	});

	test("unassigned sends an explicit null", () => {
		expect(toQueryCwd({ kind: "unassigned" })).toBeNull();
	});

	test("a project sends its path", () => {
		expect(toQueryCwd({ kind: "cwd", cwd: "/repos/alpha" })).toBe("/repos/alpha");
	});
});

describe("filterKey / filterFromKey", () => {
	const cases: ProjectFilter[] = [
		ALL_PROJECTS,
		{ kind: "unassigned" },
		{ kind: "cwd", cwd: "/repos/alpha" },
		// A path that could collide with the sentinels if they were naive.
		{ kind: "cwd", cwd: "all" },
		{ kind: "cwd", cwd: "unassigned" },
	];

	for (const filter of cases) {
		test(`round-trips ${JSON.stringify(filter)}`, () => {
			expect(filterFromKey(filterKey(filter))).toEqual(filter);
		});
	}

	test("unknown or empty keys fall back to all projects", () => {
		expect(filterFromKey("")).toEqual(ALL_PROJECTS);
		expect(filterFromKey("garbage-from-an-older-build")).toEqual(ALL_PROJECTS);
	});

	test("project keys are prefixed so they cannot collide with the sentinels", () => {
		expect(filterKey({ kind: "cwd", cwd: "all" })).not.toBe(filterKey(ALL_PROJECTS));
		expect(filterKey({ kind: "cwd", cwd: "unassigned" })).not.toBe(
			filterKey({ kind: "unassigned" }),
		);
	});

	test("keys contain no control characters (they land in DOM attributes)", () => {
		// Built from escapes rather than a literal range so the source file can
		// never itself contain the bytes under test.
		const CONTROL = new RegExp("[\\u0000-\\u001f]");
		for (const filter of cases) {
			expect(CONTROL.test(filterKey(filter))).toBe(false);
		}
	});
});
