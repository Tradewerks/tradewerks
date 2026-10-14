import { useState } from "react";
import { Link } from "react-router-dom";
import { ChevronRight } from "lucide-react";
import { FormErrorBanner } from "../../components/ui/forms/FormErrorBanner";
import { useToast } from "../../components/ui/useToast";
import { platform, platformError } from "../api";
import { useCatalog, useTierMutation, useTiers } from "../hooks";
import { useRowOpen } from "../rowOpen";
import { tierFlags } from "../tierForm";
import TierContentsForm from "../components/TierContentsForm";
import { chip, smallButton } from "../components/orgDetailUi";
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
		<div className="space-y-4">
			<div className="flex items-center justify-between gap-2">
				<h1 className="text-lg font-semibold text-text-primary">Tiers</h1>
				<button
					type="button"
					className={smallButton}
					onClick={() => setCreating(true)}
				>
					Create tier
				</button>
			</div>
			{tiers.error && <FormErrorBanner message={platformError(tiers.error)} />}
			{tiers.isLoading ? (
				<SkeletonRows />
			) : (
				<ul className="space-y-2">
					{(tiers.data ?? []).map((t) => (
						<li
							key={t.key}
							onClick={(ev) =>
								openRow(
									ev,
									`/platform/tiers/${t.key}`
								)
							}
							className="flex cursor-pointer items-center gap-3 rounded-lg border border-border bg-surface p-3 transition-colors duration-150 ease-out hover:bg-surface-inset"
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
									{tierFlags(t).map((f) => (
										<span
											key={f}
											className={
												chip
											}
										>
											{f}
										</span>
									))}
								</div>
								<p className="text-xs text-text-secondary tabular-nums">
									{t.versions
										.filter(
											(v, i) =>
												i ===
													0 ||
												v.org_count >
													0
										)
										.map(
											(v) =>
												`v${v.version} · ${v.org_count} org${v.org_count === 1 ? "" : "s"}`
										)
										.join(" · ")}
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
