// tests/sessionGuard.test.js
// Tests for sessionGuard middleware, createSession, clearSession

const mockRedis = {
  status: 'ready',
  get: jest.fn(),
  set: jest.fn(),
  del: jest.fn(),
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
const MOCK_UUID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
jest.mock('crypto', () => ({
  ...jest.requireActual('crypto'),
  randomUUID: jest.fn(() => MOCK_UUID),
}));

const { sessionGuard, createSession, clearSession, SESSION_PREFIX, SESSION_TTL } = require('../src/middleware/sessionGuard');
const logger = require('../src/logger');

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
  mockRedis.get.mockResolvedValue(null);
  mockRedis.set.mockResolvedValue('OK');
  mockRedis.del.mockResolvedValue(1);
  mockRedis.expire.mockResolvedValue(1);
});

// ─── sessionGuard middleware ───

describe('sessionGuard middleware', () => {
  test('request with matching session token passes through (next called)', async () => {
    const storedToken = 'matching-token-1234';
    const stored = JSON.stringify({
      token: storedToken,
      createdAt: new Date().toISOString(),
      userAgent: 'TestAgent',
      ip: '127.0.0.1',
    });
    mockRedis.get.mockResolvedValue(stored);

    const req = makeReq({ headers: { 'x-session-token': storedToken, 'user-agent': 'TestAgent' } });
    const res = makeRes();
    const next = jest.fn();

    await sessionGuard(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  test('refreshes TTL on valid session', async () => {
    const storedToken = 'matching-token-1234';
    const stored = JSON.stringify({
      token: storedToken,
      createdAt: new Date().toISOString(),
      userAgent: 'TestAgent',
      ip: '127.0.0.1',
    });
    mockRedis.get.mockResolvedValue(stored);

    const req = makeReq({ headers: { 'x-session-token': storedToken, 'user-agent': 'TestAgent' } });
    const res = makeRes();
    const next = jest.fn();

    await sessionGuard(req, res, next);

    expect(mockRedis.expire).toHaveBeenCalledWith(`${SESSION_PREFIX}user-1`, SESSION_TTL);
  });

  test('request with non-matching session token returns 401 session_conflict', async () => {
    const stored = JSON.stringify({
      token: 'stored-token-XXXX',
      createdAt: new Date().toISOString(),
      userAgent: 'OtherAgent',
      ip: '10.0.0.1',
    });
    mockRedis.get.mockResolvedValue(stored);

    const req = makeReq({ headers: { 'x-session-token': 'wrong-token-YYYY', 'user-agent': 'TestAgent' } });
    const res = makeRes();
    const next = jest.fn();

    await sessionGuard(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({
      error: 'session_conflict',
      message: 'Sesion activa en otro dispositivo',
    });
  });

  test('request with no session token and no stored session passes through', async () => {
    mockRedis.get.mockResolvedValue(null);

    const req = makeReq({ headers: { 'user-agent': 'TestAgent' } }); // no x-session-token
    const res = makeRes();
    const next = jest.fn();

    await sessionGuard(req, res, next);

    expect(next).toHaveBeenCalled();
    // A new session should have been created
    expect(mockRedis.set).toHaveBeenCalled();
    expect(res.setHeader).toHaveBeenCalledWith('X-Session-Token', MOCK_UUID);
  });

  test('request with no session token but stored session exists passes through (allows /auth/session call)', async () => {
    const stored = JSON.stringify({
      token: 'existing-token',
      createdAt: new Date().toISOString(),
      userAgent: 'OtherDevice',
      ip: '192.168.1.1',
    });
    mockRedis.get.mockResolvedValue(stored);

    const req = makeReq({ headers: { 'user-agent': 'TestAgent' } }); // no x-session-token
    const res = makeRes();
    const next = jest.fn();

    await sessionGuard(req, res, next);

    // Should pass through so frontend can call /auth/session
    expect(next).toHaveBeenCalled();
    // Should NOT overwrite the existing session
    expect(mockRedis.set).not.toHaveBeenCalled();
  });

  test('Redis down passes through gracefully with warning', async () => {
    mockRedis.status = 'reconnecting';

    const req = makeReq({ headers: { 'x-session-token': 'some-token', 'user-agent': 'TestAgent' } });
    const res = makeRes();
    const next = jest.fn();

    await sessionGuard(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ uid: 'user-1', redisStatus: 'reconnecting' }),
      expect.stringContaining('Redis not ready')
    );
  });

  test('Redis get throws error passes through gracefully', async () => {
    mockRedis.get.mockRejectedValue(new Error('Connection refused'));

    const req = makeReq({ headers: { 'x-session-token': 'some-token', 'user-agent': 'TestAgent' } });
    const res = makeRes();
    const next = jest.fn();

    await sessionGuard(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalled();
  });

  test('no auth context passes through (next called)', async () => {
    const req = makeReq({ auth: null });
    const res = makeRes();
    const next = jest.fn();

    await sessionGuard(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(mockRedis.get).not.toHaveBeenCalled();
  });

  test('corrupt stored session data creates new session', async () => {
    mockRedis.get.mockResolvedValue('not-valid-json{{{');

    const req = makeReq({ headers: { 'x-session-token': 'any-token', 'user-agent': 'TestAgent' } });
    const res = makeRes();
    const next = jest.fn();

    await sessionGuard(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(mockRedis.set).toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ uid: 'user-1' }),
      expect.stringContaining('corrupt')
    );
  });

  test('client token with no stored session re-adopts client token (no new UUID)', async () => {
    const clientToken = 'existing-client-token-12345';
    mockRedis.get.mockResolvedValue(null); // no stored session

    const req = makeReq({ headers: { 'x-session-token': clientToken, 'user-agent': 'TestAgent' } });
    const res = makeRes();
    const next = jest.fn();

    await sessionGuard(req, res, next);

    expect(next).toHaveBeenCalled();
    // Should re-adopt the client's token, not generate a new UUID
    expect(mockRedis.set).toHaveBeenCalled();
    const storedJson = mockRedis.set.mock.calls[0][1];
    const stored = JSON.parse(storedJson);
    expect(stored.token).toBe(clientToken); // client's token, NOT MOCK_UUID
    // Should NOT set a new X-Session-Token header (client already has the right one)
    expect(res.setHeader).not.toHaveBeenCalled();
  });
});

// ─── createSession ───

describe('createSession', () => {
  test('generates UUID token and stores in Redis with TTL', async () => {
    const req = makeReq();
    const res = makeRes();

    const token = await createSession('user-1', req, res);

    expect(token).toBe(MOCK_UUID);
    expect(mockRedis.set).toHaveBeenCalledWith(
      `${SESSION_PREFIX}user-1`,
      expect.any(String),
      'EX',
      SESSION_TTL
    );
  });

  test('stored data includes token, createdAt, userAgent, ip', async () => {
    const req = makeReq();
    const res = makeRes();

    await createSession('user-1', req, res);

    const storedJson = mockRedis.set.mock.calls[0][1];
    const stored = JSON.parse(storedJson);

    expect(stored.token).toBe(MOCK_UUID);
    expect(stored.createdAt).toBeDefined();
    expect(stored.userAgent).toBe('TestAgent/1.0');
    expect(stored.ip).toBe('127.0.0.1');
  });

  test('returns the session token', async () => {
    const req = makeReq();
    const res = makeRes();

    const result = await createSession('user-1', req, res);

    expect(result).toBe(MOCK_UUID);
  });

  test('sets X-Session-Token response header', async () => {
    const req = makeReq();
    const res = makeRes();

    await createSession('user-1', req, res);

    expect(res.setHeader).toHaveBeenCalledWith('X-Session-Token', MOCK_UUID);
  });

  test('overwrites existing session (new device login)', async () => {
    // First session
    mockRedis.get.mockResolvedValue(JSON.stringify({ token: 'old-token' }));

    const req = makeReq();
    const res = makeRes();

    await createSession('user-1', req, res);

    // set is called regardless of existing data — it overwrites
    expect(mockRedis.set).toHaveBeenCalledWith(
      `${SESSION_PREFIX}user-1`,
      expect.any(String),
      'EX',
      SESSION_TTL
    );
  });
});

// ─── clearSession ───

describe('clearSession', () => {
  test('deletes Redis key ms:session:{userId}', async () => {
    await clearSession('user-1');

    expect(mockRedis.del).toHaveBeenCalledWith(`${SESSION_PREFIX}user-1`);
  });

  test('handles Redis errors gracefully', async () => {
    mockRedis.del.mockRejectedValue(new Error('Redis down'));

    // Should not throw
    await clearSession('user-1');

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ uid: 'user-1', err: 'Redis down' }),
      expect.stringContaining('clearSession error')
    );
  });

  test('handles Redis not ready gracefully', async () => {
    mockRedis.status = 'reconnecting';

    await clearSession('user-1');

    expect(mockRedis.del).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ uid: 'user-1' }),
      expect.stringContaining('Redis not ready')
    );
  });
});
