# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

WhatsApp bulk message sender with multi-tenant support. Node.js 20+ Express backend with Baileys WebSocket library, PostgreSQL 16, Redis 7.2 + BullMQ queues, Firebase Auth, and a vanilla JS frontend. Deployed to Kubernetes via GitHub Actions CI/CD.

## Commands

```bash
npm run dev              # Start dev server with nodemon
npm start                # Production: node app.js
npm run docker:compose   # docker-compose up -d (starts app + Redis + PostgreSQL)
npm run docker:logs      # View container logs
npm run reset-auth       # Clear Baileys auth state

# Debugging scripts
node scripts/check-queue.js   # BullMQ queue status
node scripts/job-logs.js      # Job execution logs
node scripts/remove-job.js    # Remove jobs from queue
```

No automated test suite exists. Manual testing via `test-audio.js` and scripts in `scripts/`.

## Architecture

**Single Express app** (not a monorepo). Entry point: `app.js` → mounts routes from `src/routes.js`.

### Backend (`src/`)

| File | Role |
|---|---|
| `routes.js` | All REST endpoints (contacts CRUD, campaigns, dashboard analytics, connection status) |
| `manager.js` | `WhatsAppManager` — Baileys socket, QR generation, reconnection, rate limiting (15 msgs/min) |
| `sessionManager.js` | Per-user WhatsApp session lifecycle, multi-pod owner heartbeat via Redis |
| `queueRedis.js` | BullMQ worker (`ms:messages` queue), message processing with retries, campaign progress tracking |
| `auth.js` | Firebase ID token verification via `firebase-admin`. Bypassed in development (mock user) |
| `metricsStore.js` | Auto-selects PostgreSQL (`metricsStorePostgres.js`) or Redis fallback based on `POSTGRES_HOST` |
| `postgresClient.js` | Connection pool (size 10), slow query logging (>1s) |
| `redisClient.js` | ioredis singleton via `getRedis()` |
| `media.js` | Multer upload + FFmpeg audio conversion (AAC, 64k, 16kHz, mono) |
| `utils.js` | File cleanup, Paraguayan phone normalization (→ `595XXXXXXXXX`), CSV parsing |
| `stores/redisAuthState.js` | Baileys auth state persistence in Redis for multi-pod |

### Frontend (`public/js/`)

Vanilla JS modules with Bootstrap 5. Polls `/connection-status` every 15s for WhatsApp state. Modules: `core.js` (config), `main.js` (init), `whatsapp.js` (connection), `messages.js` (sending), `contacts.js` (CRUD), `dashboard.js` (analytics).

### Database (`db/init/01-schema.sql`)

PostgreSQL tables: `contacts` (unique per user+phone), `campaigns`, `campaign_recipients`, `metric_events`, `monthly_stats`, `contact_stats`. Views: `v_user_summary`, `v_monthly_activity`. Auto-updated `updated_at` triggers.

### Infrastructure

- **Docker**: Multi-stage build on `node:20-bullseye-slim` with ffmpeg
- **Kubernetes** (`k8s/`): Deployment + HPA, KEDA scale-to-zero, Ingress with cert-manager, PostgreSQL StatefulSet
- **CI/CD** (`.github/workflows/deploy.yml`): Push to main → test → Docker build → GHCR → kubectl apply
- Health endpoints: `GET /health` (liveness), `GET /ready` (readiness)

## Code Conventions

- **Logging**: Always use `require('./logger')` (pino) with structured context objects. Never `console.log`.
- **Redis access**: Always via `getRedis()` singleton from `redisClient.js`. Check status before use.
- **PostgreSQL**: Use pool from `postgresClient.js`, never create direct connections.
- **Phone numbers**: Normalize to Paraguayan format `595XXXXXXXXX` (12 digits) via `normalizeParaguayanNumber()`.
- **Auth**: JWT required in production. In development (`NODE_ENV !== 'production'`), a mock user is injected.
- **WhatsApp**: Handle `DisconnectReason` properly. Respect 15 msgs/min rate limit. Auth state persists in Redis.
- **File handling**: User-scoped file names (include userId). Auto-cleanup based on retention hours.

## Baileys Known Issues & Workarounds

- **Version**: `@whiskeysockets/baileys@7.0.0-rc.9`. Uses CommonJS require (not ESM).
- **405 Connection Failure (active ~Feb 2026)**: WhatsApp rejects `Platform.WEB`. Workaround: pass `version: [2, 3000, 1033893291]` in `makeWASocket()` config. Pending fix: Baileys PR #2365 (use `Platform.MACOS`).
- **QR not generated with stale auth**: Baileys never generates QR when stored credentials exist — it tries to reconnect. Method `cleanInitialize()` in `WhatsAppManager` clears Redis auth via `_clearRedisAuth()` and creates a fresh socket. Used by `/qr` endpoint when no socket exists.
- **Socket close event race condition**: When destroying old socket, MUST call `ev.removeAllListeners()` BEFORE closing, otherwise the close handler destroys the new socket.
- **`_deleteSessionFilesCompletely` fallback**: Uses `_clearRedisAuth()` when `_clearAuth` is null (session never initialized on current pod).

## Key Environment Variables

Core: `PORT`, `NODE_ENV`. Auth: `FIREBASE_SERVICE_ACCOUNT` (base64-encoded service-account JSON) or `GOOGLE_APPLICATION_CREDENTIALS` (file path). Redis: `REDIS_HOST`, `REDIS_PORT`, `REDIS_PASSWORD` (or `REDIS_URL`). PostgreSQL: `POSTGRES_HOST/PORT/USER/PASSWORD/DB`. S3/MinIO: `MINIO_ENDPOINT/ACCESS_KEY/SECRET_KEY/BUCKET`. See `.env.example` for full list.
