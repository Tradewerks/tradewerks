import { useState } from "react";
import ConfirmDialog from "../../components/ui/ConfirmDialog";
import ReasonField from "../../components/ui/ReasonField";
import { useToast } from "../../components/ui/useToast";
import { platform, platformError } from "../api";
import { useTierMutation } from "../hooks";
import { noteReady, REASON_TOO_SHORT } from "../notes";
import type { TierPatch, TierRow } from "../types";

export type TierAction = "rename" | "archive" | "unarchive" | "signupDefault" | "trialDefault";

const COPY: Record<TierAction, { title: string; confirm: string; body: string }> = {
	rename: {
		title: "Rename tier",
		confirm: "Rename",
		body: "Orgs keep their version; only the label changes.",
	},
	archive: {
		title: "Archive tier",
		confirm: "Archive",
		body: "Archived tiers cannot be assigned or get new versions.",
	},
	unarchive: {
		title: "Unarchive tier",
		confirm: "Unarchive",
		body: "The tier can be assigned again.",
	},
	signupDefault: {
		title: "Make signup default",
		confirm: "Make default",
		body: "New self-serve signups start on this tier's latest version. The current default stops being one.",
	},
	trialDefault: {
		title: "Make trial default",
		confirm: "Make default",
		body: "New signups trial this tier's latest version. The current trial default stops being one.",
	},
};

// Mount with key={action}: each opening starts from fresh state and a fresh mutation.
export default function TierActionDialog({
	tier,
	action,
	onClose,
}: {
	tier: TierRow;
	action: TierAction | null;
	onClose: () => void;
}) {
	const [reason, setReason] = useState("");
	const [label, setLabel] = useState(tier.label);
	const [tried, setTried] = useState(false);
	const toast = useToast();
	const mutation = useTierMutation((v: { patch: TierPatch; reason: string }) =>
		platform.patchTier(tier.key, v.patch, v.reason)
	);
	if (!action) return null;
	const copy = COPY[action];
	const patch: TierPatch =
		action === "rename"
			? { label: label.trim() }
			: action === "archive" || action === "unarchive"
				? { archived: action === "archive" }
				: action === "signupDefault"
					? { signupDefault: true }
					: { trialDefault: true };
	const confirm = () => {
		setTried(true);
		if (!noteReady(reason)) return;
		mutation.mutate(
			{ patch, reason: reason.trim() },
			{
				onSuccess: () => {
					toast.success(
						`${tier.label}: ${copy.title.toLowerCase()} done`
					);
					onClose();
				},
			}
		);
	};
	return (
		<ConfirmDialog
			open
			title={copy.title}
			body={
				<div className="space-y-3">
					<p className="text-sm text-text-secondary">{copy.body}</p>
					{action === "rename" && (
						<input
							aria-label="Tier label"
							className="h-8 w-full rounded-md border border-border bg-surface px-2 text-sm text-text-primary"
							value={label}
							onChange={(e) => setLabel(e.target.value)}
						/>
					)}
					<ReasonField
						label="Reason (required)"
						placeholder="Why? It is kept in the tier history."
						rows={3}
						value={reason}
						onChange={setReason}
					/>
				</div>
			}
			confirmLabel={copy.confirm}
			tone={action === "archive" ? "destructive" : "primary"}
			pending={mutation.isPending}
			error={
				mutation.error
					? platformError(mutation.error)
					: tried && !noteReady(reason)
						? REASON_TOO_SHORT
						: null
			}
			onConfirm={confirm}
			onCancel={onClose}
		/>
	);
}
