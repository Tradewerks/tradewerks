import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { ChevronRight } from "lucide-react";
import { FormErrorBanner } from "../../components/ui/forms/FormErrorBanner";
import { inputClass } from "../components/AuthCard";
import { UsageCell } from "../components/UsageCell";
import { LIMIT_KEYS, LIMIT_LABELS } from "../limits";
import { platformError } from "../api";
import { useOrgs } from "../hooks";
import { useRowOpen } from "../rowOpen";
import type { OrgListRow } from "../types";

const shortDate = (iso: string) =>
	new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
const isMeter = (key: string) => key.endsWith("_month");

function TierText({ row }: { row: OrgListRow }) {
	if (!row.tier) return <span className="text-warning-text">No entitlement row</span>;
	return (
		<span className="text-text-secondary">
			{row.tier.label} v{row.tier.version}
		</span>
	);
}

const trialText = (row: OrgListRow) =>
	row.trial ? `${row.trial.tierLabel} until ${shortDate(row.trial.endsAt)}` : "";

export default function OrgsPage() {
	const [input, setInput] = useState("");
	const [q, setQ] = useState("");
	const [page, setPage] = useState(1);
	const openRow = useRowOpen();

	useEffect(() => {
		const t = setTimeout(() => {
			setQ(input.trim());
			setPage(1);
		}, 250);
		return () => clearTimeout(t);
	}, [input]);

	const orgs = useOrgs(q, page);
	const data = orgs.data;
	const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;

	return (
		<div className="space-y-4">
			<div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
				<div>
					<h1 className="text-lg font-semibold text-text-primary">
						Organizations
					</h1>
					{data && (
						<p className="text-xs text-text-tertiary">
							{data.total} organization
							{data.total === 1 ? "" : "s"}
						</p>
					)}
				</div>
				<input
					type="search"
					aria-label="Search organizations"
					placeholder="Search by name"
					className={`${inputClass} sm:w-64`}
					value={input}
					onChange={(e) => setInput(e.target.value)}
				/>
			</div>

			{orgs.error && <FormErrorBanner message={platformError(orgs.error)} />}

			{orgs.isLoading ? (
				<div className="space-y-2">
					{[0, 1, 2, 3, 4].map((i) => (
						<div
							key={i}
							className="h-9 animate-pulse rounded bg-surface-inset"
						/>
					))}
				</div>
			) : data && data.rows.length === 0 ? (
				<p className="text-sm text-text-secondary">
					{q
						? `No organizations match "${q}".`
						: "No organizations yet."}
				</p>
			) : (
				data && (
					<>
						<table className="hidden w-full text-sm md:table">
							<thead>
								<tr>
									{[
										"Name",
										"Tier",
										"Trial",
										"Template",
										...LIMIT_KEYS.map(
											(k) =>
												LIMIT_LABELS[
													k
												]
										),
										"",
									].map((h) => (
										<th
											key={
												h ||
												"open"
											}
											className="pb-2 pr-3 text-left text-xs font-medium text-text-tertiary"
										>
											{h}
										</th>
									))}
								</tr>
							</thead>
							<tbody>
								{data.rows.map((row) => (
									<tr
										key={row.id}
										onClick={(ev) =>
											openRow(
												ev,
												`/platform/orgs/${row.id}`
											)
										}
										className="cursor-pointer border-t border-border-subtle transition-colors duration-150 ease-out hover:bg-surface-inset"
									>
										<td className="py-2 pr-3">
											<Link
												to={`/platform/orgs/${row.id}`}
												className="font-medium text-text-primary hover:text-primary hover:underline"
											>
												{
													row.name
												}
											</Link>
										</td>
										<td className="py-2 pr-3">
											<TierText
												row={
													row
												}
											/>
										</td>
										<td className="py-2 pr-3 text-text-secondary">
											{trialText(
												row
											)}
										</td>
										<td className="py-2 pr-3 text-text-secondary">
											{row.template ??
												""}
										</td>
										{LIMIT_KEYS.map(
											(k) => (
												<td
													key={
														k
													}
													className="py-2 pr-3"
												>
													<UsageCell
														meter={
															row
																.usage
																?.meters[
																k
															]
														}
														isMeter={isMeter(
															k
														)}
													/>
												</td>
											)
										)}
										<td className="w-6 py-2 text-text-tertiary">
											<ChevronRight
												size={
													16
												}
												aria-hidden
											/>
										</td>
									</tr>
								))}
							</tbody>
						</table>
						<ul className="space-y-2 md:hidden">
							{data.rows.map((row) => (
								<li
									key={row.id}
									onClick={(ev) =>
										openRow(
											ev,
											`/platform/orgs/${row.id}`
										)
									}
									className="cursor-pointer space-y-2 rounded-lg border border-border bg-surface p-3 transition-colors duration-150 ease-out hover:bg-surface-inset"
								>
									<div className="flex items-center justify-between gap-2 text-sm">
										<Link
											to={`/platform/orgs/${row.id}`}
											className="truncate font-medium text-text-primary hover:text-primary hover:underline"
										>
											{row.name}
										</Link>
										<span className="flex shrink-0 items-center gap-1">
											<TierText
												row={
													row
												}
											/>
											<ChevronRight
												size={
													16
												}
												aria-hidden
												className="text-text-tertiary"
											/>
										</span>
									</div>
									{row.trial && (
										<p className="text-xs text-text-secondary">
											Trial:{" "}
											{trialText(
												row
											)}
										</p>
									)}
									<dl className="grid grid-cols-2 gap-2 text-sm">
										{LIMIT_KEYS.map(
											(k) => (
												<div
													key={
														k
													}
												>
													<dt className="text-xs text-text-tertiary">
														{
															LIMIT_LABELS[
																k
															]
														}
													</dt>
													<dd>
														<UsageCell
															meter={
																row
																	.usage
																	?.meters[
																	k
																]
															}
															isMeter={isMeter(
																k
															)}
														/>
													</dd>
												</div>
											)
										)}
									</dl>
								</li>
							))}
						</ul>
						<div className="flex items-center justify-between gap-2 text-sm">
							<button
								type="button"
								className="h-8 rounded-md border border-border px-3 text-text-primary hover:bg-surface-inset disabled:opacity-50"
								disabled={page <= 1}
								onClick={() =>
									setPage((p) => p - 1)
								}
							>
								Previous
							</button>
							<span className="text-text-tertiary tabular-nums">
								Page {page} of {pages}
							</span>
							<button
								type="button"
								className="h-8 rounded-md border border-border px-3 text-text-primary hover:bg-surface-inset disabled:opacity-50"
								disabled={page >= pages}
								onClick={() =>
									setPage((p) => p + 1)
								}
							>
								Next
							</button>
						</div>
					</>
				)
			)}
		</div>
	);
}
