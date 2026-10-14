export function UsageCell({
	meter,
	isMeter,
}: {
	meter?: { used: number; limit: number | null };
	isMeter: boolean;
}) {
	if (!meter) return <span className="text-text-tertiary">—</span>;
	const { used, limit } = meter;
	// Seats may sit at the cap; a monthly meter at the cap is already blocked.
	const over = limit !== null && (isMeter ? used >= limit : used > limit);
	const near = limit !== null && limit > 0 && used >= limit * 0.8;
	const tone = over ? "text-error-text" : near ? "text-warning-text" : "text-text-secondary";
	return (
		<span className={`tabular-nums ${tone}`}>
			{used} / {limit ?? "∞"}
		</span>
	);
}
