import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const repositoryParts = process.env.GITHUB_REPOSITORY?.split("/");
const repoName =
  repositoryParts && repositoryParts.length === 2 ? repositoryParts[1] : undefined;
const base = process.env.GITHUB_ACTIONS === "true" && repoName ? `/${repoName}/` : "/";

export default defineConfig({
  root: "pages",
  base,
  plugins: [react()],
  build: {
    outDir: "../dist-pages",
    emptyOutDir: true,
  },
});
