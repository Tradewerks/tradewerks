import { useState } from "react";
import { Eye, Loader2, Mail, Pencil } from "lucide-react";
import { usePermission } from "../../hooks/usePermission";
import {
	useTemplatesQuery,
	useTemplateContextQuery,
	useUpdateTemplateMutation,
	useResetTemplateMutation,
} from "../../hooks/useEmailTemplates";
import {
	EmailTemplateCategoryLabels,
	EmailTemplateCategoryValues,
	type EmailTemplateCategory,
} from "../../types/followups";
import type { EmailTemplate } from "../../types/emailTemplates";
import { useFeedback, FeedbackBanner } from "./shared";
import TemplateEditorModal from "./TemplateEditorModal";

export default function TemplatesSection() {
	const { data: templates, isLoading, error } = useTemplatesQuery();
	const { data: context } = useTemplateContextQuery();
	const updateMutation = useUpdateTemplateMutation();
	const resetMutation = useResetTemplateMutation();

	const [editing, setEditing] = useState<EmailTemplate | null>(null);
	const { feedback, showFeedback } = useFeedback();

	const MANAGE_FOLLOWUPS = usePermission("manage_followups");

	const handleSave = async (data: { name: string; subject: string; html: string; text: string }) => {
		if (!editing) return;
		await updateMutation.mutateAsync({ category: editing.category as EmailTemplateCategory, data });
		setEditing(null);
		showFeedback("success", "Template saved.");
	};

	const handleReset = async () => {
		if (!editing) return;
		await resetMutation.mutateAsync(editing.category as EmailTemplateCategory);
		setEditing(null);
		showFeedback("success", "Template reverted to the built-in default.");
	};

	// Customer-message categories are edited under Admin > Customer messages.
	const items = (templates ?? []).filter((t) =>
		EmailTemplateCategoryValues.includes(t.category as EmailTemplateCategory),
	);

	return (
		<div className="rounded-lg border border-border-subtle bg-base">
			<div className="border-b border-border-subtle px-5 py-4">
				<h2 className="text-sm font-semibold text-text-primary">Email Templates</h2>
				<p className="mt-0.5 text-xs text-text-muted">
					The branded emails sent for each step category. Edit the HTML and preview it live —
					your company logo and colors are filled in automatically.
				</p>
			</div>

			<FeedbackBanner feedback={feedback} />

			{isLoading && (
				<div className="flex items-center justify-center px-5 py-10">
					<Loader2 size={20} className="animate-spin text-text-muted" />
				</div>
			)}

			{error && !isLoading && (
				<div className="px-5 py-6">
					<p className="text-sm text-error-text">{error.message}</p>
				</div>
			)}

			{!isLoading && !error && (
				<div className="grid grid-cols-1 gap-3 p-5 sm:grid-cols-2 xl:grid-cols-3">
					{items.map((tpl) => (
						<div
							key={tpl.category}
							className="flex flex-col rounded-lg border border-border-subtle bg-surface p-4 transition-colors hover:border-border"
						>
							<div className="mb-2 flex items-center justify-between">
								<div className="flex items-center gap-2">
									<span className="flex h-7 w-7 items-center justify-center rounded-md bg-surface-inset text-text-tertiary">
										<Mail size={14} />
									</span>
									<span className="text-xs font-medium uppercase tracking-wider text-text-muted">
										{EmailTemplateCategoryLabels[tpl.category as EmailTemplateCategory]}
									</span>
								</div>
								{tpl.is_customized ? (
									<span className="rounded-full border border-primary-border bg-primary-bg px-2 py-0.5 text-[11px] font-medium text-primary-text">
										Customized
									</span>
								) : (
									<span className="rounded-full border border-border bg-surface px-2 py-0.5 text-[11px] font-medium text-text-muted">
										Default
									</span>
								)}
							</div>

							<p className="text-sm font-semibold text-text-primary">{tpl.name}</p>
							<p className="mt-0.5 line-clamp-2 flex-1 text-xs text-text-muted">{tpl.subject}</p>

							<button
								type="button"
								onClick={() => setEditing(tpl)}
								className="mt-3 inline-flex items-center justify-center gap-1.5 rounded-md border border-border bg-base px-3 py-1.5 text-xs font-medium text-text-primary transition-colors hover:border-border-strong hover:bg-surface-raised"
							>
								{MANAGE_FOLLOWUPS ? (
									<>
										<Pencil size={12} /> Edit &amp; Preview
									</>
								) : (
									<>
										<Eye size={12} /> Preview
									</>
								)}
							</button>
						</div>
					))}
				</div>
			)}

			{editing && (
				<TemplateEditorModal
					template={editing}
					context={context}
					readOnly={!MANAGE_FOLLOWUPS}
					isPending={updateMutation.isPending || resetMutation.isPending}
					onClose={() => setEditing(null)}
					onSave={handleSave}
					onReset={handleReset}
				/>
			)}
		</div>
	);
}
