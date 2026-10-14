import { CardLabel, SectionTitle, SplitIntro } from "./primitives";

const container = "mx-auto max-w-[1200px] px-6";

function Feature({ title, children }: { title: string; children: string }) {
	return (
		<div className="flex flex-col gap-1.5">
			<div className="text-[17px] font-semibold">{title}</div>
			<div className="text-[15px] leading-normal text-night-ink-3">
				{children}
			</div>
		</div>
	);
}

const nightCard =
	"flex min-h-[340px] flex-col gap-3 rounded-[20px] border border-night-line bg-night-2 p-5";
const nightTile =
	"rounded-[10px] border border-night-line bg-night px-1.5 py-[18px] text-center text-[15px] font-semibold";

export function FieldSection() {
	return (
		<section id="field" className="scroll-mt-16 bg-night text-night-ink">
			<div className={`${container} flex flex-col gap-12 py-[88px]`}>
				<SplitIntro
					title="Built for gloves, glare and 5am starts."
					bodyClassName="text-night-ink-2"
				>
					Every screen answers one question: what do I do next. The
					button that moves the visit forward is always the brightest
					thing on screen, and it's sized for a gloved thumb. Dark
					mode keeps the same layout for the drive in.
				</SplitIntro>

				<div className="grid grid-cols-[repeat(auto-fit,minmax(280px,1fr))] gap-6">
					<div className="flex flex-col gap-4">
						<div className={nightCard}>
							<div className="text-[17px] font-bold">
								Why are you pausing?
							</div>
							<div className="mt-1 grid grid-cols-2 gap-2">
								<div className={nightTile}>
									Awaiting Materials
								</div>
								<div className={nightTile}>
									Equipment Issue
								</div>
								<div
									className={`${nightTile} col-span-2`}
								>
									Other
								</div>
							</div>
							<div className="py-3.5 text-center text-[15px] font-semibold text-night-ink-4">
								Cancel
							</div>
						</div>
						<Feature title="Pauses with a reason">
							Waiting on a part is one tap, and the reason
							is saved with the tech's time on the visit.
						</Feature>
					</div>

					<div className="flex flex-col gap-4">
						<div className={nightCard}>
							<div className="flex flex-col gap-1">
								<CardLabel className="text-night-ink-3">
									Field purchases
								</CardLabel>
								<div className="text-sm leading-[1.45] text-night-ink-4">
									Parts bought at a store or
									supply house. Parts off your
									truck go in Parts Used.
								</div>
							</div>
							{[
								[
									"Record a field purchase",
									"Already paid at the counter. Photograph the receipt to get reimbursed and put the cost on the job.",
								],
								[
									"Request approval",
									"Ask dispatch before you spend. The request lands in their review queue.",
								],
							].map(([title, body]) => (
								<div
									key={title}
									className="flex flex-col gap-1.5 rounded-xl border border-night-line bg-night p-3.5"
								>
									<div className="text-base font-bold">
										{title}
									</div>
									<div className="text-sm leading-[1.45] text-night-ink-3">
										{body}
									</div>
								</div>
							))}
						</div>
						<Feature title="Supply-house runs, on the job">
							Ask first or photograph the receipt after.
							Either way the cost lands on the right job.
						</Feature>
					</div>

					<div className="flex flex-col gap-4">
						<div className={nightCard}>
							<div className="text-[17px] font-bold">
								AC Repair
							</div>
							<div className="flex flex-col gap-1.5 rounded-xl border border-warn-line bg-warn-tint p-3.5">
								<div className="text-[15px] font-bold text-warn">
									<span aria-hidden="true">
										⚠{" "}
									</span>
									Other techs on site
								</div>
								<div className="text-sm leading-[1.45] text-night-ink-2">
									Pausing clocks out Maria
									Rodriguez. Their time will
									be saved.
								</div>
							</div>
							<div className="flex-1" />
							<div className="flex gap-2 text-center text-base">
								<div className="flex-1 rounded-[10px] border-[1.5px] border-night-ink py-[18px] font-semibold">
									Cancel
								</div>
								<div className="flex-1 rounded-[10px] bg-lime py-[18px] font-bold text-lime-ink">
									Pause Anyway
								</div>
							</div>
						</div>
						<Feature title="Crews clock in together">
							Each tech's time is tracked separately on a
							shared visit, and nobody's hours get lost
							when someone else wraps up.
						</Feature>
					</div>
				</div>
			</div>
		</section>
	);
}

const ASSISTANT_RULES: [string, string][] = [
	[
		"Drafts, not records",
		"Ask for a quote, a request or a new job and it fills in the same draft form you would. None of it exists until a dispatcher opens the draft and submits.",
	],
	[
		"Changes wait for you",
		"Booking or moving a visit, assigning a tech or changing a job's status shows up with Approve and Decline. Move on to another question and the pending change lapses.",
	],
	[
		"A name on every change",
		"Every change lands in job history as Assistant · the person who asked, next to the rest of your team's edits.",
	],
	[
		"Your permissions, never more",
		"It works inside the signed-in user's permissions, with a hard ceiling on top. Deletes, role changes and check-ins are off the table entirely.",
	],
	[
		"Your records stay yours",
		"Conversations are saved in your own workspace. Every lookup is walled off to your company, and notes or client messages are read as data, never as instructions to follow.",
	],
];

const DRAFT_LINES: [string, string][] = [
	["Installation Labor", "labor"],
	["Crane Rental (half day)", "equipment"],
	["Refrigerant R-410A (10 lbs)", "material"],
];

export function AssistantRulesSection() {
	return (
		<section className="border-t border-line bg-white">
			<div className={`${container} flex flex-col gap-11 py-[88px]`}>
				<div className="flex max-w-[720px] flex-col gap-3.5">
					<SectionTitle>An assistant that asks first.</SectionTitle>
					<p className="m-0 text-pretty text-lg leading-[1.55] text-ink-2">
						It looks things up, writes the tedious parts and
						suggests the change. A person decides what actually
						happens.
					</p>
				</div>
				<div className="flex flex-wrap items-start gap-10">
					<div className="grid flex-[1_1_440px] grid-cols-[repeat(auto-fit,minmax(220px,1fr))] gap-x-9 gap-y-8">
						{ASSISTANT_RULES.map(([title, body]) => (
							<div
								key={title}
								className="flex flex-col gap-2 border-t-2 border-ink pt-4"
							>
								<div className="text-lg font-bold">
									{title}
								</div>
								<div className="text-base leading-[1.55] text-ink-3">
									{body}
								</div>
							</div>
						))}
					</div>
					<div className="flex min-w-0 flex-[0_1_380px] flex-col gap-3 rounded-[14px] border border-sky-line bg-sky p-5 text-sky-ink">
						<div className="font-mono text-[11px] uppercase tracking-[0.14em] text-sky-2">
							Draft by assistant · review before
							submitting
						</div>
						<div className="flex flex-col gap-[3px]">
							<div className="text-[13px] text-sky-4">
								Quote
							</div>
							<div className="text-lg font-bold leading-[1.3]">
								Rooftop Unit Replacement — Smith
								Commercial Bldg 2
							</div>
						</div>
						<div className="flex flex-col gap-2 rounded-[10px] border border-sky-line bg-white px-3.5 py-3 text-sm">
							{DRAFT_LINES.map(([name, kind]) => (
								<div
									key={name}
									className="flex justify-between gap-2.5"
								>
									<div>{name}</div>
									<div className="font-mono text-sky-4">
										{kind}
									</div>
								</div>
							))}
						</div>
						<div className="text-sm leading-normal">
							Saved as a draft. Nothing has been created
							yet. A dispatcher must open this draft and
							submit it.
						</div>
						<div className="flex gap-2 text-[15px] font-semibold">
							<div className="rounded-lg bg-sky-btn px-[18px] py-[13px] text-white">
								Open draft
							</div>
							<div className="rounded-lg border border-sky-line bg-white px-[17px] py-3 text-sky-3">
								Discard
							</div>
						</div>
					</div>
				</div>
			</div>
		</section>
	);
}

const TRIGGERS = ["Quote sent", "Invoice sent", "Request created", "Visit reminder"];

const CHASE_STEPS = [
	{ name: "Quote follow-up", rule: "Always send", delay: "+2 days" },
	{ name: "Quote reminder", rule: "Only if the last one wasn't opened", delay: "+5 days" },
	{ name: "Last check-in", rule: "Only if the last one wasn't opened", delay: "+10 days" },
];

export function FollowupsSection() {
	return (
		<section id="followups" className="scroll-mt-16 border-t border-line">
			<div
				className={`${container} flex flex-wrap items-center gap-12 py-[88px]`}
			>
				<div className="flex flex-[1_1_400px] flex-col gap-4">
					<SectionTitle>
						Chasing that stops when the client answers.
					</SectionTitle>
					<p className="m-0 text-pretty text-lg leading-[1.55] text-ink-2">
						A sent quote, a sent invoice, a new request or an
						upcoming visit can each start an email sequence in
						your brand. It ends the moment the client opens it,
						or when the quote is approved or the invoice is
						paid.
					</p>
					<div className="flex flex-wrap gap-2 pt-1">
						{TRIGGERS.map((t) => (
							<div
								key={t}
								className="rounded-full border border-line bg-white px-[13px] py-[7px] text-[13px] font-semibold"
							>
								{t}
							</div>
						))}
					</div>
				</div>
				<div className="min-w-0 flex-[1_1_420px] overflow-hidden rounded-[14px] border border-line bg-white">
					<div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-5 py-[18px]">
						<div className="flex flex-col gap-0.5">
							<div className="text-lg font-bold">
								Quote chase
							</div>
							<div className="text-sm text-ink-4">
								Starts when a quote is emailed
							</div>
						</div>
						<div className="flex items-center gap-2.5 text-sm font-semibold">
							<div>Stop on open</div>
							<div className="flex h-6 w-10 justify-end rounded-full bg-brand p-[3px]">
								<div className="size-[18px] rounded-full bg-white" />
							</div>
						</div>
					</div>
					<ol className="m-0 flex list-none flex-col px-5 pb-3 pt-2">
						{CHASE_STEPS.map((step, i) => (
							<li
								key={step.name}
								className="grid grid-cols-[28px_minmax(0,1fr)_auto] items-center gap-3.5 border-b border-line-soft py-3.5 last:border-b-0"
							>
								<div className="font-mono text-[13px] text-ink-4">
									{i + 1}
								</div>
								<div className="flex flex-col gap-0.5">
									<div className="text-[15px] font-semibold">
										{step.name}
									</div>
									<div className="text-[13px] text-ink-4">
										{step.rule}
									</div>
								</div>
								<div className="font-mono text-[13px] text-ink-3">
									{step.delay}
								</div>
							</li>
						))}
					</ol>
					<div className="flex flex-wrap items-center gap-2.5 border-t border-line bg-paper px-5 py-3.5 text-sm">
						<div className="rounded-full bg-brand-tint px-[9px] py-1 text-xs font-bold text-brand-deep">
							Opened · stopped
						</div>
						<div className="text-ink-2">
							Smith Commercial Properties opened step 1
						</div>
					</div>
				</div>
			</div>
		</section>
	);
}

const BACK_OFFICE: [string, string][] = [
	[
		"Inventory",
		"Warehouse and van stock, serials and batches, supplier records, printable labels, low-stock alerts and a reorder forecast. Import your parts list from a spreadsheet or a supplier invoice.",
	],
	[
		"Recurring plans",
		"Monthly PMs and weekly filter checks laid out on the board months ahead. One click books the visit, with the plan's parts already on it.",
	],
	[
		"Projects",
		"Group multi-phase work, like a rooftop replacement program across buildings, under one project.",
	],
	[
		"Mileage",
		"Each drive's distance is worked out when the tech heads out and lands on their mileage log.",
	],
	["QuickBooks", "Connect your QuickBooks company and run its reports alongside your own."],
];

export function BackOfficeSection() {
	return (
		<section className="border-t border-line bg-white">
			<div className={`${container} flex flex-col gap-9 py-20`}>
				<h2 className="m-0 text-[length:clamp(28px,3.2vw,38px)] font-semibold leading-[1.1] tracking-[-0.03em]">
					And the rest of the shop.
				</h2>
				<div className="grid grid-cols-[repeat(auto-fit,minmax(250px,1fr))] gap-x-9 gap-y-7">
					{BACK_OFFICE.map(([title, body]) => (
						<div key={title} className="flex flex-col gap-2">
							<h3 className="m-0 text-lg font-semibold">
								{title}
							</h3>
							<div className="text-base leading-[1.55] text-ink-2">
								{body}
							</div>
						</div>
					))}
				</div>
			</div>
		</section>
	);
}
