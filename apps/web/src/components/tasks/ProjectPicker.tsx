import type { TaskProject } from "@omp-deck/protocol";

import {
	ALL_PROJECTS,
	filterFromKey,
	filterKey,
	type ProjectFilter,
} from "@/lib/kanban-project";

interface Props {
	projects: TaskProject[];
	value: ProjectFilter;
	onChange: (next: ProjectFilter) => void;
}

/**
 * Project scope selector for the kanban header.
 *
 * Options come from the server's unfiltered project list, so a project stays
 * selectable while you are looking at a different one. The current selection
 * is injected even when it holds zero live tasks, otherwise emptying a board
 * would silently bounce you back to "All projects".
 */
export function ProjectPicker({ projects, value, onChange }: Props) {
	const options = [...projects];
	if (value.kind === "cwd" && !options.some((p) => p.cwd === value.cwd)) {
		options.push({ cwd: value.cwd, label: labelForPath(value.cwd), taskCount: 0 });
	}
	if (value.kind === "unassigned" && !options.some((p) => p.cwd === null)) {
		options.push({ cwd: null, label: "Unassigned", taskCount: 0 });
	}

	const total = projects.reduce((n, p) => n + p.taskCount, 0);

	return (
		<select
			value={filterKey(value)}
			onChange={(e) => onChange(filterFromKey(e.target.value))}
			className="field h-7 max-w-[16rem] px-2 font-mono text-2xs"
			title={value.kind === "cwd" ? value.cwd : undefined}
			aria-label="Project"
		>
			<option value={filterKey(ALL_PROJECTS)}>All projects · {total}</option>
			{options.map((p) => {
				const key = filterKey(
					p.cwd === null ? { kind: "unassigned" } : { kind: "cwd", cwd: p.cwd },
				);
				return (
					<option key={key} value={key}>
						{p.label} · {p.taskCount}
					</option>
				);
			})}
		</select>
	);
}

function labelForPath(cwd: string): string {
	const parts = cwd.split(/[\\/]/).filter(Boolean);
	return parts[parts.length - 1] ?? cwd;
}
