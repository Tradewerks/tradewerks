import { useState } from "react";
import { Link } from "react-router-dom";
import { FormErrorBanner } from "../../components/ui/forms/FormErrorBanner";
import { useBusinessTypes } from "../../hooks/useBusinessTypes";
import { inputClass, labelClass } from "./AuthCard";
import CopyLink from "./CopyLink";
import { platformError } from "../api";
import { useCreateOrg, useTiers } from "../hooks";
import { isAssignable } from "./orgDetailUi";
import type { CreateOrgBody } from "../types";

const EMPTY = {
	name: "",
	adminName: "",
	adminEmail: "",
	businessType: "",
	planKey: "",
	trial: false,
	trialKey: "",
	trialDays: "14",
};
type Form = typeof EMPTY;

export default function NewOrgPanel() {
	const types = useBusinessTypes();
	const tiers = useTiers();
	const create = useCreateOrg();
	const [f, setF] = useState<Form>(EMPTY);
	const [done, setDone] = useState<{ id: string; name: string; url: string } | null>(null);
	const set =
		(k: keyof Form) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
			const t = e.target;
			const value = t instanceof HTMLInputElement && t.type === "checkbox" ? t.checked : t.value;
			setF((p) => ({ ...p, [k]: value }));
		};
	const assignable = (tiers.data ?? []).filter(isAssignable);

	const submit = async (e: React.FormEvent) => {
		e.preventDefault();
		const body: CreateOrgBody = {
			name: f.name,
			admin_name: f.adminName,
			admin_email: f.adminEmail,
			business_type: f.businessType,
			plan_key: f.planKey,
			...(f.trial && { trial: { plan_key: f.trialKey, days: Number(f.trialDays) } }),
		};
		try {
			const r = await create.mutateAsync(body);
			setDone({ id: r.id, name: f.name, url: r.inviteUrl });
			setF(EMPTY);
		} catch {
			// shown from create.error
		}
	};

	if (done)
		return (
			<div className="space-y-2 rounded-lg border border-border-subtle p-4">
				<p className="text-sm text-text-secondary">
					Created {done.name}. The admin invite was emailed; the link works once and
					expires in 7 days.
				</p>
				<CopyLink url={done.url} />
				<div className="flex gap-3">
					<Link
						to={`/platform/orgs/${done.id}`}
						className="text-sm font-medium text-primary hover:underline"
					>
						Open {done.name}
					</Link>
					<button
						type="button"
						className="text-sm text-text-secondary hover:underline"
						onClick={() => setDone(null)}
					>
						Create another
					</button>
				</div>
			</div>
		);

	const select = (id: string, label: string, key: keyof Form, options: { key: string; label: string }[]) => (
		<div>
			<label htmlFor={id} className={labelClass}>{label}</label>
			<select id={id} className={inputClass} value={f[key] as string} onChange={set(key)} required>
				<option value="" disabled>Choose one</option>
				{options.map((o) => (
					<option key={o.key} value={o.key}>{o.label}</option>
				))}
			</select>
		</div>
	);
	const input = (id: string, label: string, key: keyof Form, type = "text") => (
		<div>
			<label htmlFor={id} className={labelClass}>{label}</label>
			<input id={id} type={type} className={inputClass} value={f[key] as string} onChange={set(key)} required />
		</div>
	);

	return (
		<form onSubmit={submit} className="space-y-3 rounded-lg border border-border-subtle p-4">
			{create.error && <FormErrorBanner message={platformError(create.error)} />}
			<div className="grid gap-3 sm:grid-cols-2">
				{input("no-name", "Company name", "name")}
				{select("no-type", "Business type", "businessType", types.data ?? [])}
				{input("no-admin", "Admin name", "adminName")}
				{input("no-email", "Admin email", "adminEmail", "email")}
				{select("no-tier", "Tier", "planKey", assignable)}
			</div>
			<label className="flex items-center gap-2 text-sm text-text-secondary">
				<input type="checkbox" checked={f.trial} onChange={set("trial")} /> Start a trial
			</label>
			{f.trial && (
				<div className="grid gap-3 sm:grid-cols-2">
					{select("no-trial-tier", "Trial tier", "trialKey", assignable)}
					<div>
						<label htmlFor="no-trial-days" className={labelClass}>Days</label>
						<input
							id="no-trial-days"
							type="number"
							min={1}
							max={365}
							className={inputClass}
							value={f.trialDays}
							onChange={set("trialDays")}
							required
						/>
					</div>
				</div>
			)}
			<button
				type="submit"
				disabled={create.isPending}
				className="h-8 rounded-md bg-primary px-3 text-sm font-medium text-white disabled:opacity-50"
			>
				Create organization
			</button>
		</form>
	);
}
