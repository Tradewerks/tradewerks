import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { XCircle, Loader2 } from "lucide-react";
import { useQBStatusQuery, useQBConnectMutation, useQBDisconnectMutation } from "../../hooks/useQuickbooks";
import { usePermission } from "../../hooks/usePermission";
import { useModule } from "../../hooks/useEntitlements";

export default function QBWidget() {
	const navigate = useNavigate();
	const { data: qbStatus, isLoading } = useQBStatusQuery();
	const connectMutation = useQBConnectMutation();
	const disconnectMutation = useQBDisconnectMutation();
	const canManage = usePermission("manage_organization");
	const [disconnectError, setDisconnectError] = useState<string | null>(null);
	const quickbooksOn = useModule("quickbooks") === "on";

	const handleDisconnect = async () => {
		setDisconnectError(null);
		try {
			await disconnectMutation.mutateAsync();
		} catch {
			setDisconnectError("Failed to disconnect. Please try again.");
		}
	};

	if (!quickbooksOn) return null;

	return (
		<div className="bg-base border border-border-subtle rounded-xl h-full flex items-center px-4 gap-3">
			{/* Status dot */}
			<span className={`w-2 h-2 rounded-full shrink-0 ${isLoading ? 'bg-border animate-pulse' : qbStatus?.connected ? 'bg-success' : 'bg-border-strong'}`} />

			{/* Label + status */}
			<div className="flex-1 min-w-0">
				<p className="text-sm font-medium text-text-primary leading-tight">QuickBooks</p>
				<p className="text-xs text-text-muted leading-tight truncate">
					{isLoading ? 'Loading…' : qbStatus?.connected ? 'Connected' : 'Not connected'}
				</p>
			</div>

			{/* Action */}
			{!isLoading && canManage && (
				qbStatus?.connected ? (
					<button
						onClick={handleDisconnect}
						disabled={disconnectMutation.isPending}
						className="shrink-0 flex items-center gap-1 px-2.5 py-1 rounded-md border border-border text-xs font-medium text-error-text hover:border-error/40 hover:bg-error/10 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
					>
						{disconnectMutation.isPending ? <Loader2 size={11} className="animate-spin" /> : <XCircle size={11} />}
						Disconnect
					</button>
				) : (
					<button
						onClick={() => connectMutation.mutate()}
						disabled={connectMutation.isPending}
						className="shrink-0 flex items-center gap-1 px-2.5 py-1 rounded-md bg-primary-hover text-xs font-medium text-on-primary hover:bg-primary transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
					>
						{connectMutation.isPending && <Loader2 size={11} className="animate-spin" />}
						Connect
					</button>
				)
			)}

			{/* Settings link */}
			<button
				onClick={() => navigate("/dispatch/admin?tab=quickbooks")}
				className="shrink-0 text-xs text-text-faint hover:text-text-muted transition-colors"
				title="QB settings"
			>
				⚙
			</button>

			{disconnectError && (
				<p className="absolute bottom-1 left-4 text-[10px] text-error-text">{disconnectError}</p>
			)}
		</div>
	);
}
