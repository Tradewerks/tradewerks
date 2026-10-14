export interface ChoiceChange {
	at: Date;
	old: Record<string, boolean>;
	next: Record<string, boolean>;
}

export interface OffWindow {
	off: Date;
	on: Date | null;
}

// A switch-on with no recorded switch-off before it (a module that was off since
// signup) opens no window: nothing was running that then stopped.
export function offWindows(
	changes: ChoiceChange[],
	moduleKey: string,
): OffWindow[] {
	const windows: OffWindow[] = [];
	let open: OffWindow | null = null;
	for (const c of [...changes].sort(
		(a, b) => a.at.getTime() - b.at.getTime(),
	)) {
		const was = c.old[moduleKey];
		const now = c.next[moduleKey];
		if (was === now) continue;
		if (was === true && now === false && !open) {
			open = { off: c.at, on: null };
			windows.push(open);
		} else if (now === true && open) {
			open.on = c.at;
			open = null;
		}
	}
	return windows;
}
