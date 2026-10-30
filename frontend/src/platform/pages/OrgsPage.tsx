import { useEffect, useRef, useState } from "react";
import { Link, useNavigationType, useSearchParams } from "react-router-dom";
import { Building2, ChevronRight, Plus } from "lucide-react";
import Card from "../../components/ui/Card";
import EmptyState from "../../components/ui/EmptyState";
import FilterChips from "../../components/ui/FilterChips";
import PageControls from "../../components/ui/PageControls";
import PageHeader from "../../components/ui/PageHeader";
import Pagination from "../../components/ui/Pagination";
import SearchBar from "../../components/ui/SearchBar";
import { DropdownFilter } from "../../components/ui/StatusFilter";
import { FormErrorBanner } from "../../components/ui/forms/FormErrorBanner";
import { pageAction } from "../components/orgDetailUi";
import NewOrgPanel from "../components/NewOrgPanel";
import { UsageCell } from "../components/UsageCell";
import { LIMIT_KEYS, LIMIT_LABELS } from "../limits";
import { platformError } from "../api";
import { useOrgs, useTiers } from "../hooks";
import { useRowOpen } from "../rowOpen";
import { shortDateIn, trialEndsInDays } from "../../lib/trialDays";
import type { OrgListRow } from "../types";

const isMeter = (key: string) => key.endsWith("_month");

const TRIAL_OPTIONS = [{ value: "ending", label: "Trials ending in 7 days" }];
const TH = "py-2 pr-3 text-left text-xs font-medium text-text-tertiary first:pl-4 last:pr-4";
const TD = "py-2 pr-3 first:pl-4 last:pr-4";

function TierText({ row }: { row: OrgListRow }) {
	if (!row.tier) return <span className="text-warning-text">No entitlement row</span>;
	return (
		<span className="text-text-secondary">
			{row.tier.label} v{row.tier.version}
		</span>
	);
}

const trialText = (row: OrgListRow) =>
	row.trial ? `${row.trial.tierLabel} until ${shortDateIn(row.trial.endsAt, row.timezone)}` : "";

function TrialCell({ row }: { row: OrgListRow }) {
	if (!row.trial) return null;
	const days = trialEndsInDays(row.trial.endsAt);
	return (
		<>
			{trialText(row)}
			{days <= 7 && (
				<span className="ml-2 inline-block whitespace-nowrap rounded border border-border px-1.5 py-0.5 text-[11px] font-medium text-warning-text">
					Trial ends in {days} d
				</span>
			)}
		</>
	);
}

export default function OrgsPage() {
	const [params, setParams] = useSearchParams();
	const navType = useNavigationType();
	const q = params.get("q") ?? "";
	const trialEnding = params.get("trial") === "ending";
	const page = Math.max(1, Number(params.get("page")) || 1);
	const tierKey = params.get("tier") ?? "";
	const tierVersion = Number(params.get("version")) || undefined;
	const tierFilter = tierKey ? { key: tierKey, version: tierVersion } : undefined;
	const tiers = useTiers();
	const tierLabel = tiers.data?.find((t) => t.key === tierKey)?.label ?? tierKey;
	const [input, setInput] = useState(q);
	const [panelOpen, setPanelOpen] = useState(false);
	const openRow = useRowOpen();

	const update = (changes: Record<string, string | null>, resetPage = true) => {
		setParams((prev) => {
			const next = new URLSearchParams(prev);
			for (const [k, v] of Object.entries(changes)) {
				if (v) next.set(k, v);
				else next.delete(k);
			}
			if (resetPage) next.delete("page");
			return next;
		});
	};

	// SearchBar only reports keystrokes (it commits to the URL on Enter), so this 250ms
	// debounce is what keeps useOrgs from firing per keystroke.
	useEffect(() => {
		const t = setTimeout(() => {
			const v = input.trim();
			if (v !== q) {
				setParams((prev) => {
					const next = new URLSearchParams(prev);
					if (v) next.set("q", v);
					else next.delete("q");
					next.delete("page");
					return next;
				});
			}
		}, 250);
		return () => clearTimeout(t);
	}, [input, q, setParams]);

	// Enter commits q straight to the URL inside SearchBar, bypassing the debounce above.
	const prevQ = useRef(q);
	useEffect(() => {
		if (prevQ.current === q) return;
		prevQ.current = q;
		// Back/forward restores a URL that already carries its own page; don't strip it.
		if (navType === "POP") return;
		setParams(
			(prev) => {
				if (!prev.has("page")) return prev;
				const next = new URLSearchParams(prev);
				next.delete("page");
				return next;
			},
			{ replace: true },
		);
	}, [q, navType, setParams]);

	const orgs = useOrgs(q, page, trialEnding, tierFilter);
	const data = orgs.data;
	const filtered = Boolean(q) || trialEnding || Boolean(tierKey);
	const clearAll = () => {
		setInput("");
		update({ q: null, trial: null, tier: null, version: null });
	};

	return (
		<div className="text-text-primary">
			<PageHeader
				title="Organizations"
				subtitle={
					data && (
						<p className="text-xs text-text-tertiary">
							{data.total} organization
							{data.total === 1 ? "" : "s"}
						</p>
					)
				}
			>
				<button
					type="button"
					aria-expanded={panelOpen}
					className={pageAction}
					onClick={() => setPanelOpen((o) => !o)}
				>
					<Plus size={16} />
					New organization
				</button>
			</PageHeader>

			<PageControls
				className="mb-4"
				left={
					<SearchBar
						paramKey="q"
						placeholder="Search organizations..."
						onValueChange={setInput}
					/>
				}
				middle={
					<div className="flex items-center gap-2">
					<DropdownFilter
						exclusive
						placeholder="Tier"
						options={(tiers.data ?? []).map((t) => ({ value: t.key, label: t.label }))}
						values={tierKey ? [tierKey] : null}
						onChange={(v) => update({ tier: v, version: null })}
					/>
					<DropdownFilter
						exclusive
						placeholder="Trial"
						options={TRIAL_OPTIONS}
						values={trialEnding ? ["ending"] : null}
						onChange={(v) => update({ trial: v })}
					/>
					</div>
				}
			/>

			<FilterChips
				filters={[
					tierKey
						? {
								label: `Tier: ${tierLabel}${tierVersion ? ` v${tierVersion}` : ""}`,
								color: "blue" as const,
								onRemove: () => update({ tier: null, version: null }),
							}
						: null,
					trialEnding
						? {
								label: "Trials ending in 7 days",
								color: "orange" as const,
								onRemove: () => update({ trial: null }),
							}
						: null,
					q
						? {
								label: `Search: "${q}"`,
								color: "purple" as const,
								onRemove: () => {
									setInput("");
									update({ q: null });
								},
							}
						: null,
				]}
				resultCount={data?.total ?? 0}
				onClearAll={clearAll}
			/>

			{panelOpen && (
				<div className="mb-4">
					<NewOrgPanel onClose={() => setPanelOpen(false)} />
				</div>
			)}

			{orgs.error && <FormErrorBanner message={platformError(orgs.error)} />}

			{orgs.isLoading ? (
				<Card flush>
					<div className="space-y-2 p-4">
						{[0, 1, 2, 3, 4].map((i) => (
							<div key={i} className="h-9 animate-pulse rounded bg-surface-inset" />
						))}
					</div>
				</Card>
			) : data && data.rows.length === 0 ? (
				<Card flush>
					<EmptyState
						icon={<Building2 size={28} />}
						title={
							trialEnding
								? "No trials end in the next 7 days."
								: tierKey
									? `No organizations are on ${tierLabel}${tierVersion ? ` v${tierVersion}` : ""}.`
									: q
									? `No organizations match "${q}".`
									: "No organizations yet."
						}
						action={filtered ? { label: "Clear filters", onClick: clearAll } : undefined}
					/>
				</Card>
			) : (
				data && (
					<>
						<Card flush>
							<table className="hidden w-full text-sm md:table">
								<thead>
									<tr className="bg-surface-inset/50">
										{[
											"Name",
											"Tier",
											"Trial",
											"Template",
											...LIMIT_KEYS.map((k) => LIMIT_LABELS[k]),
											"",
										].map((h) => (
											<th key={h || "open"} className={TH}>
												{h}
											</th>
										))}
									</tr>
								</thead>
								<tbody>
									{data.rows.map((row) => (
										<tr
											key={row.id}
											onClick={(ev) => openRow(ev, `/platform/orgs/${row.id}`)}
											className="cursor-pointer border-t border-border-subtle transition-colors duration-150 ease-out hover:bg-surface-raised"
										>
											<td className={TD}>
												<Link
													to={`/platform/orgs/${row.id}`}
													className="font-medium text-text-primary hover:text-primary hover:underline"
												>
													{row.name}
												</Link>
											</td>
											<td className={TD}>
												<TierText row={row} />
											</td>
											<td className={`${TD} text-text-secondary`}>
												<TrialCell row={row} />
											</td>
											<td className={`${TD} text-text-secondary`}>
												{row.template ?? ""}
											</td>
											{LIMIT_KEYS.map((k) => (
												<td key={k} className={TD}>
													<UsageCell
														meter={row.usage?.meters[k]}
														isMeter={isMeter(k)}
													/>
												</td>
											))}
											<td className={`${TD} w-6 text-text-tertiary`}>
												<ChevronRight size={16} aria-hidden />
											</td>
										</tr>
									))}
								</tbody>
							</table>
							<ul className="divide-y divide-border-subtle md:hidden">
								{data.rows.map((row) => (
									<li
										key={row.id}
										onClick={(ev) => openRow(ev, `/platform/orgs/${row.id}`)}
										className="cursor-pointer space-y-2 p-4 transition-colors duration-150 ease-out hover:bg-surface-raised"
									>
										<div className="flex items-center justify-between gap-2 text-sm">
											<Link
												to={`/platform/orgs/${row.id}`}
												className="truncate font-medium text-text-primary hover:text-primary hover:underline"
											>
												{row.name}
											</Link>
											<span className="flex shrink-0 items-center gap-1">
												<TierText row={row} />
												<ChevronRight
													size={16}
													aria-hidden
													className="text-text-tertiary"
												/>
											</span>
										</div>
										{row.trial && (
											<p className="text-xs text-text-secondary">
												Trial: <TrialCell row={row} />
											</p>
										)}
										<dl className="grid grid-cols-2 gap-2 text-sm">
											{LIMIT_KEYS.map((k) => (
												<div key={k}>
													<dt className="text-xs text-text-tertiary">
														{LIMIT_LABELS[k]}
													</dt>
													<dd>
														<UsageCell
															meter={row.usage?.meters[k]}
															isMeter={isMeter(k)}
														/>
													</dd>
												</div>
											))}
										</dl>
									</li>
								))}
							</ul>
						</Card>
						<Pagination
							className="mt-4"
							page={page}
							pageSize={data.pageSize}
							total={data.total}
							onPageChange={(p) => update({ page: p > 1 ? String(p) : null }, false)}
						/>
					</>
				)
			)}
		</div>
	);
}
