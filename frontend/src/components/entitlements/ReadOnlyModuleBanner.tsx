import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { usePermission } from "../../hooks/usePermission";
import { SUBSCRIPTION_PATH } from "../../lib/moduleGroups";
import ModuleNotice from "./ModuleNotice";

export default function ReadOnlyModuleBanner({ label }: { label: string }) {
	const { t } = useTranslation();
	const canManage = usePermission("manage_organization");
	return (
		<ModuleNotice
			title={
				<>
					{t("plan.turnedOff", { label })}
					{!canManage && ` ${t("plan.adminCanTurnOn")}`}
				</>
			}
			action={
				canManage ? (
					<Link
						to={SUBSCRIPTION_PATH}
						className="text-xs font-medium text-primary hover:underline"
					>
						{t("plan.turnOn")}
					</Link>
				) : null
			}
		/>
	);
}
