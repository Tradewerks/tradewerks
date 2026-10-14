import type { ReactNode } from "react";
import { ShieldCheck, ShieldOff } from "lucide-react";
import Card from "../../ui/Card";
import AccessCard from "../../roles/AccessCard";
import type { Technician } from "../../../types/technicians";
import { formatAbsolute } from "../technicianFormat";

/**
 * DetailFieldGrid's pair markup, one pair per row. Its fixed two-up layout
 * leaves each value ~70px in a third-width rail, which wraps "Not enabled" and
 * a login timestamp mid-phrase, and the kit takes no column option.
 */
function RailFields({ fields }: { fields: { label: string; value: ReactNode }[] }) {
	return (
		<dl className="grid gap-y-2.5">
			{fields.map((f) => (
				<div key={f.label} className="grid grid-cols-[96px_1fr] gap-3">
					<dt className="text-sm text-text-tertiary">{f.label}</dt>
					<dd className="min-w-0 text-sm tabular-nums text-text-primary">
						{f.value}
					</dd>
				</div>
			))}
		</dl>
	);
}

export default function TechnicianAccessTab({ technician }: { technician: Technician }) {
	return (
		<div
			role="tabpanel"
			id="tabpanel-access"
			aria-labelledby="tab-access"
			className="mt-6"
		>
			<h2 className="sr-only">Access</h2>
			{/* items-start: the security card is short and must not stretch beside the role editor. */}
			<div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-3">
				<div className="lg:col-span-2">
					<AccessCard user={technician} tier="technician" />
				</div>
				<Card title="Account Security">
					<RailFields
						fields={[
							{
								label: "MFA",
								value: technician.mfaEnabled ? (
									<span className="inline-flex items-center gap-1.5 text-success-text">
										<ShieldCheck
											size={14}
											className="shrink-0"
											aria-hidden
										/>
										Enabled
									</span>
								) : (
									<span className="inline-flex items-center gap-1.5 text-text-tertiary">
										<ShieldOff
											size={14}
											className="shrink-0"
											aria-hidden
										/>
										Not enabled
									</span>
								),
							},
							{
								label: "Last Login",
								value: formatAbsolute(
									technician.last_login
								),
							},
						]}
					/>
				</Card>
			</div>
		</div>
	);
}
