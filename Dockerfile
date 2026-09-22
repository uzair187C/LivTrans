# Production container for Live Voice Translation (Duet) on Google Cloud Run
FROM node:24-alpine AS builder

WORKDIR /app

# Copy backend dependencies
COPY prototype/backend/package*.json ./prototype/backend/

WORKDIR /app/prototype/backend
RUN npm ci --omit=dev

# Final runtime image
FROM node:24-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=8080

# Copy application files
COPY prototype ./prototype
COPY --from=builder /app/prototype/backend/node_modules ./prototype/backend/node_modules

EXPOSE 8080

WORKDIR /app/prototype/backend
CMD ["node", "server.js"]
