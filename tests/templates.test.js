// tests/templates.test.js
// Tests for template CRUD endpoints (GET, POST, PUT, DELETE /templates)

const express = require('express');
const http = require('http');
const { Readable } = require('stream');

// Mock all heavy dependencies before requiring routes
jest.mock('firebase-admin', () => {
  const mockAuth = { verifyIdToken: jest.fn() };
  const mockFirestore = {};
  const app = { auth: () => mockAuth, firestore: () => mockFirestore };
  return {
    apps: [app],
    initializeApp: jest.fn(),
    credential: { cert: jest.fn(), applicationDefault: jest.fn() },
    auth: () => mockAuth,
    firestore: () => mockFirestore,
  };
});

jest.mock('../src/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

jest.mock('../src/auth/index', () => ({
  getAuthState: jest.fn(),
}));

jest.mock('../src/media', () => ({
  upload: {
    single: () => (req, res, next) => next(),
    fields: () => (req, res, next) => next(),
    array: () => (req, res, next) => next(),
  },
}));

jest.mock('qrcode', () => ({
  toDataURL: jest.fn(),
}));

jest.mock('../src/queueRedis', () => ({
  addMessage: jest.fn(),
  addBulkMessages: jest.fn(),
  getQueueStats: jest.fn().mockResolvedValue({}),
}));

jest.mock('../src/metricsStore', () => ({
  record: jest.fn(),
  getMonthlyStats: jest.fn().mockResolvedValue({}),
  getUserSummary: jest.fn().mockResolvedValue({}),
  getCampaignProgress: jest.fn().mockResolvedValue({}),
}));

jest.mock('../src/sessionManager', () => ({
  getSessionByToken: jest.fn(),
}));

jest.mock('../src/config', () => ({
  publicDir: '/tmp/test-public',
  retentionHours: 24,
}));

// Mock postgresClient — this is the key mock for template tests
const mockQuery = jest.fn();
jest.mock('../src/postgresClient', () => ({
  query: mockQuery,
  getPool: jest.fn(),
  getClient: jest.fn(),
  transaction: jest.fn(),
  healthCheck: jest.fn(),
  closePool: jest.fn(),
}));

// Set dev mode so conditionalAuth injects mock user
const originalEnv = process.env.NODE_ENV;

let app;
// Track whether ensureTemplatesTable has been triggered (its internal closure caches after first call)
let ensureTableTriggered = false;

beforeAll(() => {
  process.env.NODE_ENV = 'development';
  const { buildRoutes } = require('../src/routes');
  const router = buildRoutes();
  app = express();
  app.use(express.json());
  app.use('/', router);
});

afterAll(() => {
  process.env.NODE_ENV = originalEnv;
});

beforeEach(() => {
  mockQuery.mockReset();
});

/**
 * Helper: set up mockQuery for a template endpoint call.
 * On the very first call in the suite, ensureTemplatesTable will fire a CREATE TABLE query,
 * so we prepend an extra mock for that. After the first call, the closure caches `created = true`
 * and never calls CREATE TABLE again.
 */
function setupMocks(...resolvedValues) {
  if (!ensureTableTriggered) {
    // First invocation: ensureTemplatesTable will call pg.query(CREATE TABLE...)
    mockQuery.mockResolvedValueOnce({ rows: [] }); // CREATE TABLE
    ensureTableTriggered = true;
  }
  for (const val of resolvedValues) {
    mockQuery.mockResolvedValueOnce(val);
  }
}

/**
 * Helper: simulate an HTTP request through Express.
 * Returns { status, body }.
 */
function makeReq(method, url, body = null, query = {}) {
  return new Promise((resolve) => {
    const queryString = Object.keys(query).length
      ? '?' + new URLSearchParams(query).toString()
      : '';

    const bodyStr = body ? JSON.stringify(body) : '';

    const incoming = new Readable({ read() {} });
    incoming.push(bodyStr || null);
    incoming.push(null);
    incoming.method = method.toUpperCase();
    incoming.url = url + queryString;
    incoming.headers = {
      'content-type': 'application/json',
      'content-length': String(Buffer.byteLength(bodyStr)),
    };

    const mockRes = new http.ServerResponse(incoming);
    const chunks = [];

    const origWrite = mockRes.write.bind(mockRes);
    const origEnd = mockRes.end.bind(mockRes);

    mockRes.write = function (chunk) {
      if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      return origWrite(chunk);
    };

    mockRes.end = function (chunk) {
      if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      const raw = Buffer.concat(chunks).toString();
      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch {
        parsed = raw;
      }
      resolve({ status: mockRes.statusCode, body: parsed });
      return origEnd(chunk);
    };

    app(incoming, mockRes);
  });
}

describe('GET /templates', () => {
  test('returns templates for the current user', async () => {
    const fakeTemplates = [
      { id: 'uuid-1', user_id: 'dev-user-001', name: 'Greeting', content: 'Hello {{name}}', category: 'general' },
      { id: 'uuid-2', user_id: 'dev-user-001', name: 'Promo', content: 'Check out {{offer}}', category: 'marketing' },
    ];

    setupMocks({ rows: fakeTemplates });

    const { status, body } = await makeReq('GET', '/templates');

    expect(status).toBe(200);
    expect(body.templates).toEqual(fakeTemplates);
    expect(body.templates).toHaveLength(2);

    // Verify the SELECT query was called with user_id
    const selectCall = mockQuery.mock.calls.find(
      (c) => typeof c[0] === 'string' && c[0].includes('SELECT')
    );
    expect(selectCall).toBeDefined();
    expect(selectCall[1]).toEqual(['dev-user-001']);
  });

  test('filters by category when query param provided', async () => {
    const filtered = [
      { id: 'uuid-2', user_id: 'dev-user-001', name: 'Promo', content: 'Check out {{offer}}', category: 'marketing' },
    ];

    setupMocks({ rows: filtered });

    const { status, body } = await makeReq('GET', '/templates', null, { category: 'marketing' });

    expect(status).toBe(200);
    expect(body.templates).toEqual(filtered);

    // Verify category filter was included
    const selectCall = mockQuery.mock.calls.find(
      (c) => typeof c[0] === 'string' && c[0].includes('SELECT') && c[0].includes('category')
    );
    expect(selectCall).toBeDefined();
    expect(selectCall[1]).toContain('marketing');
  });

  test('only returns templates for current user (not other users)', async () => {
    setupMocks({ rows: [] });

    const { status, body } = await makeReq('GET', '/templates');

    expect(status).toBe(200);
    expect(body.templates).toEqual([]);

    // Verify user_id filter is always applied
    const selectCall = mockQuery.mock.calls.find(
      (c) => typeof c[0] === 'string' && c[0].includes('SELECT')
    );
    expect(selectCall).toBeDefined();
    expect(selectCall[0]).toContain('user_id = $1');
    expect(selectCall[1][0]).toBe('dev-user-001');
  });
});

describe('POST /templates', () => {
  test('creates a template with name, content, and category', async () => {
    const created = {
      id: 'uuid-new',
      user_id: 'dev-user-001',
      name: 'Welcome',
      content: 'Welcome {{name}} to our service',
      category: 'onboarding',
      variables: null,
      created_at: '2026-03-14T00:00:00Z',
      updated_at: '2026-03-14T00:00:00Z',
    };

    setupMocks({ rows: [created] });

    const { status, body } = await makeReq('POST', '/templates', {
      name: 'Welcome',
      content: 'Welcome {{name}} to our service',
      category: 'onboarding',
    });

    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.template).toEqual(created);

    // Verify INSERT query
    const insertCall = mockQuery.mock.calls.find(
      (c) => typeof c[0] === 'string' && c[0].includes('INSERT')
    );
    expect(insertCall).toBeDefined();
    expect(insertCall[1]).toContain('dev-user-001');
    expect(insertCall[1]).toContain('Welcome');
    expect(insertCall[1]).toContain('Welcome {{name}} to our service');
    expect(insertCall[1]).toContain('onboarding');
  });

  test('validates required fields — rejects missing name', async () => {
    // ensureTemplatesTable still runs (no-op after first), then validation fires before pg.query
    setupMocks();

    const { status, body } = await makeReq('POST', '/templates', {
      content: 'Some content',
    });

    expect(status).toBe(400);
    expect(body.error).toBeDefined();
    expect(body.error).toMatch(/requeridos/i);
  });

  test('validates required fields — rejects missing content', async () => {
    setupMocks();

    const { status, body } = await makeReq('POST', '/templates', {
      name: 'My Template',
    });

    expect(status).toBe(400);
    expect(body.error).toBeDefined();
    expect(body.error).toMatch(/requeridos/i);
  });

  test('validates required fields — rejects empty body', async () => {
    setupMocks();

    const { status, body } = await makeReq('POST', '/templates', {});

    expect(status).toBe(400);
    expect(body.error).toMatch(/requeridos/i);
  });
});

describe('PUT /templates/:id', () => {
  test('updates an existing template', async () => {
    const updated = {
      id: 'uuid-1',
      user_id: 'dev-user-001',
      name: 'Updated Greeting',
      content: 'Hi {{name}}, welcome back!',
      category: 'general',
      variables: null,
      updated_at: '2026-03-14T01:00:00Z',
    };

    setupMocks({ rows: [updated] });

    const { status, body } = await makeReq('PUT', '/templates/uuid-1', {
      name: 'Updated Greeting',
      content: 'Hi {{name}}, welcome back!',
      category: 'general',
    });

    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.template.name).toBe('Updated Greeting');

    // Verify UPDATE query includes id and user_id
    const updateCall = mockQuery.mock.calls.find(
      (c) => typeof c[0] === 'string' && c[0].includes('UPDATE')
    );
    expect(updateCall).toBeDefined();
    expect(updateCall[1]).toContain('uuid-1');
    expect(updateCall[1]).toContain('dev-user-001');
  });

  test('returns 404 when template not found or belongs to another user', async () => {
    setupMocks({ rows: [] });

    const { status, body } = await makeReq('PUT', '/templates/nonexistent-id', {
      name: 'Test',
      content: 'Test content',
    });

    expect(status).toBe(404);
    expect(body.error).toMatch(/no encontrada/i);
  });

  test('validates required fields on update', async () => {
    setupMocks();

    const { status, body } = await makeReq('PUT', '/templates/uuid-1', {
      name: 'Only name, no content',
    });

    expect(status).toBe(400);
    expect(body.error).toMatch(/requeridos/i);
  });
});

describe('DELETE /templates/:id', () => {
  test('deletes an existing template', async () => {
    setupMocks({ rows: [{ id: 'uuid-1' }] });

    const { status, body } = await makeReq('DELETE', '/templates/uuid-1');

    expect(status).toBe(200);
    expect(body.success).toBe(true);

    // Verify DELETE query uses both id and user_id
    const deleteCall = mockQuery.mock.calls.find(
      (c) => typeof c[0] === 'string' && c[0].includes('DELETE')
    );
    expect(deleteCall).toBeDefined();
    expect(deleteCall[1]).toContain('uuid-1');
    expect(deleteCall[1]).toContain('dev-user-001');
  });

  test('returns 404 when template not found', async () => {
    setupMocks({ rows: [] });

    const { status, body } = await makeReq('DELETE', '/templates/nonexistent-id');

    expect(status).toBe(404);
    expect(body.error).toMatch(/no encontrada/i);
  });
});

describe('Template user isolation', () => {
  test('all template queries include user_id filter', async () => {
    mockQuery.mockResolvedValue({ rows: [] });
    await makeReq('GET', '/templates');

    // Check every query that touches templates table includes user_id
    for (const call of mockQuery.mock.calls) {
      const sql = call[0];
      if (typeof sql === 'string' && sql.includes('templates') && !sql.includes('CREATE')) {
        expect(sql).toMatch(/user_id/);
      }
    }
  });
});
