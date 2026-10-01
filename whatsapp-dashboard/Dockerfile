# Multi-stage build for React + Vite frontend

# ============================================
# Stage 1: Build the static assets
# ============================================
FROM node:20-alpine AS builder

WORKDIR /app

COPY package*.json ./

RUN npm ci

COPY . .

# Build-time environment variables (provided via build args).
#
# WARNING: a build ARG persists in the image's layer metadata and is readable
# by anyone who can run `docker history` on the image. That is acceptable for
# VITE_BACKEND_URL, which is only a URL — but NEVER add a secret-bearing
# VITE_* variable here. Anything prefixed VITE_ is also compiled into the
# browser bundle by Vite, so it is public to every visitor regardless.
# Server-side secrets belong in the backend's runtime environment only.
ARG VITE_BACKEND_URL

ENV VITE_BACKEND_URL=$VITE_BACKEND_URL

RUN npm run build

# ============================================
# Stage 2: Serve via Nginx
# ============================================
FROM nginx:alpine AS runner

# Copy built assets from builder
COPY --from=builder /app/dist /usr/share/nginx/html

# Copy nginx config if exists
COPY nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80

# NOTE on the process user: the backend image runs as a non-root `nodejs`
# user, this one does not. The nginx:alpine default is a root MASTER process
# that drops its worker processes to the unprivileged `nginx` user, which is
# what actually handles requests — so request handling is already unprivileged.
#
# Fully rootless means switching to nginxinc/nginx-unprivileged and moving off
# port 80 (a non-root process cannot bind a privileged port), which changes
# the port mapping in docker-compose.yml and the HEALTHCHECK below. Left as a
# deliberate follow-up rather than bundled into a security fix: this container
# serves only static files, behind another proxy, with no secrets in it.

# Use 127.0.0.1, not localhost — Alpine's musl resolver tries the ::1 (IPv6)
# record first when a hostname has both, and this nginx image only binds
# IPv4 by default, so "localhost" gets a spurious connection-refused here
# even while nginx is serving real traffic fine over the Docker network.
HEALTHCHECK --interval=30s --timeout=3s \
  CMD wget --quiet --tries=1 --spider http://127.0.0.1/ || exit 1

CMD ["nginx", "-g", "daemon off;"]
