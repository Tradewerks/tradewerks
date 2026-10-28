import { useCallback, useEffect, useRef, useState } from "react";

export interface NoteEditSession {
	editingId: string | null;
	start: (id: string) => void;
	/** Closes the editor; focus returns to that note's edit button. */
	stop: () => void;
	/** True when a different note is open for edit. */
	isLocked: (id: string) => boolean;
	editButtonRef: (id: string) => (el: HTMLButtonElement | null) => void;
}

/**
 * One-note-at-a-time edit state for a notes rail. `liveIds` is the rendered
 * list: if the edited note leaves it (deleted elsewhere), the session closes
 * so the hidden composer comes back.
 */
export function useNoteEditSession(liveIds: string[]): NoteEditSession {
	const [editingId, setEditingId] = useState<string | null>(null);
	const buttons = useRef(new Map<string, HTMLButtonElement>());
	const focusAfterClose = useRef<string | null>(null);

	const start = useCallback((id: string) => setEditingId(id), []);

	const stop = useCallback(() => {
		setEditingId((current) => {
			focusAfterClose.current = current;
			return null;
		});
	}, []);

	const isLocked = useCallback(
		(id: string) => editingId !== null && editingId !== id,
		[editingId]
	);

	const editButtonRef = useCallback(
		(id: string) => (el: HTMLButtonElement | null) => {
			if (el) buttons.current.set(id, el);
			else buttons.current.delete(id);
		},
		[]
	);

	// The view card (and its button) remounts on close, so focus waits for
	// the commit that re-registers it.
	useEffect(() => {
		if (editingId !== null || focusAfterClose.current === null) return;
		buttons.current.get(focusAfterClose.current)?.focus();
		focusAfterClose.current = null;
	}, [editingId]);

	const liveKey = liveIds.join("\u0000");
	useEffect(() => {
		if (editingId !== null && !liveIds.includes(editingId)) setEditingId(null);
		// liveKey stands in for liveIds, which is a fresh array every render.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [editingId, liveKey]);

	return { editingId, start, stop, isLocked, editButtonRef };
}
