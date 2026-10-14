import { lazy, Suspense, useEffect, useRef, useState } from "react";
import type { VisitStatus } from "./visitDemo";

// The dispatcher's map and live feed, fed by the same demo visit as the hero phone
// and the schedule board. Feed wording mirrors the app's (visitFeedUtils.ts).

interface FeedItem {
	title: string;
	detail?: string;
	when: string;
	fresh?: boolean;
}

const JOHNSON_EVENTS: Record<Exclude<VisitStatus, "Paused">, FeedItem> = {
	Driving: { title: "Johnson Residence visit started", detail: "Kevin Park en route", when: "just now" },
	OnSite: { title: "First arrival — Johnson Residence", detail: "Kevin Park on site", when: "just now" },
	InProgress: { title: "Work underway — Johnson Residence", when: "just now" },
	Completed: { title: "Johnson Residence visit completed", when: "just now" },
};

const ORDER: Exclude<VisitStatus, "Paused">[] = ["Driving", "OnSite", "InProgress", "Completed"];

const EARLIER: FeedItem[] = [
	{ title: "Smith Commercial Bldg 2 visit delayed", when: "12m ago" },
	{ title: "First arrival — Riverside Apartments LLC", detail: "John Smith on site", when: "41m ago" },
	{ title: "Work underway — Anderson Office Complex", when: "1h ago" },
	{ title: "Maria Rodriguez started shift", when: "1h ago" },
];

function feedFor(status: VisitStatus): FeedItem[] {
	const reached = ORDER.indexOf(status === "Paused" ? "InProgress" : status);
	const johnson = ORDER.slice(0, reached + 1)
		.map((s, i) => ({ ...JOHNSON_EVENTS[s], when: i === reached ? "just now" : "1m ago" }))
		.reverse();
	if (status === "Paused") {
		johnson.unshift({ title: "Johnson Residence visit paused", when: "just now" });
	}
	johnson[0] = { ...johnson[0], fresh: true };
	return [...johnson, ...EARLIER];
}

const LandingMap = lazy(() => import("./LandingMap"));
const HAS_MAPBOX = Boolean(import.meta.env.VITE_MAPBOX_TOKEN);

/** Mounts the real map only once it's near the viewport, so Mapbox isn't part of the first load. */
function MapSlot({ visitStatus }: { visitStatus: VisitStatus }) {
	const ref = useRef<HTMLDivElement>(null);
	const [near, setNear] = useState(false);

	useEffect(() => {
		const el = ref.current;
		if (!el || near) return;
		const io = new IntersectionObserver(
			([entry]) => {
				if (entry.isIntersecting) setNear(true);
			},
			{ rootMargin: "600px 0px" },
		);
		io.observe(el);
		return () => io.disconnect();
	}, [near]);

	const placeholder = <div className="h-full w-full bg-night-2" />;

	return (
		<div ref={ref} className="relative h-[440px] min-w-0 flex-[1_1_440px] overflow-hidden">
			{near && HAS_MAPBOX ? (
				<Suspense fallback={placeholder}>
					<LandingMap visitStatus={visitStatus} />
				</Suspense>
			) : (
				placeholder
			)}
		</div>
	);
}

/** Map + live feed for the dispatch section. */
export default function MapFeed({ visitStatus }: { visitStatus: VisitStatus }) {
	const feed = feedFor(visitStatus);
	return (
		<div className="flex flex-wrap overflow-hidden rounded-[14px] border border-line bg-white">
			<MapSlot visitStatus={visitStatus} />
			<div className="flex min-w-0 flex-[1_1_300px] flex-col border-t border-line bg-rail md:border-l md:border-t-0">
				<div className="flex items-center justify-between border-b border-line px-5 py-4">
					<div className="text-base font-bold">Live Updates</div>
					<div className="flex items-center gap-2 text-[13px] font-semibold text-brand-deep">
						<span aria-hidden="true" className="size-2 rounded-full bg-brand" />
						Live
					</div>
				</div>
				<ol
					aria-live="polite"
					aria-label="Live updates feed"
					className="m-0 flex list-none flex-col p-0"
				>
					{feed.slice(0, 6).map((item) => (
						<li
							key={`${item.title}${item.detail ?? ""}`}
							className={`grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 border-b border-line-soft px-5 py-3 last:border-b-0 ${item.fresh ? "landing-feed-in bg-highlight" : ""}`}
						>
							<div className="flex min-w-0 flex-col gap-0.5">
								<div className="text-sm font-semibold">
									{item.title}
								</div>
								{item.detail && (
									<div className="text-[13px] text-ink-3">
										{item.detail}
									</div>
								)}
							</div>
							<div className="whitespace-nowrap font-mono text-xs text-ink-4">
								{item.when}
							</div>
						</li>
					))}
				</ol>
			</div>
		</div>
	);
}
