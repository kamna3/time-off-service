import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';
import * as nock from 'nock';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ScheduleModule } from '@nestjs/schedule';
import { ConfigModule } from '@nestjs/config';
import { AppModule } from '../src/app.module';

/**
 * E2E Tests for Time-Off Microservice
 *
 * These tests spin up a full NestJS application with an in-memory SQLite database
 * and use nock to intercept and simulate HCM API responses.
 *
 * No real network calls are made. All HCM interactions are intercepted.
 */

const HCM_BASE = 'http://localhost:4000';

describe('Time-Off Microservice (E2E)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    process.env.HCM_BASE_URL = HCM_BASE;
    process.env.DB_PATH = ':memory:';

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider('TypeOrmModule')
      .useValue(undefined)
      .compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    app.setGlobalPrefix('api/v1');
    await app.init();

    nock.disableNetConnect();
    nock.enableNetConnect('127.0.0.1');
  });

  afterAll(async () => {
    nock.cleanAll();
    nock.enableNetConnect();
    await app.close();
  });

  afterEach(() => {
    nock.cleanAll();
  });

  // ──────────────────────────────────────────────────────────────────────────
  // BALANCE ENDPOINTS
  // ──────────────────────────────────────────────────────────────────────────

  describe('GET /api/v1/balances/:employeeId/:locationId', () => {
    it('should return 404 when balance record does not exist', async () => {
      await request(app.getHttpServer())
        .get('/api/v1/balances/emp-999/loc-us')
        .expect(404);
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // TIME-OFF REQUEST LIFECYCLE
  // ──────────────────────────────────────────────────────────────────────────

  describe('Full lifecycle: create → approve → cancel', () => {
    it('should fail to create request when no balance record exists', async () => {
      await request(app.getHttpServer())
        .post('/api/v1/time-off')
        .send({
          employeeId: 'emp-no-balance',
          locationId: 'loc-us',
          startDate: '2025-07-01',
          endDate: '2025-07-03',
          daysRequested: 3,
        })
        .expect(400);
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // SYNC ENDPOINTS
  // ──────────────────────────────────────────────────────────────────────────

  describe('POST /api/v1/sync/batch (batch push from HCM)', () => {
    it('should accept a batch push and create balance records', async () => {
      const payload = {
        balances: [
          { employeeId: 'emp-sync-1', locationId: 'loc-us', balance: 10, version: 'v1' },
          { employeeId: 'emp-sync-2', locationId: 'loc-us', balance: 7, version: 'v1' },
        ],
      };

      const resp = await request(app.getHttpServer())
        .post('/api/v1/sync/batch')
        .send(payload)
        .expect(200);

      expect(resp.body.recordsProcessed).toBe(2);
      expect(resp.body.recordsUpdated).toBe(2);
      expect(resp.body.syncStatus).toBe('SUCCESS');
    });

    it('should handle empty batch gracefully', async () => {
      const resp = await request(app.getHttpServer())
        .post('/api/v1/sync/batch')
        .send({ balances: [] })
        .expect(200);

      expect(resp.body.recordsProcessed).toBe(0);
    });
  });

  describe('POST /api/v1/sync/realtime', () => {
    it('should sync a single employee balance from HCM', async () => {
      // First seed a balance via batch push
      await request(app.getHttpServer())
        .post('/api/v1/sync/batch')
        .send({
          balances: [{ employeeId: 'emp-rt-1', locationId: 'loc-us', balance: 5 }],
        });

      // Mock HCM realtime response
      nock(HCM_BASE)
        .get('/balances/emp-rt-1/loc-us')
        .reply(200, { employeeId: 'emp-rt-1', locationId: 'loc-us', balance: 8, version: 'v2' });

      const resp = await request(app.getHttpServer())
        .post('/api/v1/sync/realtime')
        .send({ employeeId: 'emp-rt-1', locationId: 'loc-us' })
        .expect(200);

      expect(resp.body.syncStatus).toBe('SUCCESS');

      // Verify balance was updated
      const balance = await request(app.getHttpServer())
        .get('/api/v1/balances/emp-rt-1/loc-us')
        .expect(200);

      expect(balance.body.hcmBalance).toBe(8);
    });
  });

  describe('Full lifecycle with nock-mocked HCM', () => {
    const emp = 'emp-e2e-1';
    const loc = 'loc-us';
    let requestId: string;

    beforeEach(async () => {
      // Seed balance via batch push
      await request(app.getHttpServer())
        .post('/api/v1/sync/batch')
        .send({
          balances: [{ employeeId: emp, locationId: loc, balance: 10, version: 'v1' }],
        });
    });

    it('step 1: should create a PENDING request', async () => {
      const resp = await request(app.getHttpServer())
        .post('/api/v1/time-off')
        .send({
          employeeId: emp,
          locationId: loc,
          startDate: '2025-08-01',
          endDate: '2025-08-05',
          daysRequested: 5,
        })
        .expect(201);

      expect(resp.body.status).toBe('PENDING');
      expect(resp.body.hcmConfirmed).toBe(false);
      requestId = resp.body.id;

      // Balance should now show 5 available (10 - 5 reserved)
      const balance = await request(app.getHttpServer())
        .get(`/api/v1/balances/${emp}/${loc}`)
        .expect(200);

      expect(balance.body.availableBalance).toBe(5);
      expect(balance.body.reservedBalance).toBe(5);
    });

    it('step 2: should reject a request when endDate < startDate', async () => {
      await request(app.getHttpServer())
        .post('/api/v1/time-off')
        .send({
          employeeId: emp,
          locationId: loc,
          startDate: '2025-08-10',
          endDate: '2025-08-05',
          daysRequested: 5,
        })
        .expect(400);
    });

    it('step 3: should approve request and confirm with HCM', async () => {
      // Create request
      const createResp = await request(app.getHttpServer())
        .post('/api/v1/time-off')
        .send({
          employeeId: emp,
          locationId: loc,
          startDate: '2025-09-01',
          endDate: '2025-09-03',
          daysRequested: 3,
        })
        .expect(201);

      const id = createResp.body.id;

      // Mock successful HCM deduction
      nock(HCM_BASE)
        .post('/balances/deduct')
        .reply(200, {
          transactionId: 'txn-e2e-001',
          remainingBalance: 7,
        });

      const approveResp = await request(app.getHttpServer())
        .patch(`/api/v1/time-off/${id}/approve`)
        .send({ managerId: 'mgr-001' })
        .expect(200);

      expect(approveResp.body.status).toBe('APPROVED');
      expect(approveResp.body.hcmConfirmed).toBe(true);
      expect(approveResp.body.hcmTransactionId).toBe('txn-e2e-001');
    });

    it('step 4: should handle HCM INSUFFICIENT_BALANCE by auto-rejecting', async () => {
      const createResp = await request(app.getHttpServer())
        .post('/api/v1/time-off')
        .send({
          employeeId: emp,
          locationId: loc,
          startDate: '2025-10-01',
          endDate: '2025-10-03',
          daysRequested: 3,
        })
        .expect(201);

      // HCM says insufficient (e.g. anniversary bonus was reversed externally)
      nock(HCM_BASE)
        .post('/balances/deduct')
        .reply(422, {
          code: 'INSUFFICIENT_BALANCE',
          message: 'Only 2 days available',
        });

      // Background getBalance call for re-sync
      nock(HCM_BASE)
        .get(`/balances/${emp}/${loc}`)
        .reply(200, { employeeId: emp, locationId: loc, balance: 2, version: 'v3' });

      const approveResp = await request(app.getHttpServer())
        .patch(`/api/v1/time-off/${createResp.body.id}/approve`)
        .send({ managerId: 'mgr-001' })
        .expect(200);

      expect(approveResp.body.status).toBe('REJECTED');
    });

    it('step 5: should approve locally when HCM is down (for reconciliation)', async () => {
      const createResp = await request(app.getHttpServer())
        .post('/api/v1/time-off')
        .send({
          employeeId: emp,
          locationId: loc,
          startDate: '2025-11-01',
          endDate: '2025-11-02',
          daysRequested: 2,
        })
        .expect(201);

      // HCM is down
      nock(HCM_BASE)
        .post('/balances/deduct')
        .replyWithError('Connection refused');

      const approveResp = await request(app.getHttpServer())
        .patch(`/api/v1/time-off/${createResp.body.id}/approve`)
        .send({ managerId: 'mgr-001' })
        .expect(200);

      expect(approveResp.body.status).toBe('APPROVED');
      expect(approveResp.body.hcmConfirmed).toBe(false); // flagged for reconciliation
    });
  });

  describe('GET /api/v1/sync/logs', () => {
    it('should return sync logs', async () => {
      const resp = await request(app.getHttpServer())
        .get('/api/v1/sync/logs')
        .expect(200);

      expect(Array.isArray(resp.body)).toBe(true);
    });

    it('should respect limit query param', async () => {
      const resp = await request(app.getHttpServer())
        .get('/api/v1/sync/logs?limit=2')
        .expect(200);

      expect(resp.body.length).toBeLessThanOrEqual(2);
    });
  });

  describe('Validation', () => {
    it('should return 400 for missing required fields', async () => {
      await request(app.getHttpServer())
        .post('/api/v1/time-off')
        .send({ employeeId: 'emp-001' }) // missing locationId, dates, daysRequested
        .expect(400);
    });

    it('should return 400 for negative daysRequested', async () => {
      await request(app.getHttpServer())
        .post('/api/v1/time-off')
        .send({
          employeeId: 'emp-001',
          locationId: 'loc-us',
          startDate: '2025-06-01',
          endDate: '2025-06-03',
          daysRequested: -1,
        })
        .expect(400);
    });

    it('should return 400 for invalid date format', async () => {
      await request(app.getHttpServer())
        .post('/api/v1/time-off')
        .send({
          employeeId: 'emp-001',
          locationId: 'loc-us',
          startDate: 'not-a-date',
          endDate: '2025-06-03',
          daysRequested: 2,
        })
        .expect(400);
    });
  });
});
