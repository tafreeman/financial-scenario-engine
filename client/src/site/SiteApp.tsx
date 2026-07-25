/**
 * SiteApp.tsx — GitHub Pages product site for Financial Scenario Engine
 * Visual system: ember/console design tokens (see brand/tokens.css)
 * Restyled to match the tafreeman portfolio design system.
 * All content is real; no invented metrics or fabricated features.
 */

import "./brand/ember-site.css";
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
  Workflow,
  Zap,
} from "lucide-react";

const REPOSITORY_URL = "https://github.com/tafreeman/financial-scenario-engine";
const PROFILE_URL = "https://github.com/tafreeman";
// Relative on purpose: this site is published under /overview/ of the composed
// Pages artifact and the VitePress docs own the root one level up, so this
// resolves without hard-coding the Pages domain.
const DOCS_URL = "../";

const featureCards = [
  {
    title: "Deterministic engine — no LLM in the math",
    body: "All financial numbers (labor cost, burn, margin, EVM CPI/SPI/EAC, portfolio aggregation) come from the TypeScript engine. The LLM only parses natural-language intent and optionally narrates.",
    icon: BarChart3,
  },
  {
    title: "Dual AI provider — cloud or fully local",
    body: "Choose GitHub Models (PAT-authenticated) or a local Ollama instance in Settings. PAT stored only in local SQLite, localhost-bound, no telemetry.",
    icon: Bot,
  },
  {
    title: "Local-first by design",
    body: "Project data lives in a portable local SQLite database. The Express + React + Vite app runs on 127.0.0.1:3000 by default. No data leaves the machine unless you configure a provider.",
    icon: Lock,
  },
];

const workflow = [
  {
    step: "01",
    title: "Install and start",
    body: "npm run setup && npm run install:all && npm run build && npm start — then open http://127.0.0.1:3000.",
  },
  {
    step: "02",
    title: "Choose a provider in Settings",
    body: "Select GitHub Models (requires a PAT) or Ollama for fully-local inference. The engine works without a provider — AI narration is optional.",
  },
  {
    step: "03",
    title: "Ask a staffing or finance question",
    body: "Try: \"What if we replace the Senior Dev with two Mid-level Devs?\" — the engine recalculates burn, margin, and runway; the LLM narrates the tradeoffs.",
  },
];

const pillars = [
  {
    title: "Vite for the Pages site",
    text: "The repository already uses React + Vite + Tailwind, so the GitHub Pages experience uses the same frontend toolchain instead of introducing an unrelated static-site stack.",
    icon: Rocket,
  },
  {
    title: "GitHub Pages-ready artifact",
    text: "A dedicated Vite config (vite.pages.config.ts) outputs a deployable artifact to client/dist-pages while leaving the local Express-backed application untouched.",
    icon: Globe,
  },
  {
    title: "98 Vitest unit tests + Playwright E2E",
    text: "The deterministic engine is covered by 98 Vitest unit tests. Critical user flows are validated by Playwright E2E tests on every push to main.",
    icon: Workflow,
  },
];

const metrics = [
  { label: "Primary language", value: "TypeScript 97.7%" },
  { label: "Test suite", value: "98 Vitest unit + Playwright E2E" },
  { label: "Data layer", value: "Local SQLite" },
  { label: "Status", value: "BETA" },
];

export default function SiteApp() {
  return (
    <div className="site-shell">
      {/* ── HEADER ────────────────────────────────────────────────────── */}
      <header className="site-header">
        <div className="site-header-inner">
          <div className="site-brand">
            <div className="brand-icon" aria-hidden="true">
              <Zap size={20} strokeWidth={2.5} />
            </div>
            <div>
              <p className="brand-eyebrow">tafreeman</p>
              <span className="brand-name">financial-scenario-engine</span>
            </div>
          </div>

          <nav className="site-nav" aria-label="Site navigation">
            <a href="#features" className="nav-link">Features</a>
            <a href="#workflow" className="nav-link">Workflow</a>
            <a href="#architecture" className="nav-link">Architecture</a>
            {/* This site is deployed under /overview/ of the Pages artifact; the
                VitePress docs sit one level up at the site root. */}
            <a href={DOCS_URL} className="nav-link">Docs</a>
            <a href={PROFILE_URL} className="nav-link" aria-label="tafreeman profile" target="_blank" rel="noopener noreferrer">
              <Github size={15} />
              Profile
            </a>
            <a href={REPOSITORY_URL} className="nav-btn" target="_blank" rel="noopener noreferrer">
              View Repository
              <ArrowRight size={14} />
            </a>
          </nav>
        </div>
      </header>

      {/* ── HERO ──────────────────────────────────────────────────────── */}
      <section className="hero-section">
        <div className="hero-grid-bg" aria-hidden="true" />
        <div className="hero-inner">
          <div className="hero-content">
            <p className="hero-eyebrow">
              <span className="eyebrow-dot" aria-hidden="true" />
              BETA &nbsp;·&nbsp; Local-first &nbsp;·&nbsp; TypeScript
            </p>

            <h1 className="hero-title">
              Project finance,{" "}
              <span className="hero-accent">deterministically</span>{" "}
              modelled.
            </h1>

            <p className="hero-body">
              A local-first simulator where a deterministic TypeScript engine produces all
              financial numbers — labor cost, burn rate, margin, EVM CPI/SPI/EAC, and portfolio
              aggregation. The LLM only parses intent and narrates. Your project data stays in
              a local SQLite database.
            </p>

            <div className="hero-ctas">
              <a href="#architecture" className="cta-primary">
                Explore the architecture
                <ArrowRight size={16} />
              </a>
              <a href={`${REPOSITORY_URL}#readme`} className="cta-secondary">
                Read the README
              </a>
            </div>

            <dl className="hero-metrics">
              {metrics.map((m) => (
                <div key={m.label} className="hero-metric">
                  <dt className="metric-label">{m.label}</dt>
                  <dd className="metric-value">{m.value}</dd>
                </div>
              ))}
            </dl>
          </div>

          {/* Social preview card */}
          <div className="hero-preview" aria-hidden="true">
            <div className="preview-signal-stripe" />
            <div className="preview-header">
              <span className="preview-eyebrow">financial-scenario-engine</span>
              <span className="preview-badge">BETA</span>
            </div>
            <img
              src={`${import.meta.env.BASE_URL}social-preview.png`}
              alt="Financial Scenario Engine — social preview"
              className="preview-image"
              loading="eager"
            />
            <div className="preview-footer">
              <span className="preview-lang">
                <span className="lang-dot ts" />
                TypeScript 97.7%
              </span>
              <span className="preview-status">
                <span className="status-dot" />
                127.0.0.1:3000
              </span>
            </div>
          </div>
        </div>
      </section>

      {/* ── FEATURE CARDS ─────────────────────────────────────────────── */}
      <section id="features" className="section-features">
        <div className="section-inner">
          <p className="section-eyebrow">Core capabilities</p>
          <h2 className="section-title">Engine-first architecture</h2>
          <div className="feature-grid">
            {featureCards.map((card) => {
              const Icon = card.icon;
              return (
                <article key={card.title} className="feature-card">
                  <div className="feature-icon">
                    <Icon size={22} strokeWidth={1.75} />
                  </div>
                  <h3 className="feature-title">{card.title}</h3>
                  <p className="feature-body">{card.body}</p>
                </article>
              );
            })}
          </div>
        </div>
      </section>

      {/* ── WORKFLOW ──────────────────────────────────────────────────── */}
      <section id="workflow" className="section-workflow">
        <div className="section-inner">
          <p className="section-eyebrow">Quick start</p>
          <h2 className="section-title">From install to first scenario</h2>
          <p className="section-subtitle">
            Three steps from a fresh clone to quantified staffing tradeoffs.
          </p>

          <div className="workflow-grid">
            {workflow.map((item) => (
              <div key={item.step} className="workflow-card">
                <span className="workflow-step">{item.step}</span>
                <h3 className="workflow-title">{item.title}</h3>
                <p className="workflow-body">{item.body}</p>
              </div>
            ))}
          </div>

          <div className="install-block">
            <p className="install-label">Install &amp; run</p>
            <div className="terminal-lines">
              <p className="term"><span className="term-prompt">$</span> npm run setup &amp;&amp; npm run install:all &amp;&amp; npm run build &amp;&amp; npm start</p>
              <p className="term dim"><span className="term-prompt">#</span> dev: npm run install:all &amp;&amp; npm run dev</p>
              <p className="term"><span className="term-prompt">$</span> open http://127.0.0.1:3000</p>
            </div>
          </div>
        </div>
      </section>

      {/* ── ARCHITECTURE ──────────────────────────────────────────────── */}
      <section id="architecture" className="section-architecture">
        <div className="section-inner">
          <p className="section-eyebrow">Architecture</p>
          <h2 className="section-title">One repository, two delivery surfaces.</h2>
          <p className="section-subtitle">
            The local Express app is the operational tool. GitHub Pages publishes the product story.
          </p>

          <div className="arch-grid">
            <div className="arch-rows">
              <ArchRow icon={Laptop} title="Local web app" body="React + Vite UI served by the Express runtime on 127.0.0.1:3000 by default. Start with npm start." />
              <ArchRow icon={Database} title="SQLite data layer" body="Projects, staffing, rates, and config stay in a portable local database. No remote storage." />
              <ArchRow icon={Bot} title="AI narrative layer" body="GitHub Models (PAT) or local Ollama. The engine runs identically without any provider configured." />
              <ArchRow icon={Globe} title="GitHub Pages site" body="Static Vite build (vite.pages.config.ts) → client/dist-pages. Deployed by CI on push to main." />
            </div>

            <div className="pillars-panel">
              <p className="pillars-label">Publishing notes</p>
              {pillars.map((pillar) => {
                const Icon = pillar.icon;
                return (
                  <div key={pillar.title} className="pillar-card">
                    <div className="pillar-icon">
                      <Icon size={18} strokeWidth={1.75} />
                    </div>
                    <div>
                      <h4 className="pillar-title">{pillar.title}</h4>
                      <p className="pillar-body">{pillar.text}</p>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </section>

      {/* ── FOOTER ────────────────────────────────────────────────────── */}
      <footer className="site-footer">
        <div className="footer-inner">
          <div className="footer-left">
            <span className="footer-brand">financial-scenario-engine</span>
            <span className="footer-sep">·</span>
            <a href={PROFILE_URL} className="footer-link">tafreeman</a>
            <span className="footer-sep">·</span>
            <a href={REPOSITORY_URL} className="footer-link">GitHub</a>
          </div>
          <div className="footer-right">
            <a href={PROFILE_URL} className="footer-link">← Back to profile</a>
          </div>
        </div>
      </footer>
    </div>
  );
}

function ArchRow({
  icon: Icon,
  title,
  body,
}: {
  icon: typeof Globe;
  title: string;
  body: string;
}) {
  return (
    <div className="arch-row">
      <div className="arch-icon">
        <Icon size={18} strokeWidth={1.75} />
      </div>
      <div>
        <h4 className="arch-title">{title}</h4>
        <p className="arch-body">{body}</p>
      </div>
    </div>
  );
}
