import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQuery } from "@tanstack/react-query";
import { isAxiosError } from "axios";
import { AlertTriangle, Loader2 } from "lucide-react";
import FullPopup from "../ui/FullPopup";
import { deleteAccount, getAccountDeletionPreview, type AccountDeletionPreview } from "../../api/account";

// Mirrors the server's comparison: case and runs of spaces don't matter.
const normalize = (s: string) => s.trim().replace(/\s+/g, " ").toLowerCase();

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`;

export interface AccountDeletedState {
	kind: "user" | "organization";
	orgName: string;
}

function Consequences({ preview }: { preview: AccountDeletionPreview }) {
	const org = preview.organization;
	if (preview.kind === "user") {
		return (
			<div className="space-y-3 text-sm text-text-secondary">
				<p>
					This permanently deletes your TradeWerks account. You'll be signed out everywhere and can't sign in
					again.
				</p>
				<ul className="list-disc space-y-1 pl-5">
					<li>
						<span className="font-medium text-text-primary">Removed:</span> your name, email, phone, password,
						two-factor sign-in, notifications, AI assistant chats and personal settings.
					</li>
					<li>
						<span className="font-medium text-text-primary">Kept by {org.name}:</span> the visits, time
						entries, notes and other work you did, shown as "Deleted user". It's their business record.
					</li>
				</ul>
				<p>If you might come back, ask an admin to deactivate your account instead.</p>
			</div>
		);
	}
	const s = preview.organization;
	return (
		<div className="space-y-3 text-sm text-text-secondary">
			<p>
				You're the admin of <span className="font-medium text-text-primary">{s.name}</span>, so deleting your
				account deletes the whole organization.
			</p>
			<ul className="list-disc space-y-1 pl-5">
				<li>
					Everything in {s.name} is permanently deleted: {plural(s.users, "user account")},{" "}
					{plural(s.clients, "client")}, {plural(s.jobs, "job")}, {plural(s.invoices, "invoice")}, and every
					quote, schedule, inventory record, report and uploaded file.
				</li>
				<li>Everyone is signed out right away and gets an email saying the organization was closed.</li>
				{s.quickbooksConnected && <li>QuickBooks is disconnected. Data already synced to QuickBooks stays there.</li>}
			</ul>
			<p>
				Export anything you need to keep first: reports and the inventory list can be downloaded as Excel files.
			</p>
		</div>
	);
}

export default function DeleteAccountCard() {
	const navigate = useNavigate();
	const [open, setOpen] = useState(false);
	const [confirmation, setConfirmation] = useState("");
	const [password, setPassword] = useState("");

	const preview = useQuery({ queryKey: ["account-deletion-preview"], queryFn: getAccountDeletionPreview });

	const mutation = useMutation({
		mutationFn: deleteAccount,
		// The server has already ended the session. Leave the signed-in layout first;
		// AccountDeletedPage then drops the local session. Signing out here would let
		// the layout's auth guard send the person to the login page instead.
		onSuccess: ({ kind }) => {
			const state: AccountDeletedState = { kind, orgName: preview.data?.organization.name ?? "" };
			navigate("/account-deleted", { replace: true, state });
		},
	});

	const close = () => {
		if (mutation.isPending) return;
		setOpen(false);
		setConfirmation("");
		setPassword("");
		mutation.reset();
	};

	if (preview.isLoading) {
		return (
			<div className="rounded-lg border border-border-subtle bg-base px-5 py-5 text-sm text-text-muted">
				Loading…
			</div>
		);
	}
	if (preview.isError || !preview.data) {
		return (
			<div className="rounded-lg border border-border-subtle bg-base px-5 py-5 text-sm text-error-text">
				Couldn't load account deletion. Reload the page to try again.
			</div>
		);
	}

	const p = preview.data;
	const isOrg = p.kind === "organization";
	const title = isOrg ? "Delete organization" : "Delete account";
	const blocked = p.blockers.length > 0;
	const ready = normalize(confirmation) === normalize(p.confirmation) && password.length > 0;
	const serverError = mutation.error
		? (isAxiosError(mutation.error) && mutation.error.response?.data?.error?.message) ||
			"Something went wrong. Nothing was deleted; try again."
		: null;

	const inputClass =
		"w-full rounded-md border border-border bg-base px-3 py-1.5 text-sm text-text-primary placeholder:text-faint outline-none transition-colors focus:border-primary focus:ring-1 focus:ring-primary-border";

	return (
		<section aria-labelledby="delete-account-heading">
			<div className="rounded-lg border border-error-border bg-base px-5 py-5 space-y-4">
				<h2 id="delete-account-heading" className="text-lg font-semibold text-text-primary">
					{title}
				</h2>
				<Consequences preview={p} />
				{blocked && (
					<div role="alert" className="flex gap-2 rounded-md border border-warning-border bg-warning-bg px-3 py-2 text-sm text-warning-text">
						<AlertTriangle size={16} className="mt-0.5 shrink-0" aria-hidden />
						<div className="space-y-1">
							{p.blockers.map((b) => (
								<p key={b}>{b}</p>
							))}
						</div>
					</div>
				)}
				<button
					type="button"
					disabled={blocked}
					onClick={() => setOpen(true)}
					className="rounded-md bg-error px-4 py-1.5 text-xs font-medium text-on-primary transition-colors hover:bg-error-strong disabled:cursor-not-allowed disabled:opacity-50"
				>
					{isOrg ? "Delete organization…" : "Delete my account…"}
				</button>
			</div>

			<FullPopup
				isModalOpen={open}
				onClose={close}
				content={
					<form
						className="space-y-4 p-6"
						onSubmit={(e) => {
							e.preventDefault();
							if (ready && !mutation.isPending) mutation.mutate({ password, confirmation });
						}}
					>
						<h3 className="text-lg font-semibold text-text-primary">
							{isOrg ? `Delete ${p.organization.name}?` : "Delete your account?"}
						</h3>
						<p className="text-sm text-text-secondary">
							{isOrg
								? "This deletes the organization, every account in it and all of its data. It can't be undone."
								: "Your personal information is removed and you're signed out everywhere. It can't be undone."}
						</p>
						<div>
							<label htmlFor="delete-confirmation" className="mb-1 block text-xs font-medium text-text-tertiary">
								Type <span className="font-semibold text-text-primary">{p.confirmation}</span> to confirm
							</label>
							<input
								id="delete-confirmation"
								value={confirmation}
								onChange={(e) => setConfirmation(e.target.value)}
								autoComplete="off"
								spellCheck={false}
								className={inputClass}
							/>
						</div>
						<div>
							<label htmlFor="delete-password" className="mb-1 block text-xs font-medium text-text-tertiary">
								Your password
							</label>
							<input
								id="delete-password"
								type="password"
								value={password}
								onChange={(e) => setPassword(e.target.value)}
								autoComplete="current-password"
								className={inputClass}
							/>
						</div>
						{serverError && (
							<p role="alert" className="text-sm text-error-text">
								{serverError}
							</p>
						)}
						<div className="flex justify-end gap-2 pt-1">
							<button
								type="button"
								onClick={close}
								disabled={mutation.isPending}
								className="rounded-md border border-border px-3 py-1.5 text-sm text-text-tertiary transition-colors hover:bg-surface hover:text-text-primary disabled:opacity-50"
							>
								Cancel
							</button>
							<button
								type="submit"
								disabled={!ready || mutation.isPending}
								className="flex items-center gap-1.5 rounded-md bg-error px-3 py-1.5 text-sm font-medium text-on-primary transition-colors hover:bg-error-strong disabled:cursor-not-allowed disabled:opacity-50"
							>
								{mutation.isPending && <Loader2 size={14} className="animate-spin" aria-hidden />}
								{isOrg ? "Delete organization permanently" : "Delete my account"}
							</button>
						</div>
					</form>
				}
			/>
		</section>
	);
}
