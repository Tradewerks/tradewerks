import { Link } from "react-router-dom";
import { usePermission } from "../../hooks/usePermission";
import { SUBSCRIPTION_PATH } from "../../lib/moduleGroups";
import ModuleNotice from "./ModuleNotice";

export default function ReadOnlyModuleBanner({ label }: { label: string }) {
	const canManage = usePermission("manage_organization");
	return (
		<ModuleNotice
			title={
				<>
					{label} is turned off for your organization. This record is read-only.
					{!canManage && " An administrator can turn it back on."}
				</>
			}
			action={
				canManage ? (
					<Link
						to={SUBSCRIPTION_PATH}
						className="text-xs font-medium text-primary hover:underline"
					>
						Turn on in Subscription
					</Link>
				) : null
			}
		/>
	);
}
