# syntax=docker/dockerfile:1.7
#
# Multi-stage build for the ROF LMS API.
#
#   docker build -t rof-api .                    # runtime image
#   docker build --target migrate -t rof-migrate .  # runs migrations + seed
#
# The runtime image contains only production dependencies and compiled code,
# and runs as the unprivileged `node` user.

ARG NODE_VERSION=24-bookworm-slim

# ── Dependencies (incl. dev: needed to build and to run Prisma CLI) ─────────
FROM node:${NODE_VERSION} AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

# ── Build ────────────────────────────────────────────────────────────────────
FROM deps AS build
COPY . .
RUN npx prisma generate \
 && npm run build

# ── Migrate (release step: apply migrations, then idempotent seed) ──────────
FROM build AS migrate
ENV NODE_ENV=production
CMD ["sh", "-c", "npx prisma migrate deploy && npx prisma db seed"]

# ── Runtime ──────────────────────────────────────────────────────────────────
FROM node:${NODE_VERSION} AS runtime
ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

COPY --from=build /app/dist ./dist

RUN mkdir -p /app/storage && chown -R node:node /app/storage
USER node

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/main.js"]
