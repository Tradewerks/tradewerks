import { useSearchParams } from "react-router-dom";
import type { DetailTabDef } from "./DetailTabs";

/**
 * Tab lives in the URL, not component state, so a view is linkable. Unknown or
 * absent values fall back to the first tab rather than rendering nothing, and
 * the first tab's id is left out of the query string so `?tab=overview` and no
 * param don't become two shareable spellings of one view.
 */
export function useDetailTab<T extends string>(
	tabs: readonly DetailTabDef<T>[]
): [T, (tab: T) => void] {
	const [searchParams, setSearchParams] = useSearchParams();
	const param = searchParams.get("tab");
	const active: T = tabs.some((t) => t.id === param) ? (param as T) : tabs[0].id;

	const setActive = (tab: T) => {
		const next = new URLSearchParams(searchParams);
		if (tab === tabs[0].id) next.delete("tab");
		else next.set("tab", tab);
		// replace, not push — tabs are a lens on one page, not navigation. Pushing
		// made back unwind every tab the dispatcher had read through before it
		// would leave the page they actually came from.
		setSearchParams(next, { replace: true });
	};

	return [active, setActive];
}
