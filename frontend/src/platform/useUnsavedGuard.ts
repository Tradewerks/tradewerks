import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";

// The app runs on <BrowserRouter>, where useBlocker is unavailable, so in-app links are
// caught at the document instead. Browser back/forward is not caught; reload and close are.
export function useUnsavedGuard(active: boolean) {
	const navigate = useNavigate();
	const [pending, setPending] = useState<string | null>(null);

	useEffect(() => {
		if (!active) return;
		const onUnload = (e: BeforeUnloadEvent) => e.preventDefault();
		const onClick = (e: MouseEvent) => {
			if (e.defaultPrevented || e.button !== 0) return;
			if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
			const a = (e.target as Element | null)?.closest?.("a[href]");
			if (!(a instanceof HTMLAnchorElement) || a.target === "_blank") return;
			const url = new URL(a.href, window.location.href);
			if (url.origin !== window.location.origin) return;
			const to = `${url.pathname}${url.search}${url.hash}`;
			if (to === `${window.location.pathname}${window.location.search}`) return;
			e.preventDefault();
			setPending(to);
		};
		window.addEventListener("beforeunload", onUnload);
		document.addEventListener("click", onClick, true);
		return () => {
			window.removeEventListener("beforeunload", onUnload);
			document.removeEventListener("click", onClick, true);
		};
	}, [active]);

	return {
		pending,
		leave: () => {
			const to = pending;
			setPending(null);
			if (to) navigate(to);
		},
		stay: () => setPending(null),
	};
}
