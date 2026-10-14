import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import {
	Briefcase, FolderKanban, Users, ReceiptText, FileText, Inbox,
	RefreshCcw, Wrench, ShieldUser, X,
} from "lucide-react";
import { usePermission } from "../../hooks/usePermission";
import { useCreateJobMutation } from "../../hooks/useJobs";
import { useCreateClientMutation } from "../../hooks/useClients";
import { useCreateQuoteMutation } from "../../hooks/useQuotes";
import { useCreateRequestMutation } from "../../hooks/useRequests";
import { useCreateTechnicianMutation } from "../../hooks/useTechnicians";
import { useCreateDispatcherMutation } from "../../hooks/useDispatchers";
import { useCreateProjectMutation } from "../../hooks/useProjects";
import CreateJob from "../jobs/CreateJob";
import CreateProjectModal from "../projects/CreateProjectModal";
import CreateClient from "../clients/CreateClient";
import CreateInvoice from "../invoices/CreateInvoice";
import CreateQuote from "../quotes/CreateQuote";
import CreateRequest from "../requests/CreateRequest";
import CreateRecurringPlan from "../recurringPlans/CreateRecurringPlan";
import CreateTechnician from "../technicians/CreateTechnician";
import CreateDispatcher from "../dispatchers/CreateDispatcher";

type ActiveModal =
	| "job" | "project" | "client" | "invoice" | "quote" | "request"
	| "recurringPlan" | "technician" | "dispatcher" | null;

function modalProps(
	key: NonNullable<ActiveModal>,
	activeModal: ActiveModal,
	setActiveModal: (v: ActiveModal) => void,
) {
	return {
		isModalOpen: activeModal === key,
		setIsModalOpen: (v: boolean | ((prev: boolean) => boolean)) => {
			const next = typeof v === "function" ? v(activeModal === key) : v;
			if (!next) setActiveModal(null);
		},
	};
}

export default function CreatePanel({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) {
	const navigate = useNavigate();
	const [activeModal, setActiveModal] = useState<ActiveModal>(null);

	const canJob = usePermission("create_jobs");
	const canProject = usePermission("create_projects");
	const canClient = usePermission("create_clients");
	const canInvoice = usePermission("create_invoices");
	const canQuote = usePermission("create_quotes");
	const canRequest = usePermission("create_requests");
	const canRecurring = usePermission("manage_recurring_plans");
	const canTech = usePermission("manage_technicians");
	const canDispatch = usePermission("manage_dispatchers");

	const { mutateAsync: createJob } = useCreateJobMutation();
	const { mutateAsync: createProject } = useCreateProjectMutation();
	const { mutateAsync: createClient } = useCreateClientMutation();
	const { mutateAsync: createQuote } = useCreateQuoteMutation();
	const { mutateAsync: createRequest } = useCreateRequestMutation();
	const { mutateAsync: createTechnician } = useCreateTechnicianMutation();
	const { mutateAsync: createDispatcher } = useCreateDispatcherMutation();

	useEffect(() => {
		if (!isOpen) return;
		const handler = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
		document.addEventListener("keydown", handler);
		return () => document.removeEventListener("keydown", handler);
	}, [isOpen, onClose]);

	useEffect(() => {
		const prev = document.body.style.overflow;
		document.body.style.overflow = "hidden";
		return () => { document.body.style.overflow = prev; };
	}, [isOpen]);

	const openModal = (key: ActiveModal) => {
		onClose();
		setActiveModal(key);
	};

	const MAIN_ITEMS = [
		{ key: "job" as const,           label: "Job",            desc: "Schedule a new service job",      icon: Briefcase,   visible: canJob },
		{ key: "project" as const,       label: "Project",        desc: "Group jobs under a project",      icon: FolderKanban, visible: canProject },
		{ key: "client" as const,        label: "Client",         desc: "Add a new client",                icon: Users,       visible: canClient },
		{ key: "invoice" as const,       label: "Invoice",        desc: "Create an invoice",               icon: ReceiptText, visible: canInvoice },
		{ key: "quote" as const,         label: "Quote",          desc: "Send a quote to a client",        icon: FileText,    visible: canQuote },
		{ key: "request" as const,       label: "Request",        desc: "Log an incoming service request", icon: Inbox,       visible: canRequest },
		{ key: "recurringPlan" as const, label: "Recurring Plan", desc: "Set up a recurring service",      icon: RefreshCcw,  visible: canRecurring },
	];

	const TEAM_ITEMS = [
		{ key: "technician" as const, label: "Technician", desc: "Add a field technician", icon: Wrench,     visible: canTech },
		{ key: "dispatcher" as const, label: "Dispatcher", desc: "Add a dispatcher",       icon: ShieldUser, visible: canDispatch },
	];

	const mainVisible = MAIN_ITEMS.filter((i) => i.visible);
	const teamVisible = TEAM_ITEMS.filter((i) => i.visible);

	const renderRow = ({ key, label, desc, icon: Icon }: typeof MAIN_ITEMS[number] | typeof TEAM_ITEMS[number]) => (
		<button
			key={key}
			onClick={() => openModal(key)}
			className="w-full flex items-center gap-4 px-4 py-3 hover:bg-surface-overlay transition-colors text-left group"
		>
			<div className="w-9 h-9 rounded-lg bg-primary-bg flex items-center justify-center shrink-0 group-hover:bg-primary transition-colors">
				<Icon size={18} className="text-primary group-hover:text-on-primary transition-colors" />
			</div>
			<div className="min-w-0">
				<p className="text-sm font-semibold text-text-primary">{label}</p>
				<p className="text-xs text-text-muted leading-snug">{desc}</p>
			</div>
		</button>
	);

	return (
		<>
			{/* Backdrop — closes panel on click-outside */}
			{isOpen && (
				<div className="fixed inset-0 z-[29]" onClick={onClose} />
			)}

			{/* Panel — fixed overlay at left-16, GPU transform animation (no layout reflow) */}
			<div
				inert={!isOpen}
				style={{ transform: isOpen ? "translateX(0)" : "translateX(-100%)", transition: "transform 200ms ease-in-out" }}
				className="fixed left-16 top-0 h-full w-64 z-[30] bg-base border-r border-border flex flex-col shadow-lg"
			>
				<div className="flex items-center justify-between px-4 h-14 border-b border-border shrink-0">
					<span className="text-sm font-semibold text-text-primary">Create</span>
					<button
						onClick={onClose}
						aria-label="Close create panel"
						className="text-text-muted hover:text-text-primary transition-colors rounded-md p-1 hover:bg-surface-raised"
					>
						<X size={15} />
					</button>
				</div>
				<div className="flex-1 overflow-y-auto py-2">
					{mainVisible.length > 0 && (
						<>
							<p className="px-4 pb-1 pt-2 text-xs font-medium text-text-muted uppercase tracking-wider">
								Service
							</p>
							{mainVisible.map(renderRow)}
						</>
					)}
					{mainVisible.length > 0 && teamVisible.length > 0 && (
						<div className="my-2 border-t border-border-subtle" />
					)}
					{teamVisible.length > 0 && (
						<>
							<p className="px-4 pb-1 pt-2 text-xs font-medium text-text-muted uppercase tracking-wider">
								Team
							</p>
							{teamVisible.map(renderRow)}
						</>
					)}
				</div>
			</div>

			{/* Modals — always mounted so state survives panel close */}
			<CreateJob
				{...modalProps("job", activeModal, setActiveModal)}
				createJob={async (input) => {
					const job = await createJob(input);
					navigate(`/dispatch/jobs/${job.id}`);
					return job.id;
				}}
			/>
			<CreateProjectModal
				{...modalProps("project", activeModal, setActiveModal)}
				createProject={async (input) => {
					const project = await createProject(input);
					navigate(`/dispatch/projects/${project.id}`);
					return project.id;
				}}
			/>
			<CreateClient
				{...modalProps("client", activeModal, setActiveModal)}
				createClient={async (input) => {
					const client = await createClient(input);
					navigate(`/dispatch/clients/${client.id}`);
					return client.id;
				}}
			/>
			<CreateInvoice {...modalProps("invoice", activeModal, setActiveModal)} />
			<CreateQuote
				{...modalProps("quote", activeModal, setActiveModal)}
				createQuote={async (input) => {
					const quote = await createQuote(input);
					navigate(`/dispatch/quotes/${quote.id}`);
					return quote.id;
				}}
			/>
			<CreateRequest
				{...modalProps("request", activeModal, setActiveModal)}
				createRequest={async (input) => {
					const req = await createRequest(input);
					navigate(`/dispatch/requests/${req.id}`);
					return req.id;
				}}
			/>
			<CreateRecurringPlan {...modalProps("recurringPlan", activeModal, setActiveModal)} />
			<CreateTechnician
				{...modalProps("technician", activeModal, setActiveModal)}
				createTechnician={async (input) => {
					const tech = await createTechnician(input);
					return tech.id;
				}}
			/>
			<CreateDispatcher
				{...modalProps("dispatcher", activeModal, setActiveModal)}
				createDispatcher={async (input) => {
					const dispatcher = await createDispatcher(input);
					return dispatcher.id;
				}}
			/>
		</>
	);
}
