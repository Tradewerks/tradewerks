import Card from "../ui/Card";
import OpenDisputeRow from "../disputes/OpenDisputeRow";
import { useOpenDisputesQuery } from "../../hooks/useDisputes";

/** Silent on load and error: the dashboard widget is the attention surface of record. */
export default function ClientDisputesCard({ clientId }: { clientId: string }) {
	const { data } = useOpenDisputesQuery(clientId);
	if (!data || data.items.length === 0) return null;

	return (
		<Card
			title="Open Disputes"
			headerAction={<span className="text-sm tabular-nums text-text-muted">{data.total}</span>}
		>
			{/* Two across once the column stacks full width below xl, instead of stretching rows. */}
			<div className="@container -mx-4 -my-4 overflow-hidden">
				<ul className="-mt-px grid @2xl:grid-cols-2">
					{data.items.map((d) => (
						<OpenDisputeRow
							key={d.dispute_id}
							dispute={d}
							lead="document"
							className="border-t border-border-subtle @2xl:odd:not-last:border-r"
						/>
					))}
				</ul>
				{data.total > data.items.length && (
					<p className="px-4 py-2 border-t border-border-subtle text-xs text-text-muted">
						Showing the oldest {data.items.length} of {data.total}.
					</p>
				)}
			</div>
		</Card>
	);
}
