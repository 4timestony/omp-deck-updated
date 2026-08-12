/**
 * Display-label derivation for a working directory.
 *
 * Shared so a repo renders under the same name everywhere: the session
 * workspace picker (`GET /workspaces`) and the kanban project switcher
 * (`GET /api/tasks` → `projects[]`) both call this.
 */
export function deriveLabel(cwd: string): string {
	if (!cwd) return "(unknown)";
	const parts = cwd.split(/[\\/]/).filter(Boolean);
	return parts[parts.length - 1] ?? cwd;
}
