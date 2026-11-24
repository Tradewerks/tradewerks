import { useCallback, useMemo, useState } from "react";
import ScheduleBoard from "../../components/ui/schedule/ScheduleBoard";
import { boardToOccurrences } from "../../components/ui/schedule/dashboardCalendarUtils";
import { localDateKey } from "../../components/ui/schedule/scheduleBoardUtils";
import { useBoardQuery } from "../../hooks/useJobs";
import { useActiveTechniciansQuery } from "../../hooks/useTechnicians";

interface Range {
	from: Date;
	to: Date;
}

const NO_VISITS: never[] = [];

export default function SchedulePage() {
	// The board reports the span it is showing (it may open on a linked week), so
	// nothing is fetched until it has.
	const [range, setRange] = useState<Range | null>(null);
	const onRangeChange = useCallback((from: Date, to: Date) => {
		setRange((prev) =>
			prev && prev.from.getTime() === from.getTime() && prev.to.getTime() === to.getTime()
				? prev
				: { from, to },
		);
	}, []);
	const idle = useMemo(() => new Date(0), []);
	const { data: board, error: boardError } = useBoardQuery(range?.from ?? idle, range?.to ?? idle, {
		enabled: !!range,
	});
	const { data: technicians = [], error: techsError } = useActiveTechniciansQuery();
	const occurrences = useMemo(
		() => boardToOccurrences(board?.occurrences ?? [], localDateKey(new Date())),
		[board],
	);

	return (
		<div
			data-page-width="full"
			className="h-[calc(100%+2rem)] md:h-[calc(100%+3rem)] overflow-hidden -m-4 md:-m-6"
		>
			{(boardError || techsError) && (
				<p className="text-error-text px-6 py-2 text-sm">Failed to load schedule data.</p>
			)}
			<ScheduleBoard
				visits={board?.visits ?? NO_VISITS}
				occurrences={occurrences}
				technicians={technicians}
				onRangeChange={onRangeChange}
			/>
		</div>
	);
}
