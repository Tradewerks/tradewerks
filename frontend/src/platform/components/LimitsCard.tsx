import { useState } from "react";
import Card from "../../components/ui/Card";
import SegmentedToggle from "../../components/ui/SegmentedToggle";
import { inputClass } from "./AuthCard";
import { LIMIT_KEYS, LIMIT_LABELS } from "../limits";
import {
	initialMode,
	limitSourceLine,
	nextOverride,
	showLimit,
	type LimitMode,
} from "../breakdown";
import { flash, smallButton, type OpenChange } from "./orgDetailUi";
import type { LimitKey, OrgDetail } from "../types";

function LimitRow({
	limitKey,
	detail,
	open,
	changed,
}: {
	limitKey: LimitKey;
	detail: OrgDetail;
	open: OpenChange;
	changed: boolean;
}) {
	const overrides = detail.entitlement?.limit_overrides ?? {};
	const override = Object.prototype.hasOwnProperty.call(overrides, limitKey)
		? overrides[limitKey]
		: undefined;
	const b = detail.breakdown?.limits[limitKey];
	const effective = b ? b.effective : (detail.resolved.limits[limitKey] ?? null);
	const label = LIMIT_LABELS[limitKey];
	const [edit, setEdit] = useState<{ mode: LimitMode; value: string } | null>(null);
	const next = edit ? nextOverride(edit.mode, edit.value, override) : undefined;
	const source = b
		? limitSourceLine(b)
		: override !== undefined
			? `Override ${showLimit(override)}`
			: "";

	const startEdit = () =>
		setEdit({
			mode: initialMode(override),
			value: String(override ?? b?.tier ?? effective ?? ""),
		});
	const title = (o: number | null | "tier") =>
		o === "tier"
			? `${label}: use tier value${b ? ` (${showLimit(b.tier)})` : ""}`
			: o === null
				? `${label}: unlimited`
				: `${label}: set to ${o}`;

	return (
		<li className={`space-y-2 py-2 ${changed ? flash : ""}`}>
			<div className="flex flex-wrap items-center justify-between gap-2">
				<div className="min-w-0 text-sm">
					<p className="text-text-primary">{label}</p>
					<p className="text-xs text-text-tertiary">
						{source}
						{changed && " · Changed just now"}
					</p>
				</div>
				<div className="flex items-center gap-3">
					<span className="text-sm font-medium tabular-nums text-text-primary">
						{effective === null
							? "Unlimited"
							: `Effective ${effective}`}
					</span>
					{!edit && (
						<button
							type="button"
							className={smallButton}
							onClick={startEdit}
						>
							Edit
						</button>
					)}
				</div>
			</div>
			{edit && (
				<div className="flex flex-wrap items-center gap-2">
					<SegmentedToggle<LimitMode>
						ariaLabel={`${label} limit mode`}
						value={edit.mode}
						options={[
							{ id: "tier", label: "Tier value" },
							{ id: "custom", label: "Custom" },
							{ id: "unlimited", label: "Unlimited" },
						]}
						onChange={(mode) => setEdit({ ...edit, mode })}
					/>
					{edit.mode === "custom" && (
						<input
							type="number"
							min={0}
							step={1}
							aria-label={`${label} limit`}
							className={`${inputClass} w-28`}
							value={edit.value}
							onChange={(ev) =>
								setEdit({
									...edit,
									value: ev.target.value,
								})
							}
						/>
					)}
					<button
						type="button"
						className={smallButton}
						disabled={next === undefined}
						onClick={() => {
							if (next === undefined) return;
							open({
								change: {
									kind: "limit",
									key: limitKey,
									override: next,
								},
								title: title(next),
							});
							setEdit(null);
						}}
					>
						Review change
					</button>
					<button
						type="button"
						className={smallButton}
						onClick={() => setEdit(null)}
					>
						Cancel
					</button>
				</div>
			)}
		</li>
	);
}

export default function LimitsCard({
	detail,
	open,
	changed,
}: {
	detail: OrgDetail;
	open: OpenChange;
	changed: Set<string>;
}) {
	return (
		<Card title="Limits">
			<ul className="divide-y divide-border-subtle">
				{LIMIT_KEYS.map((k) => (
					<LimitRow
						key={k}
						limitKey={k}
						detail={detail}
						open={open}
						changed={changed.has(k)}
					/>
				))}
			</ul>
		</Card>
	);
}
