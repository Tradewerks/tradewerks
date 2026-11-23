import { createPortal } from "react-dom";
import ConfirmDialog from "../ui/ConfirmDialog";

interface VisitConflictDialogProps {
	open: boolean;
	onReload: () => unknown;
	onClose: () => void;
}

export default function VisitConflictDialog({ open, onReload, onClose }: VisitConflictDialogProps) {
	if (!open) return null;
	// Portaled above FullPopup (z-[5000]) so it also clears the Edit Visit wizard
	// and any transformed board/dashboard ancestor that would clip a fixed child.
	return createPortal(
		<div className="relative z-[6000]">
			<ConfirmDialog
				open
				title="Someone else changed this visit"
				body="Your change was not saved. Reload to see the latest version, then make your change again."
				confirmLabel="Reload"
				onConfirm={onReload}
				onCancel={onClose}
			/>
		</div>,
		document.body,
	);
}
