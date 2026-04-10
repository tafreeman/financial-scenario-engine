import { defineConfig } from "vitepress";

export default defineConfig({
  title: "Financial Impact Analyzer",
  description:
    "Portable, browser-based project financial analysis tool with a deterministic TypeScript engine and an optional LLM layer.",
  base: "/fin-impact-tool/",
  head: [
    [
      "link",
      {
        rel: "icon",
        type: "image/svg+xml",
        href: "/fin-impact-tool/logo.svg",
      },
    ],
  ],
  lastUpdated: true,
  cleanUrls: true,
  markdown: {
    lineNumbers: true,
  },
  themeConfig: {
    logo: "/logo.svg",
    siteTitle: "Fin Impact Tool",
    nav: [
      { text: "Guide", link: "/guide/getting-started" },
      { text: "API", link: "/api/" },
      {
        text: "Engine",
        link: "/engine/",
      },
      { text: "Client", link: "/client/" },
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
        link: "https://github.com/tafreeman/fin-impact-tool",
      },
    ],
    editLink: {
      pattern:
        "https://github.com/tafreeman/fin-impact-tool/edit/main/docs/:path",
      text: "Edit this page on GitHub",
    },
    search: {
      provider: "local",
    },
    footer: {
      message: "Data stored locally in SQLite · No telemetry · No analytics",
      copyright: "Financial Impact Analyzer — Portable Edition",
    },
    outline: {
      level: [2, 3],
    },
  },
});
