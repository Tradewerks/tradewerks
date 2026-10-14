import { useNavigate } from "react-router-dom";
import { useMaintenanceAlertsQuery } from "../../hooks/useVehicleStock";
import { AlertCard, EmptyState } from "../vehicles/VehicleAlertsSidebar";
import Card from "../ui/Card";

export default function MaintenanceRemindersWidget() {
	const navigate = useNavigate();
	const { data: alerts = [] } = useMaintenanceAlertsQuery();

	const openAlerts = alerts.filter((a) => !a.acknowledged);
	const overdueCount = openAlerts.filter((a) => a.status === "overdue").length;
	const maintenanceTotal = openAlerts.length;

	return (
		<Card
			title="Maintenance Reminders"
			className="h-full pb-3"
			scrollable
			headerAction={
				maintenanceTotal > 0 ? (
					<span className="text-xs text-text-muted">
						{overdueCount > 0 && <span className="text-error-text font-medium">{overdueCount} overdue · </span>}
						{maintenanceTotal} open
					</span>
				) : undefined
			}
		>
			{alerts.length === 0 ? (
				<EmptyState label="Nothing due" hint="No overdue or upcoming reminders" />
			) : (
				<div className="flex flex-col gap-2">
					{alerts.map((alert) => (
						<AlertCard
							key={alert.reminderId}
							alert={alert}
							onClick={() => navigate(`/dispatch/vehicles/${alert.vehicleId}/stock?tab=maintenance`)}
						/>
					))}
				</div>
			)}
		</Card>
	);
}
