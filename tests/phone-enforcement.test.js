// tests/phone-enforcement.test.js
// Phase 4: One Phone Line Per User — phone management logic tests

// ─── Firestore mock setup (must be before any require) ───
const mockGet = jest.fn();
const mockSet = jest.fn();
const mockUpdate = jest.fn();
const mockWhere = jest.fn();
const mockLimit = jest.fn();
const mockQueryGet = jest.fn();
const mockDoc = jest.fn(() => ({ get: mockGet, set: mockSet, update: mockUpdate }));
const mockCollection = jest.fn(() => ({
  doc: mockDoc,
  where: mockWhere,
}));

// Chain: collection('users').where(...).limit(...).get()
mockWhere.mockReturnValue({ limit: mockLimit });
mockLimit.mockReturnValue({ get: mockQueryGet });

jest.mock('firebase-admin', () => {
  const mockFirestore = Object.assign(jest.fn(() => ({ collection: mockCollection })), {
    FieldValue: { serverTimestamp: jest.fn(() => 'SERVER_TIMESTAMP') },
  });
  const mockAuth = { verifyIdToken: jest.fn() };
  const app = { auth: () => mockAuth, firestore: mockFirestore };
  return {
    apps: [app],
    initializeApp: jest.fn(),
    credential: { cert: jest.fn(), applicationDefault: jest.fn() },
    auth: () => mockAuth,
    firestore: mockFirestore,
  };
});

jest.mock('../src/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

jest.mock('../src/auth', () => ({
  checkJwt: jest.fn((req, res, next) => next()),
}));

jest.mock('../src/auth/index', () => ({
  getAuthState: jest.fn().mockResolvedValue({
    state: {},
    saveCreds: jest.fn(),
    clear: jest.fn(),
  }),
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
  toFile: jest.fn(),
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
  sessions: new Map(),
}));

jest.mock('../src/config', () => ({
  publicDir: '/tmp/test-public',
  retentionHours: 24,
  isAuthorizedPhone: jest.fn(() => true),
}));

jest.mock('../src/redisClient', () => ({
  getRedis: jest.fn(() => null),
}));

jest.mock('../src/middleware/ensureUserProfile', () => ({
  ensureUserProfile: jest.fn((req, res, next) => next()),
  invalidateProfileCache: jest.fn(),
}));

jest.mock('../src/middleware/checkTrial', () => ({
  checkTrial: jest.fn((req, res, next) => next()),
}));

jest.mock('../src/middleware/ensureEmailVerified', () => ({
  ensureEmailVerified: jest.fn((req, res, next) => next()),
}));

jest.mock('../src/middleware/sessionGuard', () => ({
  sessionGuard: jest.fn((req, res, next) => next()),
  createSession: jest.fn((req, res, next) => next()),
  clearSession: jest.fn((req, res, next) => next()),
}));

jest.mock('../src/queue', () => ({
  MessageQueue: jest.fn().mockImplementation(() => ({})),
}));

jest.mock('@whiskeysockets/baileys', () => ({
  default: jest.fn(),
  DisconnectReason: { loggedOut: 401 },
}));

jest.mock('fs', () => {
  const actual = jest.requireActual('fs');
  return {
    ...actual,
    existsSync: jest.fn(() => false),
    mkdirSync: jest.fn(),
    unlinkSync: jest.fn(),
    readdirSync: jest.fn(() => []),
    rmdirSync: jest.fn(),
    lstatSync: jest.fn(),
    promises: { rm: jest.fn() },
  };
});

const http = require('http');
const express = require('express');
const { invalidateProfileCache } = require('../src/middleware/ensureUserProfile');
const sessionManager = require('../src/sessionManager');

// ─── Helper: HTTP request against Express app ───
function request(app, method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const port = server.address().port;
      const options = {
        hostname: '127.0.0.1',
        port,
        path: urlPath,
        method: method.toUpperCase(),
        headers: { 'Content-Type': 'application/json' },
      };

      const req = http.request(options, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          server.close();
          let parsed;
          try { parsed = JSON.parse(data); } catch (e) { parsed = data; }
          resolve({ status: res.statusCode, body: parsed });
        });
      });

      req.on('error', (err) => { server.close(); reject(err); });
      if (body) req.write(JSON.stringify(body));
      req.end();
    });
  });
}

// ═══════════════════════════════════════════════════════════
// 1. Phone extraction from JID
// ═══════════════════════════════════════════════════════════
describe('WhatsAppManager._extractPhoneFromJid', () => {
  let manager;

  beforeEach(() => {
    const { WhatsAppManager } = require('../src/manager');
    manager = new WhatsAppManager('test-user');
  });

  test('extracts phone from JID with colon (device suffix)', () => {
    expect(manager._extractPhoneFromJid('595971123456:12@s.whatsapp.net'))
      .toBe('595971123456');
  });

  test('extracts phone from JID without colon', () => {
    expect(manager._extractPhoneFromJid('595981654321@s.whatsapp.net'))
      .toBe('595981654321');
  });

  test('returns null for null input', () => {
    expect(manager._extractPhoneFromJid(null)).toBeNull();
  });

  test('returns null for undefined input', () => {
    expect(manager._extractPhoneFromJid(undefined)).toBeNull();
  });

  test('handles JID with no @ symbol', () => {
    // Edge case: raw phone number
    expect(manager._extractPhoneFromJid('595971123456')).toBe('595971123456');
  });

  test('handles empty string', () => {
    // Empty string is falsy but not null/undefined
    expect(manager._extractPhoneFromJid('')).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════
// 2. Phone uniqueness check (_handlePhoneRegistration)
// ═══════════════════════════════════════════════════════════
describe('WhatsAppManager._handlePhoneRegistration', () => {
  let manager;

  beforeEach(() => {
    jest.clearAllMocks();
    // Reset the where/limit/get chain
    mockWhere.mockReturnValue({ limit: mockLimit });
    mockLimit.mockReturnValue({ get: mockQueryGet });

    const { WhatsAppManager } = require('../src/manager');
    manager = new WhatsAppManager('user-123');
  });

  test('allows registration when no other user has the phone', async () => {
    // Firestore query returns no docs
    mockQueryGet.mockResolvedValue({ docs: [] });
    mockUpdate.mockResolvedValue();

    const result = await manager._handlePhoneRegistration('595971123456');

    expect(result).toBe(true);
    expect(mockCollection).toHaveBeenCalledWith('users');
    expect(mockWhere).toHaveBeenCalledWith('whatsappPhone', '==', '595971123456');
    expect(mockUpdate).toHaveBeenCalledWith({ whatsappPhone: '595971123456' });
    expect(invalidateProfileCache).toHaveBeenCalledWith('user-123');
  });

  test('allows registration when only the same user has the phone', async () => {
    // Firestore query returns the same user
    mockQueryGet.mockResolvedValue({
      docs: [{ id: 'user-123', data: () => ({ whatsappPhone: '595971123456' }) }],
    });
    mockUpdate.mockResolvedValue();

    const result = await manager._handlePhoneRegistration('595971123456');

    expect(result).toBe(true);
    expect(mockUpdate).toHaveBeenCalledWith({ whatsappPhone: '595971123456' });
  });

  test('blocks registration when another user has the phone', async () => {
    // Firestore query returns a different user
    mockQueryGet.mockResolvedValue({
      docs: [{ id: 'other-user-456', data: () => ({ whatsappPhone: '595971123456' }) }],
    });

    const result = await manager._handlePhoneRegistration('595971123456');

    expect(result).toBe(false);
    // Should NOT update Firestore
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  test('gracefully allows connection when Firestore is down', async () => {
    // Firestore query throws error
    mockQueryGet.mockRejectedValue(new Error('Firestore unavailable'));

    const result = await manager._handlePhoneRegistration('595971123456');

    expect(result).toBe(true); // Should not block connection
  });

  test('gracefully allows if Firestore update fails after check', async () => {
    mockQueryGet.mockResolvedValue({ docs: [] });
    mockUpdate.mockRejectedValue(new Error('Write failed'));

    const result = await manager._handlePhoneRegistration('595971123456');

    expect(result).toBe(true); // Should not block connection
  });
});

// ═══════════════════════════════════════════════════════════
// 3. _clearFirestorePhone
// ═══════════════════════════════════════════════════════════
describe('WhatsAppManager._clearFirestorePhone', () => {
  let manager;

  beforeEach(() => {
    jest.clearAllMocks();
    const { WhatsAppManager } = require('../src/manager');
    manager = new WhatsAppManager('user-789');
  });

  test('sets whatsappPhone to null in Firestore', async () => {
    mockUpdate.mockResolvedValue();

    await manager._clearFirestorePhone();

    expect(mockCollection).toHaveBeenCalledWith('users');
    expect(mockDoc).toHaveBeenCalledWith('user-789');
    expect(mockUpdate).toHaveBeenCalledWith({ whatsappPhone: null });
    expect(invalidateProfileCache).toHaveBeenCalledWith('user-789');
  });

  test('does not throw when Firestore update fails', async () => {
    mockUpdate.mockRejectedValue(new Error('Firestore down'));

    // Should not throw
    await expect(manager._clearFirestorePhone()).resolves.toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════
// 4. Admin unlink phone endpoint (DELETE /admin/users/:userId/phone)
// ═══════════════════════════════════════════════════════════
describe('DELETE /admin/users/:userId/phone', () => {
  let app;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.NODE_ENV = 'development';

    app = express();
    app.use(express.json());
    const { buildRoutes } = require('../src/routes');
    const router = buildRoutes();
    app.use(router);
  });

  test('admin can unlink a user phone (200)', async () => {
    // Dev mode sets role: 'admin' by default
    mockGet.mockResolvedValue({
      exists: true,
      data: () => ({ whatsappPhone: '595971111111' }),
    });
    mockUpdate.mockResolvedValue();

    const res = await request(app, 'DELETE', '/admin/users/target-user-1/phone');

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.previousPhone).toBe('595971111111');
    expect(res.body.message).toMatch(/unlinked/i);
  });

  test('returns 404 if user does not exist', async () => {
    mockGet.mockResolvedValue({ exists: false });

    const res = await request(app, 'DELETE', '/admin/users/nonexistent-user/phone');

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not found/i);
  });

  test('sets whatsappPhone to null in Firestore', async () => {
    mockGet.mockResolvedValue({
      exists: true,
      data: () => ({ whatsappPhone: '595972222222' }),
    });
    mockUpdate.mockResolvedValue();

    await request(app, 'DELETE', '/admin/users/target-user-2/phone');

    expect(mockDoc).toHaveBeenCalledWith('target-user-2');
    expect(mockUpdate).toHaveBeenCalledWith({ whatsappPhone: null });
  });

  test('non-admin gets 403', async () => {
    // Override NODE_ENV to production so conditionalAuth uses real middleware chain
    // But since we mock checkJwt to call next(), and ensureUserProfile to call next(),
    // we need to set userProfile with role != admin via a middleware
    process.env.NODE_ENV = 'production';

    // Rebuild app with production env
    const appProd = express();
    appProd.use(express.json());

    // Inject non-admin auth before routes
    const { ensureUserProfile: ensureUserProfileMock } = require('../src/middleware/ensureUserProfile');
    ensureUserProfileMock.mockImplementation((req, res, next) => {
      req.userProfile = {
        uid: 'regular-user',
        role: 'user',
        plan: 'active',
      };
      next();
    });

    const { buildRoutes: buildRoutesProd } = require('../src/routes');
    const routerProd = buildRoutesProd();
    appProd.use(routerProd);

    const res = await request(appProd, 'DELETE', '/admin/users/some-user/phone');

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/forbidden/i);

    // Restore
    process.env.NODE_ENV = 'development';
    ensureUserProfileMock.mockImplementation((req, res, next) => next());
  });
});

// ═══════════════════════════════════════════════════════════
// 5. Connection status includes phone info
// ═══════════════════════════════════════════════════════════
describe('GET /connection-status — phone info', () => {
  let app;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.NODE_ENV = 'development';

    app = express();
    app.use(express.json());
    const { buildRoutes } = require('../src/routes');
    const router = buildRoutes();
    app.use(router);
  });

  test('includes whatsappPhone from userProfile when available', async () => {
    // Mock sessionManager to return a manager-like object
    const mockManager = {
      getState: () => ({
        isReady: true,
        connectionState: 'connected',
        lastActivity: Date.now(),
        hasQR: false,
        securityAlert: null,
        userInfo: { phoneNumber: '595971123456', pushname: 'Test User', jid: '595971123456@s.whatsapp.net' },
      }),
      getConnectionHealth: () => ({
        isReady: true,
        connectionState: 'connected',
        conflictCount: 0,
        messageCount: 0,
        maxMessagesPerMinute: 15,
        isInCooldown: false,
        isConnecting: false,
        lastDisconnectReason: null,
        canSendMessages: true,
      }),
    };
    sessionManager.getSessionByToken.mockResolvedValue(mockManager);

    // In dev mode, the mock user has whatsappPhone: null by default
    // We need to check the response structure
    const res = await request(app, 'GET', '/connection-status');

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('status');
    expect(res.body).toHaveProperty('state');
    expect(res.body).toHaveProperty('userInfo');
    expect(res.body.userInfo.phoneNumber).toBe('595971123456');
  });

  test('phone_taken state is properly represented', async () => {
    const mockManager = {
      getState: () => ({
        isReady: false,
        connectionState: 'phone_taken',
        lastActivity: Date.now(),
        hasQR: false,
        securityAlert: {
          timestamp: Date.now(),
          messages: ['Este numero ya esta asociado a otro usuario'],
          phoneNumber: '595971123456',
          type: 'phone_taken',
        },
        userInfo: null,
      }),
      getConnectionHealth: () => ({
        isReady: false,
        connectionState: 'phone_taken',
        conflictCount: 0,
        messageCount: 0,
        maxMessagesPerMinute: 15,
        isInCooldown: false,
        isConnecting: false,
        lastDisconnectReason: null,
        canSendMessages: false,
      }),
    };
    sessionManager.getSessionByToken.mockResolvedValue(mockManager);

    const res = await request(app, 'GET', '/connection-status');

    expect(res.status).toBe(200);
    expect(res.body.state).toBe('phone_taken');
    expect(res.body).toHaveProperty('phoneTakenError');
    expect(res.body.phoneTakenError).toMatch(/asociado/i);
  });

  test('response structure includes all expected fields', async () => {
    const mockManager = {
      getState: () => ({
        isReady: false,
        connectionState: 'disconnected',
        lastActivity: Date.now(),
        hasQR: false,
        securityAlert: null,
        userInfo: null,
      }),
      getConnectionHealth: () => ({
        isReady: false,
        connectionState: 'disconnected',
        conflictCount: 0,
        messageCount: 0,
        maxMessagesPerMinute: 15,
        isInCooldown: false,
        isConnecting: false,
        lastDisconnectReason: null,
        canSendMessages: false,
      }),
    };
    sessionManager.getSessionByToken.mockResolvedValue(mockManager);

    const res = await request(app, 'GET', '/connection-status');

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('status');
    expect(res.body).toHaveProperty('state');
    expect(res.body).toHaveProperty('isReady');
    expect(res.body).toHaveProperty('lastActivity');
    expect(res.body).toHaveProperty('connectionState');
    expect(res.body).toHaveProperty('rateLimit');
    expect(res.body).toHaveProperty('conflicts');
    expect(res.body).toHaveProperty('connection');
  });
});
