import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import SegmentedToggle from "../../components/ui/SegmentedToggle";
import Pagination from "../../components/ui/Pagination";
import { FormErrorBanner } from "../../components/ui/forms/FormErrorBanner";
import { platformError } from "../api";
import { useRequests, useTiers } from "../hooks";
import { approvePrefill } from "../requests";
import { requestSummary } from "../../lib/upgradeRequests";
import ResolveRequestDialog from "../components/ResolveRequestDialog";
import { chip, shortDate, smallButton, textButton } from "../components/orgDetailUi";
import type { UpgradeRequest } from "../types";

const STATUS_LABEL: Record<UpgradeRequest["status"], string> = {
	open: "Open",
	approved: "Approved",
	declined: "Declined",
	withdrawn: "Withdrawn",
};

export default function RequestsPage() {
	const [status, setStatus] = useState<"open" | "all">("open");
	const [page, setPage] = useState(1);
	const requests = useRequests(status, undefined, page);
	const tiers = useTiers();
	const navigate = useNavigate();
	const [declining, setDeclining] = useState<UpgradeRequest | null>(null);
	const approve = (r: UpgradeRequest) => {
		const prefill = approvePrefill(r, tiers.data!);
		navigate(`/platform/orgs/${r.organization_id}`, {
			state: prefill ? { prefill } : null,
		});
	};
	return (
		<div className="space-y-4">
			<div className="flex flex-wrap items-center justify-between gap-2">
				<h1 className="text-lg font-semibold text-text-primary">
					Subscription requests
				</h1>
				<SegmentedToggle<"open" | "all">
					ariaLabel="Request filter"
					value={status}
					options={[
						{ id: "open", label: "Open" },
						{ id: "all", label: "All" },
					]}
					onChange={(next) => {
						setStatus(next);
						setPage(1);
					}}
				/>
			</div>
			{requests.error && (
				<FormErrorBanner message={platformError(requests.error)} />
			)}
			{requests.data?.rows.length === 0 && (
				<p className="text-sm text-text-secondary">
					{status === "open"
						? "No open requests."
						: "No requests yet."}
				</p>
			)}
			<ul className="space-y-2">
				{(requests.data?.rows ?? []).map((r) => {
					const asked = requestSummary(r);
					return (
						<li
							key={r.id}
							className="space-y-1 rounded-lg border border-border bg-surface p-3 text-sm"
						>
							<div className="flex flex-wrap items-center gap-2">
								<Link
									to={`/platform/orgs/${r.organization_id}`}
									className="font-medium text-text-primary hover:text-primary hover:underline"
								>
									{r.org_name}
								</Link>
								<span className="text-text-secondary">
									{r.requested_by_name}
								</span>
								<span className={chip}>
									{STATUS_LABEL[r.status]}
								</span>
								<span className="ml-auto text-xs text-text-tertiary">
									{shortDate(r.created_at)}
								</span>
							</div>
							{asked && (
								<p className="text-text-primary">
									{asked}
								</p>
							)}
							{r.note && (
								<p className="text-text-secondary">
									{r.note}
								</p>
							)}
							{r.resolution_note && (
								<p className="text-xs text-text-tertiary">
									{r.resolution_note}
								</p>
							)}
							{r.status === "open" && (
								<div className="flex gap-3 pt-1">
									<button
										type="button"
										className={
											smallButton
										}
										// Before tiers load every tier request would read as unavailable.
										disabled={!tiers.data}
										onClick={() =>
											approve(r)
										}
									>
										Approve…
									</button>
									<button
										type="button"
										className={
											textButton
										}
										onClick={() =>
											setDeclining(
												r
											)
										}
									>
										Decline
									</button>
								</div>
							)}
						</li>
					);
				})}
			</ul>
			{requests.data && (
				<Pagination
					page={page}
					pageSize={requests.data.pageSize}
					total={requests.data.total}
					onPageChange={setPage}
				/>
			)}
			<ResolveRequestDialog
				key={declining?.id ?? "none"}
				request={declining}
				mode={declining ? "declined" : null}
				onClose={() => setDeclining(null)}
			/>
		</div>
	);
}
