import { useState } from "react";
import ConfirmDialog from "../../components/ui/ConfirmDialog";
import ReasonField from "../../components/ui/ReasonField";
import { useToast } from "../../components/ui/useToast";
import { platformError } from "../api";
import { useResolveRequest } from "../hooks";
import { NOTE_TOO_SHORT, noteReady } from "../notes";
import type { RequestResolution, UpgradeRequest } from "../types";

// Mount with a key per request and mode: each opening starts from fresh state and a fresh mutation.
export default function ResolveRequestDialog({
	request,
	mode,
	onClose,
}: {
	request: UpgradeRequest | null;
	mode: RequestResolution | null;
	onClose: () => void;
}) {
	const [note, setNote] = useState("");
	const [tried, setTried] = useState(false);
	const resolve = useResolveRequest();
	const toast = useToast();
	if (!request || !mode) return null;
	const declining = mode === "declined";
	return (
		<ConfirmDialog
			open
			title={
				declining
					? `Decline ${request.org_name}'s request`
					: "Mark request approved"
			}
			body={
				<div className="space-y-2">
					<p className="text-sm text-text-secondary">
						{declining
							? "The requester is notified with your note."
							: "Only works when everything requested is already in effect. The requester is notified."}
					</p>
					<ReasonField
						label="Note (required)"
						placeholder={
							declining
								? "Why not, and what instead?"
								: "What was done"
						}
						rows={3}
						value={note}
						onChange={setNote}
					/>
				</div>
			}
			confirmLabel={declining ? "Decline" : "Mark approved"}
			tone={declining ? "destructive" : "primary"}
			pending={resolve.isPending}
			error={
				resolve.error
					? platformError(resolve.error)
					: tried && !noteReady(note)
						? NOTE_TOO_SHORT
						: null
			}
			onConfirm={() => {
				setTried(true);
				if (!noteReady(note)) return;
				resolve.mutate(
					{ id: request.id, status: mode, note: note.trim() },
					{
						onSuccess: () => {
							toast.success(
								declining
									? "Request declined"
									: "Request marked approved"
							);
							onClose();
						},
					}
				);
			}}
			onCancel={onClose}
		/>
	);
}
