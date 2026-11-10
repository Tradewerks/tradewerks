import { useState, useRef, useEffect } from "react";
import { Loader2, ChevronDown, AlertTriangle } from "lucide-react";

// ============================================================================
// SHARED PRIMITIVES
// ============================================================================

export const inputBase =
	"w-full rounded-md border border-border bg-surface px-3 py-1.5 text-sm text-text-primary placeholder:text-faint outline-none transition-colors focus:border-primary focus:ring-1 focus:ring-primary-border";

export const labelBase = "mb-1 block text-xs font-medium text-text-tertiary";

// ============================================================================
// DEACTIVATE CONFIRMATION MODAL
// ============================================================================

interface DeactivateModalProps {
	title: string;
	body: string;
	warning?: string;
	isPending: boolean;
	onConfirm: () => void;
	onCancel: () => void;
}

export function DeactivateModal({ title, body, warning, isPending, onConfirm, onCancel }: DeactivateModalProps) {
	return (
		<div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
			<div
				role="dialog"
				aria-modal="true"
				aria-labelledby="deactivate-modal-title"
				className="w-full max-w-sm rounded-lg border border-border bg-base shadow-xl"
			>
				<div className="border-b border-border-subtle px-5 py-4">
					<h3 id="deactivate-modal-title" className="text-sm font-semibold text-text-primary">{title}</h3>
				</div>
				<div className="px-5 py-4 space-y-3">
					<p className="text-sm text-text-secondary">{body}</p>
					{warning && (
						<div className="flex items-start gap-2 rounded-md border border-warning-border bg-warning-bg px-3 py-2.5">
							<AlertTriangle size={14} className="mt-0.5 flex-shrink-0 text-warning" />
							<p className="text-xs text-warning-text">{warning}</p>
						</div>
					)}
				</div>
				<div className="flex items-center justify-end gap-2 border-t border-border-subtle px-5 py-3">
					<button
						type="button"
						onClick={onCancel}
						disabled={isPending}
						className="rounded-md border border-border bg-surface px-3 py-1.5 text-xs font-medium text-text-primary transition-colors hover:border-border-strong hover:bg-surface-raised disabled:opacity-50"
					>
						Cancel
					</button>
					<button
						type="button"
						onClick={onConfirm}
						disabled={isPending}
						className="flex items-center gap-1.5 rounded-md bg-error px-3 py-1.5 text-xs font-medium text-on-primary transition-colors hover:bg-error-strong disabled:cursor-not-allowed disabled:opacity-50"
					>
						{isPending && <Loader2 size={12} className="animate-spin" />}
						{isPending ? "Deactivating…" : "Deactivate"}
					</button>
				</div>
			</div>
		</div>
	);
}

// ============================================================================
// ROW DROPDOWN MENU
// ============================================================================

interface RowMenuProps {
	onEdit: () => void;
	onDeactivate: () => void;
	deactivateLabel?: string;
}

export function RowMenu({ onEdit, onDeactivate, deactivateLabel = "Deactivate" }: RowMenuProps) {
	const [open, setOpen] = useState(false);
	const [menuPos, setMenuPos] = useState<{ top: number; right: number } | null>(null);
	const btnRef = useRef<HTMLButtonElement>(null);

	useEffect(() => {
		if (!open) return;
		const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
		document.addEventListener("keydown", onKey);
		return () => document.removeEventListener("keydown", onKey);
	}, [open]);

	const handleToggle = () => {
		if (open) { setOpen(false); return; }
		if (btnRef.current) {
			const rect = btnRef.current.getBoundingClientRect();
			setMenuPos({ top: rect.bottom + 4, right: window.innerWidth - rect.right });
		}
		setOpen(true);
	};

	return (
		<div>
			<button
				ref={btnRef}
				type="button"
				aria-haspopup="menu"
				aria-expanded={open}
				aria-label="Row actions"
				onClick={handleToggle}
				className="flex h-7 w-7 items-center justify-center rounded border border-transparent text-text-muted transition-colors hover:border-border hover:bg-surface-raised hover:text-text-primary"
			>
				<ChevronDown size={14} />
			</button>
			{open && menuPos && (
				<>
					<div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
					<div
						role="menu"
						style={{ top: menuPos.top, right: menuPos.right }}
						className="fixed z-20 w-36 rounded-md border border-border bg-base shadow-lg"
					>
						<button
							type="button"
							role="menuitem"
							onClick={() => { setOpen(false); onEdit(); }}
							className="w-full px-3 py-2 text-left text-xs text-text-primary transition-colors hover:bg-surface-raised"
						>
							Edit
						</button>
						<button
							type="button"
							role="menuitem"
							onClick={() => { setOpen(false); onDeactivate(); }}
							className="w-full px-3 py-2 text-left text-xs text-error-text transition-colors hover:bg-error-bg"
						>
							{deactivateLabel}
						</button>
					</div>
				</>
			)}
		</div>
	);
}
