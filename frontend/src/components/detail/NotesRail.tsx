import { useEffect, useRef, type ReactNode } from "react";
import Card from "../ui/Card";

interface NotesRailProps {
	title: string;
	state: "loading" | "empty" | "ready";
	/** The list rows; rendered only when state === "ready". */
	children?: ReactNode;
	composer: ReactNode;
	/** Newest note's id. When it changes, the list scrolls to top. */
	newestId?: string;
	/** A note is open for edit: footer hidden (still mounted, so the draft
	 *  survives) and the newest-note scroll is held. */
	editing?: boolean;
}

export default function NotesRail({ title, state, children, composer, newestId, editing = false }: NotesRailProps) {
	const listRef = useRef<HTMLDivElement>(null);
	const mounted = useRef(false);
	const editingRef = useRef(editing);
	editingRef.current = editing;

	useEffect(() => {
		if (!mounted.current) {
			mounted.current = true;
			return;
		}
		if (editingRef.current) return;
		listRef.current?.scrollTo({ top: 0 });
	}, [newestId]);

	return (
		<Card title={title} flush className="lg:h-full">
			<div
				ref={listRef}
				aria-busy={state === "loading" || undefined}
				className={`flex-1 min-h-0 overflow-y-auto p-4${state === "empty" ? " flex items-center justify-center" : ""}${state === "ready" ? " space-y-3" : ""}`}
			>
				{state === "loading" && (
					<div className="space-y-3">
						<div className="h-16 animate-pulse rounded-lg bg-surface" />
						<div className="h-16 animate-pulse rounded-lg bg-surface" />
					</div>
				)}
				{state === "empty" && <p role="status" className="text-sm text-text-muted">No notes yet.</p>}
				{state === "ready" && children}
			</div>
			<div hidden={editing || undefined} className="shrink-0 border-t border-border-subtle p-4">
				{composer}
			</div>
		</Card>
	);
}
