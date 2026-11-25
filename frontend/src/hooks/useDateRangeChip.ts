import { useSearchParams } from "react-router-dom";
import type { FilterChip } from "../components/ui/FilterChips";
import {
	formatTriggerLabel,
	parseDateRangeFromParams,
	serializeDateRange,
} from "../util/dateRangeUtils";

/** Active-filter chip for a URL-mode DateRangeFilter; null while the range is "All". */
export function useDateRangeChip(paramKey: string, label = "Date"): FilterChip | null {
	const [searchParams, setSearchParams] = useSearchParams();
	const value = parseDateRangeFromParams(searchParams, paramKey);
	if (value.option === "all") return null;
	return {
		label: `${label}: ${formatTriggerLabel(value)}`,
		color: "blue",
		onRemove: () =>
			setSearchParams((prev) => serializeDateRange({ option: "all" }, paramKey, prev)),
	};
}
