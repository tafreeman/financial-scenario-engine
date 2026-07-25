import { defineConfig } from "vitepress";

export default defineConfig({
  title: "Financial Scenario Engine",
  description:
    "Portable, browser-based project financial analysis tool with a deterministic TypeScript engine and an optional LLM layer.",
  base: "/financial-scenario-engine/",
  head: [
    [
      "link",
      {
        rel: "icon",
        type: "image/svg+xml",
        href: "/financial-scenario-engine/logo.svg",
      },
    ],
  ],
  lastUpdated: true,
  cleanUrls: true,
  appearance: "force-dark",
  markdown: {
    lineNumbers: true,
  },
  themeConfig: {
    logo: "/logo.svg",
    siteTitle: "Scenario Engine",
    nav: [
      { text: "Guide", link: "/guide/getting-started" },
      { text: "API", link: "/api/" },
      {
        text: "Engine",
        link: "/engine/",
      },
      { text: "Client", link: "/client/" },
      // Sibling surface in the same Pages artifact, built by client/vite.pages.config.ts.
      // `target` is required: without it the VitePress SPA router intercepts the
      // click, fails to resolve /overview/ to a markdown route, and renders its
      // own 404 instead of letting the browser load the real page.
      { text: "Overview", link: "/overview/", target: "_self" },
      {
        text: "Reference",
        items: [
          { text: "Testing", link: "/reference/testing" },
          { text: "Configuration", link: "/reference/configuration" },
          { text: "Security", link: "/reference/security" },
          { text: "Excel Import", link: "/excel/" },
          { text: "Changelog", link: "/reference/changelog" },
        ],
      },
    ],
    sidebar: {
      "/guide/": [
        {
          text: "Guide",
          items: [
            {
              text: "Getting Started",
              link: "/guide/getting-started",
            },
            { text: "Architecture", link: "/guide/architecture" },
            { text: "AI Workflows", link: "/guide/ai-workflows" },
          ],
        },
      ],
      "/api/": [
        {
          text: "API Reference",
          items: [
            { text: "Overview", link: "/api/" },
            { text: "Endpoints", link: "/api/endpoints" },
          ],
        },
      ],
      "/engine/": [
        {
          text: "Calculation Engine",
          items: [
            { text: "Overview", link: "/engine/" },
            { text: "Types & Constants", link: "/engine/types" },
            { text: "Labor", link: "/engine/labor" },
            { text: "Margin", link: "/engine/margin" },
            { text: "Budget", link: "/engine/budget" },
            { text: "EVM", link: "/engine/evm" },
            { text: "Scenarios", link: "/engine/scenarios" },
            { text: "Portfolio", link: "/engine/portfolio" },
            { text: "Matching", link: "/engine/matching" },
            { text: "Narrative", link: "/engine/narrative" },
            { text: "Executor", link: "/engine/executor" },
          ],
        },
      ],
      "/client/": [
        {
          text: "Frontend",
          items: [
            { text: "Overview", link: "/client/" },
            { text: "Components", link: "/client/components" },
          ],
        },
      ],
      "/excel/": [
        {
          text: "Excel Import",
          items: [{ text: "Overview", link: "/excel/" }],
        },
      ],
      "/reference/": [
        {
          text: "Reference",
          items: [
            { text: "Testing", link: "/reference/testing" },
            { text: "Configuration", link: "/reference/configuration" },
            { text: "Security", link: "/reference/security" },
            { text: "Changelog", link: "/reference/changelog" },
          ],
        },
      ],
    },
    socialLinks: [
      {
        icon: "github",
        link: "https://github.com/tafreeman/financial-scenario-engine",
      },
    ],
    editLink: {
      pattern:
        "https://github.com/tafreeman/financial-scenario-engine/edit/main/docs/:path",
      text: "Edit this page on GitHub",
    },
    search: {
      provider: "local",
    },
    footer: {
      message: "Data stored locally in SQLite · No telemetry · No analytics",
      copyright: "Financial Scenario Engine — Portable Edition",
    },
    outline: {
      level: [2, 3],
    },
  },
});
