# metrai_app

Application layer for Metrai: a FastAPI backend that handles auth and proxies simulation requests, and a Next.js frontend for configuring and viewing simulation runs.

## Architecture

```
Browser → Next.js frontend (:3000) → FastAPI backend (:8080) → metrai_simulation_engine (:8000)
```

The frontend never calls the simulation engine directly — everything goes through the backend.

## Project structure

```
metrai_app/
├── backend/     FastAPI app — auth, proxies simulation requests
├── frontend/    Next.js app — login, retailer/simulation UI
├── docker-compose.yml
└── .env.example
```

## Prerequisites

`metrai_simulation_engine` must be running first — it owns Postgres and ClickHouse. See its README.

## Running locally

```bash
cp .env.example .env   # set JWT_SECRET (must match the sim engine's)
docker compose up -d --build
```

- Frontend: http://localhost:3000
- Backend: http://localhost:8080

## Environment variables

See `.env.example` — key ones:

| Variable | Description |
|---|---|
| `JWT_SECRET` | Must match `JWT_SECRET` in `metrai_simulation_engine/.env` |
| `SIM_ENGINE_URL` / `DOCKER_SIM_ENGINE_URL` | URL of the simulation engine |
| `POSTGRES_DSN` / `DOCKER_POSTGRES_DSN` | Shared Postgres connection |

## Backend API

- `GET /health` — health check
- `POST /login`, `/register`, `/refresh`, `/logout` — auth
- Remaining endpoints proxy to the simulation engine (see its README for request/response shapes)
