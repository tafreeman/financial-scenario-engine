import {
  ArrowRight,
  BarChart3,
  Bot,
  Database,
  Github,
  Globe,
  Laptop,
  Lock,
  Rocket,
  Sparkles,
  Workflow,
  Zap,
} from "lucide-react";

const REPOSITORY_URL = "https://github.com/tafreeman/fin-impact-tool";

const featureCards = [
  {
    title: "Scenario analysis that stays grounded in data",
    body: "Model staffing swaps, burn-rate pressure, margin recovery, and extension options using a local SQLite-backed dataset.",
    icon: BarChart3,
  },
  {
    title: "AI guidance without losing operational control",
    body: "Teams keep project data local while using GitHub Models for narrative reasoning and recommendation generation.",
    icon: Bot,
  },
  {
    title: "Portable delivery for real project teams",
    body: "The app runs locally with Express, React, and Vite, while GitHub Pages publishes a polished product and documentation site.",
    icon: Laptop,
  },
];

const workflow = [
  {
    step: "01",
    title: "Load seeded or imported portfolio data",
    body: "Start from the included sample projects or Excel workbook previews to explore realistic financial scenarios.",
  },
  {
    step: "02",
    title: "Ask a finance or staffing question",
    body: "Prompt the analyzer with a natural-language question about budget risk, labor mix, runway, or margin.",
  },
  {
    step: "03",
    title: "Review the quantified tradeoffs",
    body: "Compare burn-rate deltas, months-left impacts, and scenario assumptions before making staffing decisions.",
  },
];

const pillars = [
  {
    title: "Why Vite for publishing",
    text: "The repository already uses React + Vite + Tailwind, so the GitHub Pages experience now uses the same frontend toolchain instead of introducing an unrelated static-site stack.",
    icon: Rocket,
  },
  {
    title: "GitHub Pages-ready",
    text: "A dedicated static build outputs a deployable artifact for GitHub Pages while leaving the local Express-backed application untouched.",
    icon: Globe,
  },
  {
    title: "Privacy-aware by design",
    text: "The live app keeps the database local and limits outbound AI traffic to the configured model endpoint, aligning the public site messaging with the product architecture.",
    icon: Lock,
  },
];

const metrics = [
  { label: "Core stack", value: "React 19 · Vite · Tailwind" },
  { label: "Backend runtime", value: "Express + TypeScript" },
  { label: "Local data layer", value: "SQLite" },
  { label: "Delivery model", value: "Local app + GitHub Pages site" },
];

export default function SiteApp() {
  return (
    <div className="min-h-screen bg-[radial-gradient(circle_at_top,rgba(30,64,175,0.28),transparent_32%),linear-gradient(180deg,#020617_0%,#0f172a_45%,#e2e8f0_45%,#f8fafc_100%)] text-slate-900">
      <div className="mx-auto max-w-7xl px-6 pb-16 pt-6 sm:px-8 lg:px-10">
        <header className="rounded-full border border-white/10 bg-slate-950/80 px-5 py-3 text-white shadow-2xl shadow-slate-950/30 backdrop-blur">
          <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
            <div className="flex items-center gap-3">
              <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-emerald-400 text-slate-950 shadow-lg shadow-emerald-400/30">
                <Zap size={22} strokeWidth={2.25} />
              </div>
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.28em] text-sky-200">
                  Financial Impact Analyzer
                </p>
                <h1 className="text-lg font-bold tracking-tight">GitHub Pages product site</h1>
              </div>
            </div>

            <nav className="flex flex-wrap items-center gap-3 text-sm text-slate-300">
              <a href="#features" className="transition hover:text-white">Features</a>
              <a href="#workflow" className="transition hover:text-white">Workflow</a>
              <a href="#architecture" className="transition hover:text-white">Architecture</a>
              <a
                href={REPOSITORY_URL}
                className="inline-flex items-center gap-2 rounded-full border border-white/15 px-4 py-2 font-medium text-white transition hover:border-sky-300 hover:bg-white/5"
              >
                <Github size={16} />
                Repository
              </a>
            </nav>
          </div>
        </header>

        <section className="grid gap-10 pb-20 pt-14 lg:grid-cols-[1.2fr_0.8fr] lg:items-center">
          <div className="text-white">
            <div className="mb-6 inline-flex items-center gap-2 rounded-full border border-sky-300/20 bg-sky-400/10 px-4 py-2 text-sm font-medium text-sky-100">
              <Sparkles size={16} />
              Published with the existing Vite stack for GitHub Pages
            </div>
            <h2 className="max-w-3xl text-4xl font-black tracking-tight sm:text-5xl lg:text-6xl">
              Modern project-finance storytelling for a local-first analyzer.
            </h2>
            <p className="mt-6 max-w-2xl text-lg leading-8 text-slate-300">
              This site gives the repository a polished public surface while the actual analyzer
              continues to run locally with Express, SQLite, and GitHub Models-backed reasoning.
            </p>

            <div className="mt-8 flex flex-wrap gap-4">
              <a
                href="#architecture"
                className="inline-flex items-center gap-2 rounded-full bg-white px-5 py-3 text-sm font-semibold text-slate-950 shadow-xl shadow-slate-900/20 transition hover:-translate-y-0.5"
              >
                Explore the architecture
                <ArrowRight size={16} />
              </a>
              <a
                href={`${REPOSITORY_URL}#readme`}
                className="inline-flex items-center gap-2 rounded-full border border-white/15 px-5 py-3 text-sm font-semibold text-white transition hover:border-white/40 hover:bg-white/5"
              >
                Read the README
              </a>
            </div>

            <dl className="mt-10 grid gap-4 sm:grid-cols-2">
              {metrics.map((metric) => (
                <div key={metric.label} className="rounded-3xl border border-white/10 bg-white/5 p-5 backdrop-blur">
                  <dt className="text-xs font-semibold uppercase tracking-[0.24em] text-slate-400">
                    {metric.label}
                  </dt>
                  <dd className="mt-2 text-lg font-semibold text-white">{metric.value}</dd>
                </div>
              ))}
            </dl>
          </div>

          <div className="relative">
            <div className="absolute inset-0 -z-10 rounded-[2rem] bg-emerald-400/15 blur-3xl" />
            <div className="overflow-hidden rounded-[2rem] border border-slate-200/60 bg-white shadow-2xl shadow-slate-950/20">
              <div className="border-b border-slate-200 bg-slate-950 px-6 py-4 text-white">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <p className="text-xs uppercase tracking-[0.24em] text-slate-400">Preview</p>
                    <h3 className="mt-1 text-xl font-semibold">Financial operating picture</h3>
                  </div>
                  <div className="rounded-full bg-emerald-400/15 px-3 py-1 text-xs font-semibold text-emerald-300">
                    Live-style snapshot
                  </div>
                </div>
              </div>

              <div className="space-y-6 p-6">
                <div className="grid gap-4 sm:grid-cols-2">
                  <PreviewMetric title="Total budget" value="$4.03M" delta="+3 seeded programs" />
                  <PreviewMetric title="Monthly burn" value="$199.8K" delta="Across active staffing" />
                  <PreviewMetric title="Blended margin" value="26.6%" delta="Tracked by labor mix" />
                  <PreviewMetric title="Scenarios" value="Multi-path" delta="Prompt-driven analysis" />
                </div>

                <div className="rounded-3xl border border-slate-200 bg-slate-50 p-5">
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="text-xs font-semibold uppercase tracking-[0.24em] text-slate-500">
                        Example question
                      </p>
                      <p className="mt-2 text-base font-semibold text-slate-900">
                        What staffing changes extend Project Alpha by 3 months while protecting margin?
                      </p>
                    </div>
                    <Workflow size={28} className="text-sky-600" />
                  </div>
                  <div className="mt-4 rounded-2xl bg-white p-4 shadow-sm">
                    <p className="text-sm leading-7 text-slate-600">
                      The analyzer compares staffing swaps, recalculates burn, and returns scenario
                      narratives with assumptions, risks, and recommended actions.
                    </p>
                  </div>
                </div>

                <div className="grid gap-3 sm:grid-cols-3">
                  <Pill badge="Local first" text="SQLite-backed data" />
                  <Pill badge="AI-assisted" text="GitHub Models-ready" />
                  <Pill badge="Publishable" text="GitHub Pages workflow" />
                </div>
              </div>
            </div>
          </div>
        </section>

        <section id="features" className="grid gap-6 pb-20 md:grid-cols-3">
          {featureCards.map((card) => {
            const Icon = card.icon;
            return (
              <article
                key={card.title}
                className="rounded-[2rem] border border-slate-200 bg-white p-8 shadow-lg shadow-slate-200/60"
              >
                <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-sky-100 text-sky-700">
                  <Icon size={24} />
                </div>
                <h3 className="mt-6 text-xl font-bold tracking-tight text-slate-950">{card.title}</h3>
                <p className="mt-3 text-base leading-7 text-slate-600">{card.body}</p>
              </article>
            );
          })}
        </section>

        <section
          id="workflow"
          className="rounded-[2rem] bg-slate-950 px-8 py-10 text-white shadow-2xl shadow-slate-950/20"
        >
          <div className="max-w-2xl">
            <p className="text-xs font-semibold uppercase tracking-[0.28em] text-sky-200">Workflow</p>
            <h3 className="mt-3 text-3xl font-bold tracking-tight">
              Move from raw staffing data to decision-ready financial guidance.
            </h3>
            <p className="mt-4 text-base leading-7 text-slate-300">
              The live product flow stays operationally focused, while the public site translates the
              same story into a cleaner, review-friendly experience for GitHub visitors.
            </p>
          </div>

          <div className="mt-10 grid gap-5 lg:grid-cols-3">
            {workflow.map((item) => (
              <div key={item.step} className="rounded-[1.75rem] border border-white/10 bg-white/5 p-6">
                <p className="text-sm font-semibold text-emerald-300">{item.step}</p>
                <h4 className="mt-3 text-xl font-semibold">{item.title}</h4>
                <p className="mt-3 text-sm leading-7 text-slate-300">{item.body}</p>
              </div>
            ))}
          </div>
        </section>

        <section id="architecture" className="grid gap-6 pb-20 pt-20 lg:grid-cols-[0.95fr_1.05fr]">
          <div className="rounded-[2rem] border border-slate-200 bg-white p-8 shadow-lg shadow-slate-200/60">
            <p className="text-xs font-semibold uppercase tracking-[0.28em] text-sky-700">Architecture</p>
            <h3 className="mt-3 text-3xl font-bold tracking-tight text-slate-950">
              One repository, two delivery surfaces.
            </h3>
            <p className="mt-4 text-base leading-7 text-slate-600">
              The application still ships as a local-first operational tool. GitHub Pages now handles
              the outward-facing product story, release-ready overview, and contributor-friendly
              navigation.
            </p>

            <div className="mt-8 space-y-4">
              <ArchitectureRow icon={Globe} title="GitHub Pages site" body="Static Vite build for overview, architecture, onboarding, and repository presentation." />
              <ArchitectureRow icon={Laptop} title="Local web app" body="React + Vite UI served by the Express runtime when the analyzer is launched locally." />
              <ArchitectureRow icon={Database} title="SQLite data layer" body="Project, staffing, rates, and config remain in the portable local database." />
              <ArchitectureRow icon={Bot} title="AI narrative engine" body="Scenario prompts use live financial context to generate structured recommendations." />
            </div>
          </div>

          <div className="rounded-[2rem] border border-slate-200 bg-slate-50 p-8 shadow-lg shadow-slate-200/60">
            <p className="text-xs font-semibold uppercase tracking-[0.28em] text-slate-500">Publishing notes</p>
            <div className="mt-6 grid gap-4">
              {pillars.map((pillar) => {
                const Icon = pillar.icon;
                return (
                  <div key={pillar.title} className="rounded-[1.5rem] bg-white p-6 shadow-sm">
                    <div className="flex items-start gap-4">
                      <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-emerald-100 text-emerald-700">
                        <Icon size={22} />
                      </div>
                      <div>
                        <h4 className="text-lg font-semibold text-slate-950">{pillar.title}</h4>
                        <p className="mt-2 text-sm leading-7 text-slate-600">{pillar.text}</p>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}

function PreviewMetric({
  title,
  value,
  delta,
}: {
  title: string;
  value: string;
  delta: string;
}) {
  return (
    <div className="rounded-3xl border border-slate-200 bg-white p-4 shadow-sm">
      <p className="text-xs font-semibold uppercase tracking-[0.24em] text-slate-500">{title}</p>
      <p className="mt-3 text-3xl font-bold tracking-tight text-slate-950">{value}</p>
      <p className="mt-2 text-sm text-slate-500">{delta}</p>
    </div>
  );
}

function Pill({ badge, text }: { badge: string; text: string }) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-white px-4 py-3">
      <p className="text-xs font-semibold uppercase tracking-[0.24em] text-sky-700">{badge}</p>
      <p className="mt-1 text-sm font-medium text-slate-700">{text}</p>
    </div>
  );
}

function ArchitectureRow({
  icon: Icon,
  title,
  body,
}: {
  icon: typeof Globe;
  title: string;
  body: string;
}) {
  return (
    <div className="flex gap-4 rounded-[1.5rem] border border-slate-200 bg-slate-50 p-5">
      <div className="flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-2xl bg-slate-950 text-white">
        <Icon size={20} />
      </div>
      <div>
        <h4 className="text-base font-semibold text-slate-950">{title}</h4>
        <p className="mt-2 text-sm leading-7 text-slate-600">{body}</p>
      </div>
    </div>
  );
}
