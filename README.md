# Turf API

Backend for Champions Turf — the NestJS REST API behind the `turf-admin` Next.js app.

## Requirements

- Node.js **24.15+** (the Nest 12 tooling requires it; with an older Node, add `--ignore-engines` to `yarn install` / `yarn add`)
- Yarn 1.x

## Setup

```bash
yarn install
cp .env.example .env
yarn start:dev
```

The API runs at http://localhost:4000/api/v1. Check it with:

```bash
curl http://localhost:4000/api/v1/health
# {"success":true,"data":{"status":"ok","uptime":3}}
```

## Scripts

| Command | What it does |
|---|---|
| `yarn start:dev` | Dev server with file watching |
| `yarn build` | Compile to `dist/` |
| `yarn start:prod` | Run the compiled build |
| `yarn test` | Unit tests (Vitest) |
| `yarn test:e2e` | End-to-end tests (Supertest) |
| `yarn lint` | Lint with oxlint |

## Response format

Every response uses the same envelope:

```json
{ "success": true, "data": { } }
{ "success": false, "error": "That slot was just taken", "code": "SLOT_UNAVAILABLE" }
```

See `CLAUDE.md` for the conventions every module follows.
