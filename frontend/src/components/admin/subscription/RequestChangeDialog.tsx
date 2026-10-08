import { useEffect, useState } from "react";
import ConfirmDialog from "../../ui/ConfirmDialog";
import { FormErrorBanner } from "../../ui/forms/FormErrorBanner";
import { useFileUpgradeRequest, useRequestableTiers } from "../../../hooks/useUpgradeRequests";
import { toggled } from "../../../lib/toggled";
import { requestErrorMessage } from "../../../lib/upgradeRequests";

const heading = "text-[11px] font-medium uppercase tracking-wide text-text-tertiary";

export default function RequestChangeDialog({
	open,
	onClose,
	lockedModules,
	initialModules = [],
	initialNote = "",
}: {
	open: boolean;
	onClose: () => void;
	lockedModules: { key: string; label: string }[];
	initialModules?: string[];
	initialNote?: string;
}) {
	const tiers = useRequestableTiers(open);
	const fileRequest = useFileUpgradeRequest();
	const [planKey, setPlanKey] = useState<string | null>(null);
	const [modules, setModules] = useState<Set<string>>(new Set(initialModules));
	const [note, setNote] = useState(initialNote);
	const [localError, setLocalError] = useState<string | null>(null);
	const { reset } = fileRequest;
	// Reset on content, not identity: the parent passes a fresh array each render.
	const initialKey = initialModules.join(",");
	useEffect(() => {
		if (!open) return;
		setPlanKey(null);
		setModules(new Set(initialKey ? initialKey.split(",") : []));
		setNote(initialNote);
		setLocalError(null);
		reset();
	}, [open, initialKey, initialNote, reset]);

	const send = () => {
		const trimmed = note.trim();
		if (!planKey && modules.size === 0 && trimmed.length < 3) {
			setLocalError("Tell us what you need (3 characters or more)");
			return;
		}
		setLocalError(null);
		fileRequest.mutate(
			{
				planKey: planKey ?? undefined,
				modules: [...modules],
				note: trimmed || undefined,
			},
			{ onSuccess: onClose }
		);
	};
	const toggle = (key: string) => setModules((s) => toggled(s, key));

	return (
		<ConfirmDialog
			open={open}
			title="Request a subscription change"
			confirmLabel="Send request"
			pending={fileRequest.isPending}
			error={
				localError ??
				(fileRequest.error
					? requestErrorMessage(
							fileRequest.error,
							"Could not send the request. Please try again."
						)
					: null)
			}
			onConfirm={send}
			onCancel={onClose}
			body={
				<div className="space-y-4">
					<fieldset className="space-y-1">
						<legend className={heading}>Subscription</legend>
						<label className="flex items-center gap-2 text-sm text-text-primary">
							<input
								type="radio"
								name="tier"
								checked={planKey === null}
								onChange={() => setPlanKey(null)}
							/>
							Keep current
						</label>
						{(tiers.data ?? []).map((t) => (
							<label
								key={t.key}
								className="flex items-start gap-2 text-sm text-text-primary"
							>
								<input
									type="radio"
									name="tier"
									className="mt-1"
									checked={planKey === t.key}
									onChange={() =>
										setPlanKey(t.key)
									}
								/>
								<span>
									{t.label}
									{t.modules.length > 0 && (
										<span className="block text-xs text-text-tertiary">
											Includes{" "}
											{t.modules
												.map(
													(
														m
													) =>
														m.label
												)
												.join(
													", "
												)}
										</span>
									)}
								</span>
							</label>
						))}
					</fieldset>
					{lockedModules.length > 0 && (
						<fieldset className="space-y-1">
							<legend className={heading}>
								Features
							</legend>
							{lockedModules.map((m) => (
								<label
									key={m.key}
									className="flex items-center gap-2 text-sm text-text-primary"
								>
									<input
										type="checkbox"
										checked={modules.has(
											m.key
										)}
										onChange={() =>
											toggle(
												m.key
											)
										}
									/>
									{m.label}
								</label>
							))}
						</fieldset>
					)}
					<label className="block space-y-1 text-sm">
						<span className={heading}>
							Note (required if nothing is picked)
						</span>
						<textarea
							className="h-20 w-full rounded-md border border-border bg-surface px-2 py-1 text-sm text-text-primary"
							value={note}
							maxLength={1000}
							onChange={(e) => setNote(e.target.value)}
							placeholder="For example: we need 3 more technician seats."
						/>
					</label>
					{tiers.error && (
						<FormErrorBanner message="Subscriptions could not be loaded. You can still send a note." />
					)}
				</div>
			}
		/>
	);
}
