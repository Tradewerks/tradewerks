import { useState } from "react";
import { Link } from "react-router-dom";
import { Building2, ChevronRight } from "lucide-react";
import Card from "../../components/ui/Card";
import EmptyState from "../../components/ui/EmptyState";
import Pagination from "../../components/ui/Pagination";
import SegmentedToggle from "../../components/ui/SegmentedToggle";
import { FormErrorBanner } from "../../components/ui/forms/FormErrorBanner";
import { HEADER_BTN_SECONDARY } from "../../components/ui/headerActions";
import { platformError } from "../api";
import { useOrgs } from "../hooks";
import { useRowOpen } from "../rowOpen";
import { shortDateIn } from "../../lib/trialDays";
import { chip } from "./orgDetailUi";
import SkeletonRows from "./SkeletonRows";
import type { TierRow } from "../types";

interface TierOrgsPanelProps {
	tier: TierRow;
	/** Version number to show, or null for every version. */
	version: number | null;
	onVersionChange: (version: number | null) => void;
}

export default function TierOrgsPanel({ tier, version, onVersionChange }: TierOrgsPanelProps) {
	const [page, setPage] = useState(1);
	const openRow = useRowOpen();
	const orgs = useOrgs("", page, false, { key: tier.key, version: version ?? undefined });
	const inUse = tier.versions.filter((v) => v.org_count > 0);
	const total = tier.versions.reduce((n, v) => n + v.org_count, 0);
	const listUrl = `/platform/orgs?tier=${encodeURIComponent(tier.key)}${version ? `&version=${version}` : ""}`;
	const setVersion = (v: number | null) => {
		setPage(1);
		onVersionChange(v);
	};

	return (
		<Card
			title="Organizations on this tier"
			flush
			headerAction={
				<Link to={listUrl} className={HEADER_BTN_SECONDARY}>
					Open in Organizations
				</Link>
			}
		>
			{inUse.length > 1 && (
				<div className="border-b border-border-subtle px-4 py-3">
					<SegmentedToggle<string>
						ariaLabel="Tier version"
						value={version ? String(version) : "all"}
						options={[
							{ id: "all", label: "All versions", badge: total },
							...inUse.map((v) => ({
								id: String(v.version),
								label: `v${v.version}`,
								badge: v.org_count,
							})),
						]}
						onChange={(id) => setVersion(id === "all" ? null : Number(id))}
					/>
				</div>
			)}
			{orgs.error ? (
				<div className="p-4">
					<FormErrorBanner message={platformError(orgs.error)} />
				</div>
			) : orgs.isLoading ? (
				<div className="p-4">
					<SkeletonRows />
				</div>
			) : !orgs.data || orgs.data.rows.length === 0 ? (
				<EmptyState
					icon={<Building2 size={28} />}
					title={`No organizations are on ${tier.label}${version ? ` v${version}` : ""}.`}
				/>
			) : (
				<ul className="divide-y divide-border-subtle">
					{orgs.data.rows.map((row) => (
						<li
							key={row.id}
							onClick={(ev) => openRow(ev, `/platform/orgs/${row.id}`)}
							className="flex cursor-pointer items-center gap-3 px-4 py-3 text-sm transition-colors duration-150 ease-out hover:bg-surface-raised"
						>
							<Link
								to={`/platform/orgs/${row.id}`}
								className="min-w-0 truncate font-medium text-text-primary hover:text-primary hover:underline"
							>
								{row.name}
							</Link>
							{row.tier && <span className={chip}>v{row.tier.version}</span>}
							{row.trial && (
								<span className="text-xs text-text-tertiary">
									Trial: {row.trial.tierLabel} until{" "}
									{shortDateIn(row.trial.endsAt, row.timezone)}
								</span>
							)}
							<ChevronRight
								size={16}
								aria-hidden
								className="ml-auto shrink-0 text-text-tertiary"
							/>
						</li>
					))}
				</ul>
			)}
			{orgs.data && (
				<div className="border-t border-border-subtle px-4 py-2 empty:hidden">
					<Pagination
						page={page}
						pageSize={orgs.data.pageSize}
						total={orgs.data.total}
						onPageChange={setPage}
					/>
				</div>
			)}
		</Card>
	);
}
