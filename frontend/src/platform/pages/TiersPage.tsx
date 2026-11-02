import { useState } from "react";
import { Link } from "react-router-dom";
import { ChevronRight, Layers, Plus } from "lucide-react";
import Card from "../../components/ui/Card";
import EmptyState from "../../components/ui/EmptyState";
import PageHeader from "../../components/ui/PageHeader";
import { FormErrorBanner } from "../../components/ui/forms/FormErrorBanner";
import { useToast } from "../../components/ui/useToast";
import { platform, platformError } from "../api";
import { useCatalog, useTierMutation, useTiers } from "../hooks";
import { useRowOpen } from "../rowOpen";
import { tierFlags } from "../tierForm";
import TierContentsForm from "../components/TierContentsForm";
import { chip, pageAction } from "../components/orgDetailUi";
import SkeletonRows from "../components/SkeletonRows";
import type { TierContents } from "../types";

export default function TiersPage() {
	const tiers = useTiers();
	const catalog = useCatalog();
	const openRow = useRowOpen();
	const toast = useToast();
	const [creating, setCreating] = useState(false);
	const create = useTierMutation(
		(b: TierContents & { key: string; label: string; note: string }) =>
			platform.createTier(b)
	);
	return (
		<div className="text-text-primary">
			<PageHeader title="Tiers">
				<button
					type="button"
					className={pageAction}
					onClick={() => setCreating(true)}
				>
					<Plus size={16} />
					Create tier
				</button>
			</PageHeader>
			{tiers.error && (
				<FormErrorBanner
					className="mb-4"
					message={platformError(tiers.error)}
				/>
			)}
			{tiers.isLoading ? (
				<Card flush>
					<div className="p-4">
						<SkeletonRows />
					</div>
				</Card>
			) : (
				<Card flush>
					{tiers.data?.length === 0 && (
						<EmptyState icon={<Layers size={28} />} title="No tiers yet." />
					)}
					<ul className="divide-y divide-border-subtle">
						{(tiers.data ?? []).map((t) => (
							<li
								key={t.key}
								onClick={(ev) =>
									openRow(
										ev,
										`/platform/tiers/${t.key}`
									)
								}
								className="flex cursor-pointer items-center gap-3 px-4 py-3 transition-colors duration-150 ease-out hover:bg-surface-raised"
							>
								<div className="min-w-0 flex-1 space-y-1">
									<div className="flex flex-wrap items-center gap-2 text-sm">
										<Link
											to={`/platform/tiers/${t.key}`}
											className="font-medium text-text-primary hover:text-primary hover:underline"
										>
											{t.label}
										</Link>
										<span className="text-xs text-text-tertiary">
											{t.key}
										</span>
										{tierFlags(t).map(
											(f) => (
												<span
													key={
														f
													}
													className={
														chip
													}
												>
													{
														f
													}
												</span>
											)
										)}
									</div>
									<p className="text-xs text-text-secondary tabular-nums">
										{t.versions
											.filter(
												(
													v,
													i
												) =>
													i ===
														0 ||
													v.org_count >
														0
											)
											.map(
												(
													v
												) =>
													`v${v.version} · ${v.org_count} org${v.org_count === 1 ? "" : "s"}`
											)
											.join(
												" · "
											)}
									</p>
								</div>
								<ChevronRight
									size={16}
									aria-hidden
									className="shrink-0 text-text-tertiary"
								/>
							</li>
						))}
					</ul>
				</Card>
			)}
			<TierContentsForm
				open={creating}
				mode="create"
				title="Create tier"
				catalog={catalog.data ?? []}
				initial={null}
				pending={create.isPending}
				error={create.error ? platformError(create.error) : null}
				onClose={() => setCreating(false)}
				onSubmit={(v) =>
					create.mutate(
						v as TierContents & {
							key: string;
							label: string;
							note: string;
						},
						{
							onSuccess: () => {
								toast.success(
									`Tier ${v.label} created`
								);
								setCreating(false);
							},
						}
					)
				}
			/>
		</div>
	);
}
