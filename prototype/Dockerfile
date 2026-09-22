# Multi-stage production container for Live Voice Translation (Duet)
FROM node:24-alpine AS builder

WORKDIR /app

# Copy package descriptors
COPY prototype/backend/package*.json ./backend/

# Install production dependencies
WORKDIR /app/backend
RUN npm ci --omit=dev

# Final runtime image
FROM node:24-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=8080

# Copy application files
COPY prototype/backend ./backend
COPY prototype/frontend ./frontend
COPY --from=builder /app/backend/node_modules ./backend/node_modules

EXPOSE 8080

WORKDIR /app/backend
CMD ["node", "server.js"]
