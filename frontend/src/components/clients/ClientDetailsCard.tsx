import { useNavigate } from "react-router-dom";
import { User, Mail, Phone } from "lucide-react";
import Card from "../ui/Card";

interface Contact {
	id: string;
	name: string;
	email?: string | null;
	phone?: string | null;
	title?: string | null;
}

interface ClientContact {
	is_primary: boolean;
	contact: Contact;
}

export interface ClientDetailsProps {
	client_id: string;
	client?: {
		name?: string | null;
		address?: string | null;
		phone?: string | null;
		email?: string | null;
		is_active?: boolean;
		contacts?: ClientContact[];
	} | null;
	showDispatchLink?: boolean;
	/**
	 * Fills a stretched grid cell instead of sitting at content height. Only
	 * the immediate grid ITEM stretches; without this the card inside it keeps
	 * its own height, which is why the rail still ended short of the main
	 * column after `self-start` came off. Needs a flex-column parent.
	 */
	fill?: boolean;
}

export default function ClientDetailsCard({
	client_id,
	client,
	showDispatchLink = true,
	fill = false,
}: ClientDetailsProps) {
	const navigate = useNavigate();

	const primaryContact = client?.contacts?.find((cc) => cc.is_primary)?.contact;

	return (
		<Card
			className={fill ? "flex-1" : ""}
			title="Client Details"
			headerAction={
				client?.is_active !== undefined ? (
					/* py-0.5, not the py-1 these pills use in card bodies:
					   a Card header is only as tall as its tallest child, so a
					   26px pill made this header 2px taller than the
					   title-only Information card sitting inline with it. At
					   0.5 the pill is 22px and the h3's 24px line box governs. */
					<span
						className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium border ${
							client.is_active
								? "bg-success/20 text-success-text border-success/30"
								: "bg-error/20 text-error-text border-error/30"
						}`}
					>
						{client.is_active ? "Active" : "Inactive"}
					</span>
				) : undefined
			}
		>
			<div className="flex flex-1 flex-col gap-4">
				<div>
					<h3 className="text-text-tertiary text-sm mb-2 flex items-center gap-2">
						<User size={14} />
						Client Name
					</h3>
					<p className="text-text-primary mb-2">
						{client?.name || "Unknown Client"}
					</p>
					{(client?.phone || client?.email) && (
						<div className="flex flex-wrap items-center gap-x-4 gap-y-1">
							{client.phone && (
								<div className="flex items-center gap-1.5 text-xs text-text-tertiary">
									<Phone
										size={12}
										className="flex-shrink-0"
									/>
									<span>{client.phone}</span>
								</div>
							)}
							{client.email && (
								<div className="flex items-center gap-1.5 text-xs text-text-tertiary min-w-0">
									<Mail
										size={12}
										className="flex-shrink-0"
									/>
									<span className="truncate">
										{client.email}
									</span>
								</div>
							)}
						</div>
					)}
				</div>

				<div>
					<h3 className="text-text-tertiary text-sm mb-1">Address</h3>
					{client?.address ? (
						<p className="text-text-primary text-sm break-words">
							{client.address}
						</p>
					) : (
						<p className="text-text-faint text-sm">No address on file</p>
					)}
				</div>

				<div className="pt-4 border-t border-border">
					<div className="flex items-center justify-between mb-1">
						<h3 className="text-text-tertiary text-sm">Primary Contact</h3>
						{primaryContact?.title && (
							<span className="inline-flex items-center px-2  rounded-full text-xs font-medium bg-surface text-text-secondary border border-border">
								{primaryContact.title}
							</span>
						)}
					</div>
					{primaryContact ? (
						<div className="space-y-1.5">
							<p className="text-text-primary font-medium pb-2">
								{primaryContact.name}
							</p>
							{(primaryContact.phone || primaryContact.email) && (
								<div className="flex flex-wrap items-center gap-x-4 gap-y-1">
									{primaryContact.phone && (
										<div className="flex items-center gap-2 text-sm text-text-primary pr-6">
											<Phone
												size={14}
												className="text-text-tertiary flex-shrink-0"
											/>
											<span>{primaryContact.phone}</span>
										</div>
									)}
									{primaryContact.email && (
										<div className="flex items-center gap-2 text-sm text-text-primary min-w-0">
											<Mail
												size={14}
												className="text-text-tertiary flex-shrink-0"
											/>
											<span className="truncate">
												{primaryContact.email}
											</span>
										</div>
									)}
								</div>
							)}
						</div>
					) : (
						<p className="text-text-faint text-sm">No primary contact</p>
					)}
				</div>

				{showDispatchLink && (
					<button
						onClick={() => navigate(`/dispatch/clients/${client_id}`)}
						className="w-full mt-auto px-4 py-2 border border-border rounded-md text-sm font-medium text-text-secondary hover:border-border-strong hover:text-text-primary hover:bg-surface-raised transition-colors cursor-pointer"
					>
						View Full Client Profile
					</button>
				)}
			</div>
		</Card>
	);
}
