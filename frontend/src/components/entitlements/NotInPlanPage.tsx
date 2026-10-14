import { Link } from "react-router-dom";
import { usePermission } from "../../hooks/usePermission";
import { SUBSCRIPTION_PATH } from "../../lib/moduleGroups";

export default function NotInPlanPage({
	label,
	description,
	home,
}: {
	label: string;
	description?: string;
	home: string;
}) {
	const canManage = usePermission("manage_organization");
	return (
		<div className="mx-auto max-w-md py-24 text-center">
			<h1 className="text-lg font-semibold text-text-primary">
				{label} isn&rsquo;t part of your subscription
			</h1>
			{description && <p className="mt-2 text-sm text-text-secondary">{description}</p>}
			{canManage ? (
				<Link
					to={SUBSCRIPTION_PATH}
					className="mt-5 inline-block rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-on-primary transition-colors hover:bg-primary-hover"
				>
					Open Subscription
				</Link>
			) : (
				<p className="mt-4 text-sm text-text-secondary">
					Ask an administrator in your organization about adding it.
				</p>
			)}
			<div className="mt-4">
				<Link to={home} className="text-sm font-medium text-primary hover:underline">
					Back to home
				</Link>
			</div>
		</div>
	);
}
