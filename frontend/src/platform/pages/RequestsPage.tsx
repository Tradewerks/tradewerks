import { useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { Inbox } from "lucide-react";
import Card from "../../components/ui/Card";
import EmptyState from "../../components/ui/EmptyState";
import PageHeader from "../../components/ui/PageHeader";
import { HEADER_BTN_PRIMARY, HEADER_BTN_SECONDARY } from "../../components/ui/headerActions";
import SegmentedToggle from "../../components/ui/SegmentedToggle";
import Pagination from "../../components/ui/Pagination";
import { FormErrorBanner } from "../../components/ui/forms/FormErrorBanner";
import { platformError } from "../api";
import { useRequests, useTiers } from "../hooks";
import { approvePrefill } from "../requests";
import { requestSummary } from "../../lib/upgradeRequests";
import ResolveRequestDialog from "../components/ResolveRequestDialog";
import { chip, shortDate } from "../components/orgDetailUi";
import SkeletonRows from "../components/SkeletonRows";
import type { UpgradeRequest } from "../types";

const STATUS_LABEL: Record<UpgradeRequest["status"], string> = {
	open: "Open",
	approved: "Approved",
	declined: "Declined",
	withdrawn: "Withdrawn",
};

export default function RequestsPage() {
	const [params, setParams] = useSearchParams();
	const status: "open" | "all" = params.get("status") === "all" ? "all" : "open";
	const page = Math.max(1, Number(params.get("page")) || 1);
	const setQuery = (changes: { status?: "open" | "all"; page?: number }) => {
		const next = new URLSearchParams(params);
		if (changes.status !== undefined) {
			if (changes.status === "all") next.set("status", "all");
			else next.delete("status");
		}
		if (changes.page && changes.page > 1) next.set("page", String(changes.page));
		else next.delete("page");
		setParams(next);
	};
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
		<div className="text-text-primary">
			<PageHeader title="Subscription requests">
				<SegmentedToggle<"open" | "all">
					ariaLabel="Request filter"
					value={status}
					options={[
						{ id: "open", label: "Open" },
						{ id: "all", label: "All" },
					]}
					onChange={(next) => setQuery({ status: next })}
				/>
			</PageHeader>
			{requests.error && (
				<FormErrorBanner
					className="mb-4"
					message={platformError(requests.error)}
				/>
			)}
			<Card flush>
				{requests.isLoading ? (
					<div className="p-4">
						<SkeletonRows />
					</div>
				) : requests.data?.rows.length === 0 ? (
					<EmptyState
						icon={<Inbox size={28} />}
						title={
							status === "open"
								? "No open requests."
								: "No requests yet."
						}
					/>
				) : (
					<ul className="divide-y divide-border-subtle">
						{(requests.data?.rows ?? []).map((r) => {
							const asked = requestSummary(r);
							return (
								<li
									key={r.id}
									className="space-y-1 px-4 py-3 text-sm"
								>
									<div className="flex flex-wrap items-center gap-2">
										<Link
											to={`/platform/orgs/${r.organization_id}`}
											className="font-medium text-text-primary hover:text-primary hover:underline"
										>
											{r.org_name}
										</Link>
										<span className="text-text-secondary">
											{
												r.requested_by_name
											}
										</span>
										<span className={chip}>
											{
												STATUS_LABEL[
													r
														.status
												]
											}
										</span>
										<span className="ml-auto text-xs text-text-tertiary">
											{shortDate(
												r.created_at
											)}
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
										<div className="flex gap-2 pt-1">
											<button
												type="button"
												className={
													HEADER_BTN_PRIMARY
												}
												// Before tiers load every tier request would read as unavailable.
												disabled={
													!tiers.data
												}
												onClick={() =>
													approve(
														r
													)
												}
											>
												Approve…
											</button>
											<button
												type="button"
												className={
													HEADER_BTN_SECONDARY
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
				)}
			</Card>
			{requests.data && (
				<Pagination
					className="mt-4"
					page={page}
					pageSize={requests.data.pageSize}
					total={requests.data.total}
					onPageChange={(p) => setQuery({ page: p })}
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
