import { useMemo, useState } from "react";
import type { SortDir } from "../util/sortUtil";

type SortType = "text" | "number" | "date";

export function useReportSort(
	numericKeys: readonly string[] = [],
	dateKeys: readonly string[] = [],
) {
	const [sortKey, setSortKey] = useState("");
	const [sortDir, setSortDir] = useState<SortDir>("asc");

	const sort = useMemo((): { sortKey?: string; sortDir?: SortDir; sortType?: SortType } => {
		if (!sortKey) return {};
		const sortType: SortType = dateKeys.includes(sortKey)
			? "date"
			: numericKeys.includes(sortKey)
				? "number"
				: "text";
		return { sortKey, sortDir, sortType };
	}, [sortKey, sortDir, numericKeys, dateKeys]);

	const onSortChange = (col: string) => {
		if (col === sortKey) setSortDir(sortDir === "asc" ? "desc" : "asc");
		else {
			setSortKey(col);
			setSortDir("asc");
		}
	};

	return { sort, tableProps: { sortKey, sortDir, onSortChange } };
}
