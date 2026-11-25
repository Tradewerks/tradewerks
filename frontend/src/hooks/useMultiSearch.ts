import { useState, useCallback, useRef, useEffect } from "react";
import { useSearchParams } from "react-router-dom";

const splitParts = (values: string[]) =>
	values.flatMap((v) => v.split(",").map((s) => s.trim()).filter(Boolean));

// splitCommas is for enum filters, where a dashboard link may write ?status=Sent,Viewed
// instead of the repeated params the dropdown writes. Free-text search must not use it:
// a typed term may contain a comma.
export function useMultiSearch(
	paramKey: string,
	{ replace = false, splitCommas = false }: { replace?: boolean; splitCommas?: boolean } = {}
) {
	const [searchParams, setSearchParams] = useSearchParams();
	const [duplicateTerm, setDuplicateTerm] = useState<string | null>(null);
	const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

	useEffect(() => () => {
		if (flashTimer.current) clearTimeout(flashTimer.current);
	}, []);

	const raw = searchParams.getAll(paramKey);
	const terms = splitCommas ? splitParts(raw) : raw;

	const addTerm = useCallback(
		(v: string): boolean => {
			const trimmed = v.trim();
			if (!trimmed) return false;

			if (terms.includes(trimmed)) {
				if (flashTimer.current) clearTimeout(flashTimer.current);
				setDuplicateTerm(trimmed);
				flashTimer.current = setTimeout(() => setDuplicateTerm(null), 600);
				return false;
			}

			setSearchParams((prev) => {
				const next = new URLSearchParams(prev);
				if (splitCommas) {
					// Rewrite a comma-joined value as repeated params so the URL has one shape.
					const flat = splitParts(next.getAll(paramKey));
					next.delete(paramKey);
					flat.forEach((t) => next.append(paramKey, t));
				}
				next.append(paramKey, trimmed);
				return next;
			}, { replace });
			return true;
		},
		[paramKey, terms, setSearchParams, replace, splitCommas]
	);

	const removeTerm = useCallback(
		(v: string) => {
			setSearchParams((prev) => {
				const next = new URLSearchParams(prev);
				// A comma-joined value (?status=New,Quoted, as dashboard links write it)
				// shows as one chip per part, so removing a part rewrites the rest.
				const remaining = next.getAll(paramKey).flatMap((t) => {
					if (t === v) return [];
					const parts = t.split(",").map((p) => p.trim());
					return parts.length > 1 && parts.includes(v) ? parts.filter((p) => p && p !== v) : [t];
				});
				next.delete(paramKey);
				remaining.forEach((t) => next.append(paramKey, t));
				return next;
			}, { replace });
		},
		[paramKey, setSearchParams, replace]
	);

	const clearAll = useCallback(() => {
		setSearchParams((prev) => {
			const next = new URLSearchParams(prev);
			next.delete(paramKey);
			return next;
		}, { replace });
	}, [paramKey, setSearchParams, replace]);

	return { terms, addTerm, removeTerm, clearAll, duplicateTerm };
}
