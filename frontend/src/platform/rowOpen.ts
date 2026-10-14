import { useCallback, type MouseEvent } from "react";
import { useNavigate } from "react-router-dom";

type RowClick = Pick<
	MouseEvent,
	"button" | "metaKey" | "ctrlKey" | "shiftKey" | "altKey" | "target"
>;

export function shouldOpenRow(ev: RowClick, selection: string): boolean {
	if (ev.button !== 0 || ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey) return false;
	if ((ev.target as HTMLElement).closest("a, button, input, label")) return false;
	// Finishing a drag-select fires a click; reading the text must not leave the page.
	return selection.length === 0;
}

export function useRowOpen() {
	const navigate = useNavigate();
	return useCallback(
		(ev: MouseEvent, path: string) => {
			if (shouldOpenRow(ev, window.getSelection()?.toString() ?? ""))
				navigate(path);
		},
		[navigate]
	);
}
