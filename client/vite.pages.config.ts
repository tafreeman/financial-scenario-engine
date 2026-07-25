import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const repositoryParts = process.env.GITHUB_REPOSITORY?.split("/");
const repoName =
  repositoryParts && repositoryParts.length === 2 ? repositoryParts[1] : undefined;

// The Pages artifact is composed (see .github/workflows/deploy-pages.yml): the
// VitePress docs own the site root because that is where the README's links
// point, and this static overview site is nested under /overview/. `base` has
// to match that nesting or every hashed asset resolves one directory too high.
const base =
  process.env.GITHUB_ACTIONS === "true" && repoName ? `/${repoName}/overview/` : "/";

export default defineConfig({
  root: "pages",
  base,
  // `root` is `pages/`, so publicDir would otherwise resolve to
  // `client/pages/public` — which does not exist — and social-preview.png
  // (referenced by the og:image tag and the hero card) would never be emitted.
  publicDir: "../public",
  plugins: [react()],
  build: {
    outDir: "../dist-pages",
    emptyOutDir: true,
  },
});
