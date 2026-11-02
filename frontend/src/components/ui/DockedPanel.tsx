import { useId, useRef, type ReactNode } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { useGutterPanel } from "../../hooks/useGutterPanel";

// One width for every docked panel: narrow enough to leave most of a laptop
// list visible while open, and to fit the side gutter on the widest monitors.
export const DOCKED_PANEL_OPEN_WIDTH = 320;

interface DockedPanelProps {
	// Names the panel for the toggle ("Expand stock status").
	label: string;
	// The w-12 rail shown while collapsed: status icons and counts.
	rail: ReactNode;
	children: ReactNode;
}

/**
 * Persistent right-edge panel under the app header, for status the dispatcher
 * glances at while still working the page. Non-modal: no backdrop, no focus
 * trap, and collapsed it stays as a w-12 rail. Blocking overlay for a single
 * task (edit, pick, configure)? Use Drawer instead.
 *
 * It overlays the page and never pushes it: a dispatcher opens it to read the
 * extra detail, then closes it. It opens by default only where the side gutter
 * already holds it. Pages keep `mr-7` on their scroller to clear the collapsed rail.
 */
export default function DockedPanel({ label, rail, children }: DockedPanelProps) {
	const { isCollapsed, toggle } = useGutterPanel(DOCKED_PANEL_OPEN_WIDTH);
	const panelId = useId();
	const toggleRef = useRef<HTMLButtonElement>(null);

	return (
		<div
			className={`fixed top-14 right-0 z-40 h-[calc(100vh-3.5rem)] border-l border-border/50 bg-base/95 shadow-2xl shadow-black/50 backdrop-blur-sm transition-[width] duration-200 ease-out ${
				isCollapsed ? "w-12" : "w-80"
			}`}
			onKeyDown={(e) => {
				if (e.key === "Escape" && !isCollapsed) {
					e.stopPropagation();
					toggle();
					toggleRef.current?.focus();
				}
			}}
		>
			<button
				ref={toggleRef}
				type="button"
				onClick={(e) => {
					// Safari doesn't focus a clicked button; Esc needs focus inside the drawer.
					e.currentTarget.focus();
					toggle();
				}}
				aria-expanded={!isCollapsed}
				aria-controls={panelId}
				aria-label={`${isCollapsed ? "Expand" : "Collapse"} ${label.toLowerCase()}`}
				className="absolute -left-3 top-1/2 z-50 -translate-y-1/2 rounded-full border border-border-strong bg-surface p-1.5 text-text-secondary shadow-lg transition-colors hover:cursor-pointer hover:bg-surface-raised hover:text-text-primary"
			>
				{isCollapsed ? <ChevronLeft size={14} /> : <ChevronRight size={14} />}
			</button>

			<div id={panelId} role="region" aria-label={label} className="h-full">
				{isCollapsed ? (
					<div className="flex flex-col items-center gap-2 pt-4">{rail}</div>
				) : (
					<div className="flex h-full flex-col overflow-hidden">{children}</div>
				)}
			</div>
		</div>
	);
}
