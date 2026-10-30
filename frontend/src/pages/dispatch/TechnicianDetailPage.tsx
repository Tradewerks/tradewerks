import { useId, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { isAxiosError } from "axios";
import { ArrowLeft, BarChart3, CalendarPlus } from "lucide-react";
import DetailHeader from "../../components/detail/DetailHeader";
import DetailTabs, { type DetailTabDef } from "../../components/detail/DetailTabs";
import { useDetailTab } from "../../components/detail/useDetailTab";
import EditTechnicianModal from "../../components/technicians/EditTechnician";
import TechnicianNowStrip from "../../components/technicians/TechnicianNowStrip";
import TechnicianAccessTab from "../../components/technicians/detail/TechnicianAccessTab";
import TechnicianActivityTab from "../../components/technicians/detail/TechnicianActivityTab";
import TechnicianOverviewTab from "../../components/technicians/detail/TechnicianOverviewTab";
import TechnicianScheduleTab from "../../components/technicians/detail/TechnicianScheduleTab";
import TechnicianVehicleTab from "../../components/technicians/detail/TechnicianVehicleTab";
import { NAV_BUTTON } from "../../components/technicians/detail/navButtons";
import { Avatar, MfaMark } from "../../components/technicians/TechnicianBits";
import { formatHireDate, formatTenure } from "../../components/technicians/technicianFormat";
import { countActiveVisits } from "../../components/technicians/technicianSchedule";
import {
	armedAnnouncement,
	technicianMenuGroups,
	useArmedConfirm,
} from "../../components/technicians/technicianActions";
import { NO_PERMISSION } from "../../components/lifecycle/actionBuilder";
import {
	useTechnicianByIdQuery,
	useDeleteTechnicianMutation,
	useDeactivateTechnicianMutation,
	useReactivateTechnicianMutation,
} from "../../hooks/useTechnicians";
import { useResetMfaMutation } from "../../hooks/useMfa";
import { usePermission } from "../../hooks/usePermission";
import { useToast } from "../../components/ui/useToast";
import { requestPasswordResetCall } from "../../api/authenticate";
import { TechnicianStatusColors, TechnicianStatusLabels } from "../../types/technicians";
import { errorMessage } from "../../util/util";

type TechTab = "overview" | "schedule" | "vehicle" | "access" | "activity";

const TECH_TABS: readonly DetailTabDef<TechTab>[] = [
	{ id: "overview", label: "Overview" },
	{ id: "schedule", label: "Schedule" },
	{ id: "vehicle", label: "Vehicle" },
	{ id: "access", label: "Access" },
	{ id: "activity", label: "Activity" },
];

// LifecycleBar's primary ActionButton — the button JobDetailPage's header renders —
// so the one primary move on every detail page reads identically.
const PRIMARY_BUTTON =
	"inline-flex items-center gap-1.5 rounded-md bg-primary-hover px-3 py-1.5 text-sm font-medium text-on-primary transition-colors duration-150 ease-out hover:bg-primary";
// LifecycleBar's DISABLED_CLASSES: muted chrome and text token, never opacity.
const DISABLED_BUTTON =
	"inline-flex cursor-not-allowed items-center gap-1.5 rounded-md border border-border-subtle bg-transparent px-3 py-1.5 text-sm font-medium text-text-muted";

function PageSkeleton() {
	return (
		<div aria-busy="true" aria-label="Loading technician" className="space-y-4">
			<div className="flex items-center gap-4">
				<div className="h-14 w-14 animate-pulse rounded-xl bg-surface" />
				<div className="h-7 w-56 animate-pulse rounded bg-surface" />
			</div>
			<div className="h-20 animate-pulse rounded-xl bg-surface" />
			<div className="h-10 animate-pulse rounded-lg bg-surface" />
		</div>
	);
}

export default function TechnicianDetailsPage() {
	const { technicianId } = useParams<{ technicianId: string }>();
	const navigate = useNavigate();
	const toast = useToast();
	const assignReasonId = useId();
	const [activeTab, setActiveTab] = useDetailTab(TECH_TABS);
	const [isEditOpen, setIsEditOpen] = useState(false);
	const { armed, confirm, disarm } = useArmedConfirm();
	const [sendingReset, setSendingReset] = useState(false);

	const canManage = usePermission("manage_technicians");
	const canSeeReports = usePermission("view_reports");
	const {
		data: technician,
		isLoading,
		error,
		refetch,
	} = useTechnicianByIdQuery(technicianId);
	const deleteTechnician = useDeleteTechnicianMutation();
	const deactivateMutation = useDeactivateTechnicianMutation();
	const reactivateMutation = useReactivateTechnicianMutation();
	const { mutateAsync: resetMFA, isPending: resettingMfa } = useResetMfaMutation();

	if (isLoading) return <PageSkeleton />;

	if (error || !technician) {
		const notFound =
			!error ||
			(isAxiosError(error) && error.response?.status === 404) ||
			error.message === "Technician not found";
		return (
			<div className="space-y-3">
				<p className="text-text-primary">
					{notFound
						? "Technician not found"
						: "Couldn't load this technician."}
				</p>
				{notFound ? (
					<Link to="/dispatch/technicians" className={NAV_BUTTON}>
						<ArrowLeft size={14} aria-hidden /> Back to
						Technicians
					</Link>
				) : (
					<button
						type="button"
						onClick={() => refetch()}
						className={NAV_BUTTON}
					>
						Retry
					</button>
				)}
			</div>
		);
	}

	const menuGroups = technicianMenuGroups({
		name: technician.name,
		canManage,
		mfaEnabled: !!technician.mfaEnabled,
		activeVisitCount: countActiveVisits(technician.visit_techs ?? []),
		deactivated: !!technician.deactivated_at,
		armed,
		pending: {
			resetPassword: sendingReset,
			resetMfa: resettingMfa,
			delete: deleteTechnician.isPending,
			toggleActive: deactivateMutation.isPending || reactivateMutation.isPending,
		},
		on: {
			edit: () => setIsEditOpen(true),
			"reset-password": confirm("reset-password", async () => {
				setSendingReset(true);
				try {
					await requestPasswordResetCall(technician.id, "technician");
					toast.success(
						`Password reset email sent to ${technician.email}`
					);
				} catch (e) {
					toast.error(
						e instanceof Error
							? e.message
							: "Failed to send the reset email"
					);
				} finally {
					setSendingReset(false);
				}
			}),
			"reset-mfa": confirm("reset-mfa", async () => {
				try {
					await resetMFA({
						userId: technician.id,
						role: "technician",
					});
					toast.success("MFA reset");
				} catch (e) {
					toast.error(
						e instanceof Error
							? e.message
							: "Failed to reset MFA"
					);
				}
			}),
			deactivate: confirm("deactivate", async () => {
				try {
					await deactivateMutation.mutateAsync(technician.id);
					toast.success(
						`${technician.name} deactivated. Signed out within 30 seconds and removed from scheduling; history is kept.`
					);
				} catch (e) {
					toast.error(errorMessage(e, "Couldn't deactivate"));
				}
			}),
			reactivate: async () => {
				try {
					await reactivateMutation.mutateAsync(technician.id);
					toast.success(`${technician.name} reactivated.`);
				} catch (e) {
					toast.error(errorMessage(e, "Couldn't reactivate"));
				}
			},
			// Navigate only on success so a failed delete leaves the dispatcher here with the error.
			delete: confirm("delete", async () => {
				try {
					await deleteTechnician.mutateAsync(technician.id);
					toast.success(`${technician.name} deleted`);
					navigate("/dispatch/technicians", { replace: true });
				} catch (e) {
					toast.error(
						e instanceof Error
							? e.message
							: "Failed to delete technician"
					);
				}
			}),
		},
	});

	// A refetch can shut the armed item (the delete guard gaining a visit); a
	// stale arm would otherwise fire on the first press once it reopens.
	const armedItem = armed
		? menuGroups.flatMap((g) => g.items).find((i) => i.id === armed)
		: undefined;
	if (armedItem?.disabled) disarm();

	const hired = formatHireDate(technician.hire_date);
	const assignBlocked = canManage
		? technician.deactivated_at
			? "Inactive technicians can't be scheduled."
			: null
		: NO_PERMISSION;

	return (
		<div className="text-text-primary">
			<div className="space-y-4">
				{/* DetailHeader has no leading slot, so the avatar sits beside it. */}
				<div className="flex items-start gap-4">
					<Avatar technician={technician} size="xl" />
					<div className="min-w-0 flex-1">
						<DetailHeader
							title={technician.name}
							badges={
								<>
									{technician
										.organization_role
										?.name && (
										<span className="rounded-full border border-border px-2 py-0.5 text-xs text-text-secondary">
											{
												technician
													.organization_role
													.name
											}
										</span>
									)}
									<MfaMark
										enabled={
											technician.mfaEnabled
										}
									/>
								</>
							}
							meta={
								<span className="tabular-nums">
									{[
										technician.title,
										`Hired ${hired} (${formatTenure(technician.hire_date)})`,
										technician
											.current_vehicle
											?.name ??
											"No vehicle",
									]
										.filter(Boolean)
										.join(" · ")}
								</span>
							}
							statusPill={
								<span
									className={`inline-flex items-center rounded-full border px-3 py-1.5 text-sm font-medium ${TechnicianStatusColors[technician.status]}`}
								>
									{
										TechnicianStatusLabels[
											technician
												.status
										]
									}
								</span>
							}
							inlineActions={
								<>
									{canSeeReports && (
										<Link
											to={`/dispatch/reporting/technician-scorecard?techId=${technician.id}`}
											className={
												NAV_BUTTON
											}
										>
											<BarChart3
												size={
													14
												}
												aria-hidden
											/>{" "}
											Scorecard
										</Link>
									)}
									{!assignBlocked ? (
										<Link
											to={`/dispatch/technicians/${technician.id}/assign`}
											className={
												PRIMARY_BUTTON
											}
										>
											<CalendarPlus
												size={
													14
												}
												aria-hidden
											/>{" "}
											Assign
											Visits
										</Link>
									) : (
										<div className="flex flex-col items-end">
											{/* Focusable, not a dead span, so keyboard users
											    reach the button and hear its reason. */}
											<button
												type="button"
												aria-disabled="true"
												aria-describedby={
													assignReasonId
												}
												className={
													DISABLED_BUTTON
												}
											>
												<CalendarPlus
													size={
														14
													}
													aria-hidden
												/>{" "}
												Assign
												Visits
											</button>
											<span
												id={
													assignReasonId
												}
												className="mt-0.5 text-xs text-text-muted"
											>
												{
													assignBlocked
												}
											</span>
										</div>
									)}
								</>
							}
							menuGroups={menuGroups}
							menuLabel="Technician actions"
							onMenuClose={disarm}
						/>
					</div>
				</div>
				{technician.deactivated_at && (
					<div
						role="status"
						className="rounded border border-border bg-surface-inset px-3 py-2 text-sm text-text-secondary"
					>
						Inactive — this technician can&apos;t sign in or be scheduled.
					</div>
				)}
				{/* The armed label changes inside an open menu, which a screen reader
				    doesn't re-read on its own. */}
				<p aria-live="polite" className="sr-only">
					{armedAnnouncement(armed, technician.name)}
				</p>
				<TechnicianNowStrip technician={technician} />
				<DetailTabs
					tabs={TECH_TABS}
					activeTab={activeTab}
					onSelect={setActiveTab}
					label="Technician sections"
				/>
			</div>

			{activeTab === "overview" && (
				<TechnicianOverviewTab technician={technician} />
			)}
			{activeTab === "schedule" && (
				<TechnicianScheduleTab technician={technician} />
			)}
			{activeTab === "vehicle" && (
				<TechnicianVehicleTab technician={technician} />
			)}
			{activeTab === "access" && <TechnicianAccessTab technician={technician} />}
			{activeTab === "activity" && (
				<TechnicianActivityTab technician={technician} />
			)}

			<EditTechnicianModal
				isOpen={isEditOpen}
				onClose={() => setIsEditOpen(false)}
				technician={technician}
			/>
		</div>
	);
}
