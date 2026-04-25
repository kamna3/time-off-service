# Time-Off Microservice

A NestJS microservice for managing employee time-off requests with HCM (Human Capital Management) system synchronization.

## Prerequisites

- Node.js 18+
- npm 9+

## Installation

```bash
npm install
```

## Running the Service

### 1. Start the Mock HCM Server (required for development & E2E tests)

```bash
npm run mock:hcm
# Runs on http://localhost:4000
```

### 2. Start the Microservice

```bash
npm run start:dev
# Runs on http://localhost:3000
# API base path: /api/v1
```

## Testing

### Unit Tests

```bash
npm test
```

### Unit Tests with Coverage Report

```bash
npm run test:cov
# Coverage report written to ./coverage/
```

### E2E Tests

```bash
# Ensure mock HCM is NOT already running (nock intercepts HTTP)
npm run test:e2e
```

## API Overview

| Method | Path | Description |
|--------|------|-------------|
| POST | /api/v1/time-off | Submit a new time-off request |
| GET | /api/v1/time-off | List requests (query: employeeId, status) |
| GET | /api/v1/time-off/:id | Get a single request |
| PATCH | /api/v1/time-off/:id/approve | Manager approves a request |
| PATCH | /api/v1/time-off/:id/reject | Manager rejects a request |
| DELETE | /api/v1/time-off/:id | Employee cancels a request |
| GET | /api/v1/balances/:empId/:locId | Get balance for one employee/location |
| GET | /api/v1/balances | List all balances |
| POST | /api/v1/sync/batch | Receive batch balance push from HCM |
| POST | /api/v1/sync/realtime | Sync single employee balance from HCM |
| POST | /api/v1/sync/trigger | Trigger a full batch pull from HCM |
| GET | /api/v1/sync/logs | Retrieve sync audit logs |

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `HCM_BASE_URL` | `http://localhost:4000` | HCM API base URL |
| `HCM_API_KEY` | `mock-api-key` | HCM authentication key |
| `HCM_TIMEOUT_MS` | `5000` | HCM request timeout (ms) |
| `DB_PATH` | `time-off.db` | SQLite file (`:memory:` for tests) |
| `PORT` | `3000` | Service port |
| `MOCK_HCM_PORT` | `4000` | Mock HCM server port |

## Example: Create and Approve a Request

```bash
# 1. Seed a balance via batch push
curl -X POST http://localhost:3000/api/v1/sync/batch \
  -H "Content-Type: application/json" \
  -d '{"balances":[{"employeeId":"emp-001","locationId":"loc-us","balance":10}]}'

# 2. Check the balance
curl http://localhost:3000/api/v1/balances/emp-001/loc-us

# 3. Create a time-off request
curl -X POST http://localhost:3000/api/v1/time-off \
  -H "Content-Type: application/json" \
  -d '{
    "employeeId": "emp-001",
    "locationId": "loc-us",
    "startDate": "2025-08-01",
    "endDate": "2025-08-05",
    "daysRequested": 5
  }'

# 4. Approve the request (replace REQUEST_ID)
curl -X PATCH http://localhost:3000/api/v1/time-off/REQUEST_ID/approve \
  -H "Content-Type: application/json" \
  -d '{"managerId":"mgr-001"}'
```

## Project Structure

```
src/
  entities/          # TypeORM entities
  dtos/              # Validated DTOs
  modules/
    time-off/        # Request lifecycle (controller, service, tests)
    balance/         # Balance management (controller, service, tests)
    sync/            # HCM sync (client, service, controller, tests)
  app.module.ts
  main.ts
mock-hcm/
  server.js          # Standalone HCM mock server
test/
  app.e2e-spec.ts    # E2E integration tests
```

## Architecture Notes

- **Optimistic balance reservation**: Balance is reserved atomically when a PENDING request is created.
- **Idempotent HCM calls**: All deductions/credits use deterministic keys (`approve-{id}`, `cancel-{id}`).
- **Graceful HCM downtime**: Approvals proceed locally with `hcmConfirmed=false`; a 15-minute cron reconciles.
- **Scheduled batch sync**: Full HCM balance reconciliation runs every 6 hours.
- **Defensive validation**: Local balance pre-check runs before every request creation and HCM deduction attempt.
