export default function SkeletonRows({ count = 3 }: { count?: number }) {
	return (
		<div className="space-y-2">
			{Array.from({ length: count }, (_, i) => (
				<div
					key={i}
					className="h-12 animate-pulse rounded bg-surface-inset"
				/>
			))}
		</div>
	);
}
