import { requestParts } from "../requests";
import { shortDate, textButton, type OpenChange } from "./orgDetailUi";
import type { RequestResolution, TierRow, UpgradeRequest } from "../types";

export default function RequestBanner({
	request,
	tiers,
	onApply,
	onResolve,
}: {
	request: UpgradeRequest;
	tiers: TierRow[];
	onApply: OpenChange;
	onResolve: (mode: RequestResolution) => void;
}) {
	const parts = requestParts(request, tiers);
	return (
		<section
			aria-label="Open subscription request"
			className="space-y-2 rounded-lg border border-primary/40 bg-surface p-3 text-sm"
		>
			<p className="text-text-primary">
				<span className="font-medium">{request.requested_by_name}</span>{" "}
				asked on {shortDate(request.created_at)}
			</p>
			{request.note && <p className="text-text-secondary">{request.note}</p>}
			{parts.length > 0 && (
				<ul className="space-y-1">
					{parts.map(({ key, title, change, unavailable }) => (
						<li
							key={key}
							className="flex flex-wrap items-center gap-2"
						>
							<span className="text-text-primary">
								{title}
							</span>
							{change ? (
								<button
									type="button"
									className={textButton}
									onClick={() =>
										onApply({
											change,
											title,
										})
									}
								>
									Apply…
								</button>
							) : (
								<span className="text-xs text-text-tertiary">
									{unavailable}
								</span>
							)}
						</li>
					))}
				</ul>
			)}
			<div className="flex flex-wrap gap-3">
				<button
					type="button"
					className={textButton}
					onClick={() => onResolve("approved")}
				>
					Mark approved (already in effect)
				</button>
				<button
					type="button"
					className={textButton}
					onClick={() => onResolve("declined")}
				>
					Decline
				</button>
			</div>
			<p className="text-xs text-text-tertiary">
				Any change made on this page can close the request: tick "Mark
				request approved" before saving it.
			</p>
		</section>
	);
}
