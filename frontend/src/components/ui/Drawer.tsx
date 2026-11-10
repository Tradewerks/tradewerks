import { useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { useDialogA11y } from "../../hooks/useDialogA11y";

interface DrawerProps {
	isOpen: boolean;
	onClose: () => void;
	title: string;
	/**
	 * "right" (default) is the desk-side drawer — unchanged from before this
	 * prop existed. "bottom" is the field/mobile sheet: thumb-reachable, capped
	 * at 85vh so the underlying list stays visible above it. "center" is a
	 * centered modal card (fade + scale, no anchored edge) for content that
	 * reads better as a focused dialog than an edge-anchored sheet.
	 */
	side?: "right" | "bottom" | "center";
	children: ReactNode;
	footer?: ReactNode;
}

// Blocking overlay: backdrop, focus trap, Esc closes, unmounts when closed.
// Persistent side panel the page keeps working beside? Use DockedPanel instead.
const baseClasses = "bg-surface border-border-card shadow-xl flex flex-col duration-200 ease-out";

export default function Drawer({ isOpen, onClose, title, side = "right", children, footer }: DrawerProps) {
	const [mounted, setMounted] = useState(false);
	const [visible, setVisible] = useState(false);
	// Gated on `mounted`, not `isOpen` — `isOpen` flips a render before
	// `mounted` does (below), and the hook's initial-focus effect would then
	// fire before the dialog exists in the DOM. See useDialogA11y's docstring.
	const dialogA11y = useDialogA11y<HTMLDivElement>(onClose, mounted);

	useEffect(() => {
		if (isOpen) {
			setMounted(true);
			const id = setTimeout(() => setVisible(true), 10);
			return () => clearTimeout(id);
		}
		setVisible(false);
		const id = setTimeout(() => setMounted(false), 200);
		return () => clearTimeout(id);
	}, [isOpen]);

	if (!mounted) return null;

	const panel = (
		<div
			{...dialogA11y}
			aria-label={title}
			onMouseDown={(e) => e.stopPropagation()}
			className={
				side === "bottom"
					? `absolute bottom-0 inset-x-0 max-h-[85vh] border-t rounded-t-xl transition-transform ${baseClasses} ${
							visible ? "translate-y-0" : "translate-y-full"
						}`
					: side === "center"
						? `w-full max-w-lg max-h-[85vh] border rounded-xl transition-[opacity,transform] ${baseClasses} ${
								visible
									? "opacity-100 scale-100"
									: "opacity-0 scale-95"
							}`
						: `absolute top-0 right-0 h-full w-[calc(100%-2rem)] sm:w-[clamp(340px,32vw,420px)] border-l transition-transform ${baseClasses} ${
								visible ? "translate-x-0" : "translate-x-full"
							}`
			}
		>
			<div className="flex items-center justify-between px-5 py-4 border-b border-border-subtle shrink-0">
				<h2 className="text-base font-semibold text-text-primary">
					{title}
				</h2>
				<button
					onClick={onClose}
					aria-label="Close"
					className="text-text-muted hover:text-text-primary p-1 -mr-1 rounded-md hover:bg-surface-raised transition-colors"
				>
					<X size={16} />
				</button>
			</div>
			<div className="flex-1 overflow-y-auto">{children}</div>
			{footer && (
				<div className="shrink-0 border-t border-border-subtle px-5 py-3">{footer}</div>
			)}
		</div>
	);

	return createPortal(
		<div className="fixed inset-0 z-[5000]">
			<div
				onMouseDown={onClose}
				className={`absolute inset-0 bg-overlay transition-opacity duration-200 ${
					visible ? "opacity-100" : "opacity-0"
				}`}
			/>
			{side === "center" ? (
				<div
					onMouseDown={onClose}
					className="absolute inset-0 flex items-center justify-center p-4"
				>
					{panel}
				</div>
			) : (
				panel
			)}
		</div>,
		document.body
	);
}
