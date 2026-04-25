/**
 * Mock HCM Server
 * Simulates a real Human Capital Management system.
 * Supports: balance lookup, deduction, credit, batch fetch,
 * work-anniversary bonus events, and insufficient-balance errors.
 *
 * Run with: node mock-hcm/server.js
 */

const express = require('express');
const app = express();
app.use(express.json());

// In-memory balance store: key = `${employeeId}:${locationId}`
const balances = new Map();
// Track processed idempotency keys to prevent double-charges
const processedKeys = new Set();
// Transaction log
const transactions = [];

// Seed some initial balances for testing
const seedData = [
  { employeeId: 'emp-001', locationId: 'loc-us', balance: 15 },
  { employeeId: 'emp-002', locationId: 'loc-us', balance: 5 },
  { employeeId: 'emp-003', locationId: 'loc-uk', balance: 20 },
  { employeeId: 'emp-004', locationId: 'loc-us', balance: 0 },
  { employeeId: 'emp-005', locationId: 'loc-us', balance: 10 },
];

seedData.forEach(({ employeeId, locationId, balance }) => {
  const key = `${employeeId}:${locationId}`;
  balances.set(key, { employeeId, locationId, balance, version: 'v1' });
});

function getKey(employeeId, locationId) {
  return `${employeeId}:${locationId}`;
}

function newVersion() {
  return `v${Date.now()}`;
}

// ── GET /balances/:employeeId/:locationId ─────────────────────────────────────
app.get('/balances/:employeeId/:locationId', (req, res) => {
  const { employeeId, locationId } = req.params;
  const key = getKey(employeeId, locationId);
  const record = balances.get(key);

  if (!record) {
    return res.status(404).json({
      code: 'NOT_FOUND',
      message: `No balance for employee ${employeeId} at location ${locationId}`,
    });
  }

  res.json(record);
});

// ── GET /balances/batch ───────────────────────────────────────────────────────
app.get('/balances/batch', (req, res) => {
  res.json({ balances: Array.from(balances.values()) });
});

// ── POST /balances/deduct ─────────────────────────────────────────────────────
app.post('/balances/deduct', (req, res) => {
  const { employeeId, locationId, days, idempotencyKey } = req.body;

  if (!employeeId || !locationId || days == null || !idempotencyKey) {
    return res.status(400).json({ code: 'BAD_REQUEST', message: 'Missing required fields' });
  }

  // Idempotency: return same result for duplicate keys
  if (processedKeys.has(idempotencyKey)) {
    const txn = transactions.find(t => t.idempotencyKey === idempotencyKey);
    if (txn) return res.json(txn.result);
  }

  const key = getKey(employeeId, locationId);
  const record = balances.get(key);

  if (!record) {
    return res.status(404).json({
      code: 'EMPLOYEE_NOT_FOUND',
      message: `No balance for ${employeeId} at ${locationId}`,
    });
  }

  if (record.balance < days) {
    return res.status(422).json({
      code: 'INSUFFICIENT_BALANCE',
      message: `Insufficient balance. Available: ${record.balance}, Requested: ${days}`,
    });
  }

  // Apply deduction
  record.balance = parseFloat((record.balance - days).toFixed(4));
  record.version = newVersion();
  balances.set(key, record);

  const result = {
    transactionId: `txn-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    remainingBalance: record.balance,
    employeeId,
    locationId,
  };

  processedKeys.add(idempotencyKey);
  transactions.push({ idempotencyKey, result });

  res.json(result);
});

// ── POST /balances/credit ─────────────────────────────────────────────────────
app.post('/balances/credit', (req, res) => {
  const { employeeId, locationId, days, idempotencyKey } = req.body;

  if (!employeeId || !locationId || days == null || !idempotencyKey) {
    return res.status(400).json({ code: 'BAD_REQUEST', message: 'Missing required fields' });
  }

  if (processedKeys.has(idempotencyKey)) {
    const txn = transactions.find(t => t.idempotencyKey === idempotencyKey);
    if (txn) return res.json(txn.result);
  }

  const key = getKey(employeeId, locationId);
  let record = balances.get(key);

  if (!record) {
    // Create the record if it doesn't exist (edge case: balance was created after request)
    record = { employeeId, locationId, balance: 0, version: newVersion() };
  }

  record.balance = parseFloat((record.balance + days).toFixed(4));
  record.version = newVersion();
  balances.set(key, record);

  const result = {
    transactionId: `txn-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    remainingBalance: record.balance,
    employeeId,
    locationId,
  };

  processedKeys.add(idempotencyKey);
  transactions.push({ idempotencyKey, result });

  res.json(result);
});

// ── POST /admin/anniversary-bonus ─────────────────────────────────────────────
// Simulates a work-anniversary balance top-up (external HCM event)
app.post('/admin/anniversary-bonus', (req, res) => {
  const { employeeId, locationId, bonusDays } = req.body;
  const key = getKey(employeeId, locationId);
  const record = balances.get(key);

  if (!record) {
    return res.status(404).json({ code: 'NOT_FOUND', message: 'Employee not found' });
  }

  record.balance = parseFloat((record.balance + bonusDays).toFixed(4));
  record.version = newVersion();
  balances.set(key, record);

  console.log(`[HCM Mock] Anniversary bonus: +${bonusDays} days for ${employeeId}`);
  res.json({ message: 'Bonus applied', newBalance: record.balance });
});

// ── POST /admin/set-balance ───────────────────────────────────────────────────
// Test helper: set an arbitrary balance
app.post('/admin/set-balance', (req, res) => {
  const { employeeId, locationId, balance } = req.body;
  const key = getKey(employeeId, locationId);
  balances.set(key, {
    employeeId, locationId,
    balance: parseFloat(balance),
    version: newVersion(),
  });
  res.json({ message: 'Balance set', balance });
});

// ── GET /admin/state ──────────────────────────────────────────────────────────
// Test helper: dump full internal state
app.get('/admin/state', (req, res) => {
  res.json({
    balances: Object.fromEntries(balances),
    processedKeys: Array.from(processedKeys),
    transactionCount: transactions.length,
  });
});

// ── POST /admin/reset ─────────────────────────────────────────────────────────
// Test helper: reset to seed state
app.post('/admin/reset', (req, res) => {
  balances.clear();
  processedKeys.clear();
  transactions.length = 0;
  seedData.forEach(({ employeeId, locationId, balance }) => {
    balances.set(getKey(employeeId, locationId), {
      employeeId, locationId, balance, version: 'v1',
    });
  });
  res.json({ message: 'HCM mock reset to seed state' });
});

const PORT = process.env.MOCK_HCM_PORT || 4000;
app.listen(PORT, () => {
  console.log(`Mock HCM server running on port ${PORT}`);
  console.log(`Seeded ${seedData.length} employee balances`);
});

module.exports = { app };
