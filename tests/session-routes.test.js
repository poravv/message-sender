// tests/session-routes.test.js
// Tests for POST /auth/session and POST /auth/logout-session endpoints

const mockRedis = {
  status: 'ready',
  get: jest.fn(),
  set: jest.fn().mockResolvedValue('OK'),
  del: jest.fn().mockResolvedValue(1),
  expire: jest.fn().mockResolvedValue(1),
};

jest.mock('../src/redisClient', () => ({
  getRedis: jest.fn(() => mockRedis),
}));

jest.mock('../src/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

// Mock crypto.randomUUID
const MOCK_UUID = 'ffffffff-1111-2222-3333-444444444444';
jest.mock('crypto', () => ({
  ...jest.requireActual('crypto'),
  randomUUID: jest.fn(() => MOCK_UUID),
}));

const { clearSession } = require('../src/middleware/sessionGuard');

function makeReq(overrides = {}) {
  return {
    auth: { uid: 'user-1' },
    headers: { 'user-agent': 'TestAgent/1.0' },
    ip: '127.0.0.1',
    connection: { remoteAddress: '127.0.0.1' },
    ...overrides,
  };
}

function makeRes() {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  res.setHeader = jest.fn();
  return res;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockRedis.status = 'ready';
  mockRedis.set.mockResolvedValue('OK');
  mockRedis.del.mockResolvedValue(1);
});

// ─── POST /auth/session (inline handler logic) ───

describe('POST /auth/session handler', () => {
  // Replicate the route handler logic to test it in isolation
  async function authSessionHandler(req, res) {
    try {
      const userId = req.auth.uid;
      const crypto = require('crypto');
      const { getRedis } = require('../src/redisClient');
      const redis = getRedis();

      const token = crypto.randomUUID();
      const sessionData = JSON.stringify({
        token,
        createdAt: new Date().toISOString(),
        userAgent: req.headers['user-agent'] || 'unknown',
        ip: req.ip || req.connection.remoteAddress || 'unknown',
      });

      await redis.set(`ms:session:${userId}`, sessionData, 'EX', 24 * 60 * 60);
      res.json({ sessionToken: token });
    } catch (error) {
      res.status(500).json({ error: 'Failed to create session' });
    }
  }

  test('returns sessionToken in response body', async () => {
    const req = makeReq();
    const res = makeRes();

    await authSessionHandler(req, res);

    expect(res.json).toHaveBeenCalledWith({ sessionToken: MOCK_UUID });
  });

  test('stores session data in Redis with correct key and TTL', async () => {
    const req = makeReq();
    const res = makeRes();

    await authSessionHandler(req, res);

    expect(mockRedis.set).toHaveBeenCalledWith(
      'ms:session:user-1',
      expect.any(String),
      'EX',
      86400
    );

    const storedJson = mockRedis.set.mock.calls[0][1];
    const stored = JSON.parse(storedJson);
    expect(stored.token).toBe(MOCK_UUID);
    expect(stored.createdAt).toBeDefined();
    expect(stored.userAgent).toBe('TestAgent/1.0');
    expect(stored.ip).toBe('127.0.0.1');
  });

  test('returns 500 when Redis fails', async () => {
    mockRedis.set.mockRejectedValue(new Error('Redis error'));

    const req = makeReq();
    const res = makeRes();

    await authSessionHandler(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ error: 'Failed to create session' });
  });
});

// ─── POST /auth/logout-session (uses clearSession) ───

describe('POST /auth/logout-session handler', () => {
  async function logoutSessionHandler(req, res) {
    try {
      const userId = req.auth.uid;
      await clearSession(userId);
      res.json({ success: true, message: 'Session cleared' });
    } catch (error) {
      res.status(500).json({ error: 'Failed to clear session' });
    }
  }

  test('clears Redis session key and returns 200', async () => {
    const req = makeReq();
    const res = makeRes();

    await logoutSessionHandler(req, res);

    expect(mockRedis.del).toHaveBeenCalledWith('ms:session:user-1');
    expect(res.json).toHaveBeenCalledWith({ success: true, message: 'Session cleared' });
  });

  test('returns 200 even if Redis errors (clearSession handles gracefully)', async () => {
    mockRedis.del.mockRejectedValue(new Error('Redis down'));

    const req = makeReq();
    const res = makeRes();

    await logoutSessionHandler(req, res);

    // clearSession catches errors internally, so handler still succeeds
    expect(res.json).toHaveBeenCalledWith({ success: true, message: 'Session cleared' });
  });
});
