import type { ReactNode } from "react";
import { LIMIT_LABELS } from "../limits";
import { showLimit } from "../breakdown";
import type { LimitKey, StaffChangePreview } from "../types";

const heading = "text-xs font-medium uppercase tracking-wide text-text-tertiary";
const limitLabel = (key: string) => LIMIT_LABELS[key as LimitKey] ?? key;

export function Section({ title, children }: { title: string; children: ReactNode }) {
	return (
		<div className="space-y-1">
			<p className={heading}>{title}</p>
			<ul className="space-y-1 text-sm text-text-primary">{children}</ul>
		</div>
	);
}

/** What a previewed change turns on and off, which limits move, and who ends up over a cap. */
export default function ChangeSummary({
	preview: p,
	moduleLabel,
}: {
	preview: StaffChangePreview;
	moduleLabel: (key: string) => string;
}) {
	return (
		<>
			{p.diff.lost.length > 0 && (
				<Section title="Turns off">
					{p.diff.lost.map((m) => {
						const b = p.blockers.find((x) => x.module === m);
						return (
							<li key={m}>
								{moduleLabel(m)}
								{b && (
									<p className="text-xs text-warning-text">
										{b.message}
									</p>
								)}
							</li>
						);
					})}
				</Section>
			)}
			{p.diff.gained.length > 0 && (
				<Section title="Turns on">
					{p.diff.gained.map((m) => (
						<li key={m}>{moduleLabel(m)}</li>
					))}
				</Section>
			)}
			{p.diff.lowered.length > 0 && (
				<Section title="Limits lowered">
					{p.diff.lowered.map((l) => (
						<li key={l.key}>
							{limitLabel(l.key)}: {showLimit(l.from)} →{" "}
							{showLimit(l.to)}
						</li>
					))}
				</Section>
			)}
			{p.diff.raised.length > 0 && (
				<Section title="Limits raised">
					{p.diff.raised.map((l) => (
						<li key={l.key}>
							{limitLabel(l.key)}: {showLimit(l.from)} →{" "}
							{showLimit(l.to)}
						</li>
					))}
				</Section>
			)}
			{p.overCap.length > 0 && (
				<Section title="Over the new cap">
					{p.overCap.map((o) => (
						<li key={o.key}>
							{o.key.endsWith("_month")
								? `${limitLabel(o.key)}: ${o.used} used this month, cap ${o.limit}. Blocked until the month ends.`
								: `${limitLabel(o.key)}: ${o.used} in use, cap ${o.limit}. Nobody is deactivated; they can't add more.`}
						</li>
					))}
				</Section>
			)}
		</>
	);
}
