import { APP_BASE } from "../config";
import AiSummaryLinks from "../components/landing/AiSummaryLinks";
import DispatchPreview from "../components/landing/DispatchPreview";
import MapFeed from "../components/landing/MapFeed";
import PhoneDemo from "../components/landing/PhoneDemo";
import { PurchaseControlsSection } from "../components/landing/PurchaseControlsSection";
import { ReportingSection } from "../components/landing/ReportingSection";
import { Eyebrow, Logo, SplitIntro } from "../components/landing/primitives";
import { LEGAL, LEGAL_LINKS } from "../components/landing/legal/legal";
import {
	AssistantRulesSection,
	BackOfficeSection,
	FieldSection,
	FollowupsSection,
} from "../components/landing/sections";
import { useVisitDemo, type StepState } from "../components/landing/visitDemo";
import "../components/landing/landing.css";

// Public marketing page at "/". Rendered outside the app's router (see main.tsx),
// so links into the app are plain anchors that load the app bundle.
const SIGN_IN_HREF = `${APP_BASE}/login`;
const DEMO_HREF = "mailto:sales@tradewerks.io";

const container = "mx-auto max-w-[1200px] px-6";
const primaryButton = "rounded-lg bg-brand font-semibold text-white hover:bg-brand-hover";

const NAV_LINKS = [
	["#field", "Technicians"],
	["#dispatch", "Dispatch"],
	["#assistant", "Assistant"],
	["#purchases", "Purchases"],
	["#followups", "Follow-ups"],
	["#reporting", "Reporting"],
];

const FLOW = [
	[
		"Request",
		"Log the call or email once, with the client and site address attached. Everything after builds on it.",
	],
	[
		"Quote",
		"Line items from your parts catalog, emailed under your name and logo, followed up until the client opens one.",
	],
	[
		"Job",
		"The approved quote carries its scope and pricing into the job. Nothing is retyped.",
	],
	[
		"Visit",
		"Scheduled with an arrival window, assigned to one or more techs, worked from the phone.",
	],
	[
		"Invoice",
		"Clocked labor and parts used are already on the visit. Pull them into the invoice and sync it to QuickBooks.",
	],
];

const STEP_PILL: Record<StepState, string> = {
	current: "bg-ink text-paper",
	done: "bg-brand-tint text-brand-deep",
	upcoming: "bg-paper-2 text-ink-3",
};

export default function LandingPage() {
	const demo = useVisitDemo();

	return (
		<div className="min-h-screen bg-paper font-sans text-ink">
			{/* Description, favicon and social tags live in index.html so crawlers see them without JS. */}
			<title>TradeWerks — Field service software for HVAC and the trades</title>

			{/* Sticky only from md up: on a phone it would hold a fifth of the screen. */}
			<header className="border-b border-line bg-paper/95 backdrop-blur-sm md:sticky md:top-0 md:z-20">
				<div
					className={`${container} flex flex-wrap items-center justify-between gap-x-6 gap-y-2 py-3.5`}
				>
					<a
						href="#top"
						className="flex items-center gap-2.5 text-ink"
					>
						<Logo />
						<div className="text-[19px] font-bold tracking-[-0.02em]">
							TradeWerks
						</div>
					</a>
					<nav className="hidden flex-wrap gap-x-5 text-[15px] font-medium md:flex">
						{NAV_LINKS.map(([href, label]) => (
							<a
								key={href}
								href={href}
								className="px-1 py-2.5 text-ink-2 hover:text-ink"
							>
								{label}
							</a>
						))}
					</nav>
					<div className="flex items-center gap-1.5 text-[15px] font-semibold sm:gap-2.5">
						<a
							href={SIGN_IN_HREF}
							className="px-2.5 py-2.5 text-ink sm:px-3.5"
						>
							Sign in
						</a>
						<a
							href={DEMO_HREF}
							className={`${primaryButton} px-3.5 py-[11px] sm:px-[18px]`}
						>
							Book a demo
						</a>
					</div>
				</div>
			</header>

			<main>
				<section
					id="top"
					className={`${container} flex scroll-mt-16 flex-wrap items-center gap-14 pb-[88px] pt-[72px]`}
				>
					<div className="flex min-w-0 flex-[1_1_440px] flex-col gap-7">
						<Eyebrow>
							Field service software for HVAC and the
							trades
						</Eyebrow>
						<h1 className="m-0 text-balance text-[length:clamp(42px,6vw,72px)] font-semibold leading-none tracking-[-0.035em]">
							One system for every job, every tech, every
							dollar.
						</h1>
						<p className="m-0 max-w-[540px] text-pretty text-[19px] leading-[1.55] text-ink-2">
							TradeWerks runs the office and the truck
							from the same record. Dispatch books the
							visit, the technician works it from their
							phone, and every status change shows up on
							the board as it happens. An assistant
							handles the busywork and stops for a person
							before anything changes.
						</p>
						<div className="flex flex-wrap gap-3 text-[17px] font-semibold">
							<a
								href={DEMO_HREF}
								className={`${primaryButton} px-[26px] py-[17px]`}
							>
								Book a demo
							</a>
							<a
								href="#flow"
								className="rounded-lg border-[1.5px] border-ink bg-white px-[24.5px] py-[15.5px] text-ink hover:bg-paper-2"
							>
								See how a visit runs
							</a>
						</div>
						<div className="flex flex-col gap-2.5 pt-2">
							<div className="text-sm font-medium text-ink-3">
								Try it: tap the green button on the
								phone.
							</div>
							<ol
								className="m-0 flex list-none flex-wrap gap-1.5 p-0"
								aria-label="Visit progress"
							>
								{demo.steps.map((step) => (
									<li
										key={step.label}
										aria-current={
											step.state ===
											"current"
												? "step"
												: undefined
										}
										className={`rounded-full px-[11px] py-1.5 text-[13px] font-semibold ${STEP_PILL[step.state]}`}
									>
										{step.label}
									</li>
								))}
							</ol>
						</div>
					</div>

					<PhoneDemo demo={demo} />
				</section>

				<section
					id="flow"
					className="scroll-mt-16 border-y border-line bg-white"
				>
					<div className={`${container} flex flex-col gap-9 py-16`}>
						<div className="flex max-w-[640px] flex-col gap-3">
							<h2 className="m-0 text-balance text-[length:clamp(30px,3.6vw,42px)] font-semibold leading-[1.08] tracking-[-0.03em]">
								The call becomes the quote becomes
								the job becomes the invoice.
							</h2>
						</div>
						<ol className="m-0 grid list-none grid-cols-[repeat(auto-fit,minmax(190px,1fr))] gap-px overflow-hidden rounded-xl border border-line bg-line p-0">
							{FLOW.map(([title, body], i) => (
								<li
									key={title}
									className="flex flex-col gap-2.5 bg-white p-[22px]"
								>
									<div className="font-mono text-xs text-ink-4">
										{String(
											i + 1
										).padStart(2, "0")}
									</div>
									<div className="text-xl font-bold">
										{title}
									</div>
									<div className="text-[15px] leading-normal text-ink-3">
										{body}
									</div>
								</li>
							))}
						</ol>
					</div>
				</section>

				<FieldSection />

				<section
					id="dispatch"
					className={`${container} flex scroll-mt-16 flex-col gap-10 py-[88px]`}
				>
					<SplitIntro title="Every visit, every tech, live.">
						Status changes from the field land on the board the
						moment they happen. Tap through the visit on the
						phone above and watch the Johnson row move. Ask the
						assistant for a change and it waits for your
						approval.
					</SplitIntro>
					<DispatchPreview visitStatus={demo.status} />
					<div className="flex flex-wrap items-end justify-between gap-x-14 gap-y-4 pt-6">
						<h3 className="m-0 flex-[1_1_460px] text-balance text-[length:clamp(24px,2.6vw,30px)] font-semibold leading-[1.15] tracking-[-0.02em]">
							Every site on one map, every update as it lands.
						</h3>
						<p className="m-0 flex-[1_1_380px] text-pretty text-base leading-[1.55] text-ink-2">
							Arrivals, pauses, completions and shift changes stream
							into the feed beside the map. Techs get their own map of
							today's open stops, and each drive's distance goes on
							their mileage log.
						</p>
					</div>
					<MapFeed visitStatus={demo.status} />
				</section>

				<AssistantRulesSection />
				<PurchaseControlsSection />
				<FollowupsSection />
				<ReportingSection />
				<BackOfficeSection />

				<section id="demo" className="scroll-mt-16 bg-brand text-white">
					<div
						className={`${container} flex flex-wrap items-center justify-between gap-8 py-[88px]`}
					>
						<div className="flex flex-[1_1_480px] flex-col gap-3.5">
							<h2 className="m-0 text-balance text-[length:clamp(34px,4.4vw,54px)] font-semibold leading-[1.02] tracking-[-0.035em]">
								See it on your own jobs.
							</h2>
							<p className="m-0 max-w-[520px] text-lg leading-[1.55] text-brand-soft">
								We'll import your parts list, set up
								your techs and a few of your
								clients, and walk a real visit from
								the first call to the invoice.
							</p>
						</div>
						<div className="flex flex-wrap gap-3 text-[17px]">
							<a
								href={DEMO_HREF}
								className="rounded-lg bg-lime px-7 py-[18px] font-bold text-lime-ink hover:bg-lime-hover"
							>
								Book a demo
							</a>
							<a
								href={SIGN_IN_HREF}
								className="rounded-lg border-[1.5px] border-white px-[26.5px] py-[16.5px] font-semibold text-white hover:bg-brand-hover"
							>
								Sign in
							</a>
						</div>
					</div>
				</section>
			</main>

			<footer
				className={`${container} flex flex-wrap items-center justify-between gap-4 pb-8 pt-5 text-sm text-ink-4`}
			>
				<div className="font-bold text-ink">TradeWerks</div>
				<AiSummaryLinks />
				<nav className="flex flex-wrap gap-x-4">
					<a href="#field" className="py-2.5 hover:text-ink">
						Technicians
					</a>
					<a href="#dispatch" className="py-2.5 hover:text-ink">
						Dispatch
					</a>
					<a href="#assistant" className="py-2.5 hover:text-ink">
						Assistant
					</a>
					<a href="#purchases" className="py-2.5 hover:text-ink">
						Purchases
					</a>
					<a href="#reporting" className="py-2.5 hover:text-ink">
						Reporting
					</a>
					<a href={SIGN_IN_HREF} className="py-2.5 hover:text-ink">
						Sign in
					</a>
				</nav>
				<div className="flex w-full flex-wrap items-center justify-between gap-x-4 border-t border-line pt-3">
					<div>
						© {new Date().getFullYear()} {LEGAL.entity}
					</div>
					<nav aria-label="Legal" className="flex flex-wrap gap-x-4">
						{LEGAL_LINKS.map(([href, label]) => (
							<a key={href} href={href} className="py-2.5 hover:text-ink">
								{label}
							</a>
						))}
					</nav>
				</div>
			</footer>
		</div>
	);
}
