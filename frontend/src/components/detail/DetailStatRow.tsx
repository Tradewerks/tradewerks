import StatCard, { type StatCardProps } from "../ui/StatCard";

/**
 * The KPI strip at the top of a document's Overview, and the page's only
 * at-a-glance money surface.
 *
 * `flex-1` with a floor rather than a fixed column count, so three tiles fill
 * the row as thirds and four as quarters with no dead cell. `gap-4` to match
 * the Overview grid's gutter below: any other gap leaves the last tile
 * overhanging its column, reading as a strip less inset than its sections.
 */
export default function DetailStatRow({ tiles }: { tiles: StatCardProps[] }) {
	return (
		<div className="flex flex-wrap gap-4">
			{tiles.map((tile) => (
				<StatCard
					key={tile.label}
					radius="xl"
					{...tile}
					className={`flex-1 min-w-[160px] ${tile.className ?? ""}`}
				/>
			))}
		</div>
	);
}
