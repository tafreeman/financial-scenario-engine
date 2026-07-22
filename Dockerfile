# syntax=docker/dockerfile:1
#
# Financial Scenario Engine — server deploy image
#
# The server has no separate compile step: `npm start` runs `tsx server/index.ts`
# directly against TypeScript source (see package.json "start" / "dev:server").
# This image mirrors that at runtime — it does NOT attempt a `tsc` emit of
# server/ — but it DOES build the static client (client/dist) that
# server/index.ts serves when present (server/index.ts:55-63), and it installs
# only production npm dependencies (plus the `tsx` runner) into the final
# runtime stage. better-sqlite3 is a native addon, so its postinstall build
# step must run inside this Linux image rather than being copied in from a
# host node_modules (which may be built for a different OS/arch).
#
# All configuration is externalized via environment variables (no secrets are
# baked into the image) — see .env.example for the full reference:
#   PORT, HOST, DB_PATH, APP_API_TOKEN, GITHUB_TOKEN, CORS_ORIGIN, NODE_ENV,
#   TRUST_PROXY_HOPS (set to 1 if this container sits behind a reverse proxy —
#   see server/trust-proxy.ts and README.md "Reverse-proxy mode")
#
# SQLite storage is externalized to /app/data, which is created and chowned to
# the non-root runtime user below and is intended to be mounted as a volume
# (docker run -v fse-data:/app/data ...) so the database survives container
# recreation.

# ─── Stage 1: deps — install root + client deps once, reused by later stages ──
FROM node:20-bookworm-slim AS deps

# better-sqlite3 (root dependency) ships prebuilt binaries for common
# platforms via prebuild-install, but falls back to compiling from source
# when no prebuilt binary matches — build-essential + python3 cover that
# fallback so the image build does not fail on an unexpected arch/libc.
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Root (server) deps — copy only manifests first so this layer is cached
# unless package.json/package-lock.json actually change.
COPY package.json package-lock.json ./
RUN npm ci

# Client deps — separate package-lock, installed into client/node_modules.
COPY client/package.json client/package-lock.json client/
RUN npm ci --prefix client

# ─── Stage 2: build — compile the static client bundle ───────────────────────
FROM deps AS build

WORKDIR /app

# Full source needed for the client's `tsc -b && vite build`.
COPY . .

# Produces client/dist, which server/index.ts serves as static assets + SPA
# fallback when the directory exists (server/index.ts:54-63). This is the
# same "build" script CI runs (see .github/workflows/deploy-pages.yml "ci" job).
RUN npm run build

# ─── Stage 3: prod-deps — root production dependencies only ──────────────────
# A separate `npm ci --omit=dev` pass (rather than pruning stage 1's install)
# guarantees the runtime image never inherits a devDependency, while still
# rebuilding better-sqlite3's native binding in a Linux environment.
FROM node:20-bookworm-slim AS prod-deps

RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
# tsx is the process that actually runs the server (package.json "start":
# "tsx server/index.ts") but lives in devDependencies since it's also used for
# local `dev`/watch. Install it explicitly in a second step (rather than as a
# trailing `&&` on the line below) so `--omit=dev` doesn't leave the runtime
# image without its own entrypoint runner — a shell comment placed inside a
# backslash-continued RUN would swallow everything after it on that logical
# line, silently dropping this install.
RUN npm ci --omit=dev
RUN npm install --no-save tsx@^4.19.0

# ─── Stage 4: runtime — slim image, non-root, externalized config/storage ────
FROM node:20-bookworm-slim AS runtime

ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0 \
    DB_PATH=/app/data/finimpact.db
# Intentionally NOT set here (must be supplied at deploy time):
#   APP_API_TOKEN  — shared secret for mutating routes (server/auth.ts).
#                    If left unset, a random token is generated at startup
#                    and printed once to the container's stdout/logs.
#   GITHUB_TOKEN    — GitHub Models API PAT for LLM intent parsing (server/ai.ts).
#                    Omit to run with Ollama instead (configure via /api/config).
#   CORS_ORIGIN     — MUST be set to the deployed frontend's exact origin;
#                    the server refuses to start if this is "*" (server/index.ts:22-28).

WORKDIR /app

# Non-root runtime user/group.
RUN groupadd --system --gid 1001 fse \
    && useradd --system --uid 1001 --gid fse --home-dir /app --shell /usr/sbin/nologin fse

# Production node_modules (root) built in the previous stage — never copies
# the host's node_modules, so native bindings (better-sqlite3) match this
# image's OS/arch/libc rather than the developer's machine.
COPY --from=prod-deps /app/node_modules ./node_modules

# Server source (tsx runs this directly — see header note) and app manifest.
COPY package.json ./
COPY server ./server

# Built static client — served by server/index.ts when present.
COPY --from=build /app/client/dist ./client/dist

# Externalized SQLite storage: create the mount point and hand ownership to
# the non-root user before switching to it, since a bind/volume mount at
# container start inherits this directory's ownership rather than the image
# default (root:root), which would otherwise make it unwritable for `fse`.
RUN mkdir -p /app/data && chown -R fse:fse /app/data /app

USER fse

EXPOSE 3000

# /api/health is unauthenticated (server/routes.ts) and requires no
# x-app-token, so it is safe to probe from the container runtime itself.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

# Matches package.json "start": "tsx server/index.ts" — the same entrypoint
# used outside Docker, so behavior (env parsing, DB init, static serving)
# is identical between local and containerized runs.
CMD ["node_modules/.bin/tsx", "server/index.ts"]
