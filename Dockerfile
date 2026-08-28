# ============================================================
# AFRIKOBA GLOBAL - Production Image
# Stage 1: Build web-dashboard (Vite/React)
# Stage 2: Runtime - Express API + static dashboard (single origin)
# ============================================================

# ---------- Stage 1: Build web-dashboard ----------
FROM node:22-alpine AS dashboard-build
WORKDIR /build
COPY web-dashboard/package.json web-dashboard/package-lock.json* ./
RUN npm ci
COPY web-dashboard/ .
RUN npm run build

# ---------- Stage 2: Runtime ----------
FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app

# Dependencies za production (hakuna dev deps kwenye image)
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Source code
COPY src/ ./src/
COPY db/ ./db/
COPY scripts/ ./scripts/
COPY .env.example ./

# Web dashboard iliyojengwa (single-origin)
COPY --from=dashboard-build /build/dist ./web-dashboard/dist

# Contracts directory (PDFs)
RUN mkdir -p /app/contracts

# Run as non-root user (security best practice)
RUN addgroup -S afrikoba && adduser -S afrikoba -G afrikoba
RUN chown -R afrikoba:afrikoba /app
USER afrikoba

EXPOSE 3000

# Healthcheck kwa orchestrator pamoja na DB readiness
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -q -O - http://localhost:3000/health/db || exit 1

# Auto-migrate DB kisha anzisha API (runMigrations ni idempotent)
CMD ["sh", "-c", "node scripts/runMigrations.js && node src/server.js"]
