/** A keystroke that belongs to whatever the user is typing in, not to the surface around it. */
export function isTypingKeystroke(e: KeyboardEvent): boolean {
	if (e.metaKey || e.ctrlKey || e.altKey) return true;
	const el = e.target as HTMLElement | null;
	if (!el) return false;
	return /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.isContentEditable;
}
