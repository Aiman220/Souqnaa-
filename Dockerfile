# ==============================================================================
# SOUQNA ONLINE — PRODUCTION MULTI-STAGE DOCKERFILE
# ==============================================================================

# --- Stage 1: Builder ---
FROM node:20-alpine AS builder

WORKDIR /usr/src/app

# Install build dependencies
RUN apk add --no-cache python3 make g++

# Copy package descriptors
COPY package*.json ./
COPY tsconfig.json ./
COPY prisma ./prisma/

# Install all dependencies (including devDependencies needed for tsc & prisma)
RUN npm ci

# Generate Prisma Client
RUN npx prisma generate

# Copy application source
COPY src ./src

# Build TypeScript to dist/
RUN npm run build

# --- Stage 2: Production Runner ---
FROM node:20-alpine AS runner

WORKDIR /usr/src/app

# Install dumb-init for graceful signal handling (SIGTERM / SIGINT)
RUN apk add --no-cache dumb-init curl

# Configure production environment
ENV NODE_ENV=production
ENV PORT=4000

# Copy package descriptors
COPY package*.json ./
COPY prisma ./prisma/

# Install production dependencies only and generate Prisma runtime
RUN npm ci --omit=dev && npx prisma generate && npm cache clean --force

# Copy built JavaScript from builder stage
COPY --from=builder /usr/src/app/dist ./dist

# Create uploads directory structure with proper permissions for unprivileged node user
RUN mkdir -p ./uploads/branding && chown -R node:node /usr/src/app

# Use non-root node user
USER node

# Expose backend port
EXPOSE 4000

# Container healthcheck using minimal /health liveness probe
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "require('http').get('http://localhost:4000/health', (res) => process.exit(res.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"

# Entrypoint with dumb-init for clean process reaping and graceful shutdown
ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "dist/server.js"]
