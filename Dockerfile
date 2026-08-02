# syntax=docker/dockerfile:1
FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev
COPY VERSION ./
COPY cell.example.json .env.example ./
COPY src ./src
COPY scripts ./scripts
COPY docs ./docs
COPY public ./public
ENV NODE_ENV=production
ENV DRY_RUN=true
ENV SIMULATION_MODE=true
ENV DEMO_PUBLIC=true
# Public bind for Docker/Railway — DASHBOARD_PASSWORD (or NODE_PASSWORD/DASHBOARD_TOKEN) is mandatory.
# Dashboard refuses to start on 0.0.0.0 without a password (fail-closed).
ENV DASHBOARD_HOST=0.0.0.0
ENV DASHBOARD_ENABLED=true
EXPOSE 8080
CMD ["node", "src/index.js"]
