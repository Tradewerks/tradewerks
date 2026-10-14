import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import type { DisablePreview } from "../../../api/entitlements";
import { BLOCKER_LINKS, joinLabels, sentence, type Module } from "../../../lib/moduleGroups";

const quietButton =
	"rounded-md px-3 py-1.5 text-sm text-text-tertiary transition-colors hover:bg-surface hover:text-text-primary disabled:opacity-50";
// Neutral, not red: turning a module off is reversible and deletes nothing.
const neutralButton =
	"rounded-md border border-border-strong bg-base px-3 py-1.5 text-sm font-medium text-text-primary transition-colors hover:bg-surface disabled:opacity-50";

export default function TurnOffPanel({
	module,
	preview,
	pending,
	onConfirm,
	onClose,
}: {
	module: Module;
	preview: DisablePreview;
	pending: boolean;
	onConfirm: () => void;
	onClose: () => void;
}) {
	const firstButton = useRef<HTMLButtonElement>(null);
	const [open, setOpen] = useState(false);
	useEffect(() => {
		const frame = requestAnimationFrame(() => setOpen(true));
		firstButton.current?.focus({ preventScroll: true });
		return () => cancelAnimationFrame(frame);
	}, []);

	const blocked = preview.dependents.length > 0 || !!preview.blocker;
	const link = BLOCKER_LINKS[module.key];
	const one = preview.dependents.length === 1;

	return (
		<div
			className={`grid transition-[grid-template-rows] duration-150 ease-out motion-reduce:transition-none ${
				open ? "grid-rows-[1fr]" : "grid-rows-[0fr]"
			}`}
		>
			<div className="overflow-hidden">
				<div
					role="group"
					aria-label={`Turn off ${module.label}`}
					onKeyDown={(e) => {
						if (e.key === "Escape" && !pending) {
							e.stopPropagation();
							onClose();
						}
					}}
					className="mt-3 space-y-1.5 rounded-md border border-border-subtle bg-surface-inset px-4 py-3 text-sm text-text-secondary"
				>
					{blocked ? (
						<>
							<p className="font-medium text-text-primary">
								{module.label} can&rsquo;t be turned
								off yet.
							</p>
							{preview.dependents.length > 0 && (
								<p>
									{joinLabels(
										preview.dependents
									)}{" "}
									{one ? "needs" : "need"} it.
									Turn{" "}
									{one ? "that" : "those"} off
									first.
								</p>
							)}
							{preview.blocker && (
								<p>
									{sentence(
										preview.blocker
											.message
									)}
									{link && (
										<>
											{" "}
											<Link
												to={
													link.to
												}
												className="font-medium text-primary hover:underline"
											>
												{
													link.label
												}
											</Link>
										</>
									)}
								</p>
							)}
							<div className="flex justify-end pt-1.5">
								<button
									ref={firstButton}
									type="button"
									onClick={onClose}
									className={neutralButton}
								>
									Close
								</button>
							</div>
						</>
					) : (
						<>
							{preview.warning && (
								<p>{preview.warning}</p>
							)}
							<p>Your data is kept.</p>
							<div className="flex justify-end gap-2 pt-1.5">
								<button
									ref={firstButton}
									type="button"
									disabled={pending}
									onClick={onClose}
									className={quietButton}
								>
									Keep on
								</button>
								<button
									type="button"
									disabled={pending}
									onClick={onConfirm}
									className={neutralButton}
								>
									{pending
										? "Turning off…"
										: `Turn off ${module.label}`}
								</button>
							</div>
						</>
					)}
				</div>
			</div>
		</div>
	);
}
