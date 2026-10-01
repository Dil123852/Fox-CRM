# Multi-stage build for production-grade Node.js backend

# ============================================
# Stage 1: Dependencies
# ============================================
FROM node:20-alpine AS deps

WORKDIR /app

COPY package*.json ./

RUN npm ci --only=production && npm cache clean --force

# ============================================
# Stage 2: Production runtime
# ============================================
FROM node:20-alpine AS runner

WORKDIR /app

# Create non-root user for security
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001

# Copy dependencies from deps stage
COPY --from=deps --chown=nodejs:nodejs /app/node_modules ./node_modules

# Copy application code
COPY --chown=nodejs:nodejs . .

# Switch to non-root user
USER nodejs

# Expose application port
EXPOSE 3000

# Set production environment
ENV NODE_ENV=production
ENV PORT=3000

# Health check — 127.0.0.1, not localhost. Alpine's musl resolver tries the
# ::1 (IPv6) record first when a hostname maps to both, which can hit
# connection-refused on a server that isn't listening on the IPv6 loopback
# (confirmed as the exact cause of the frontend container's same pattern).
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
  CMD wget --quiet --tries=1 --spider http://127.0.0.1:3000/health || exit 1

# Start the application
CMD ["node", "index.js"]
