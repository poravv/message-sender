// tests/routes-auth.test.js
// Tests for auth field usage in routes (req.auth.uid, not req.auth.sub)

const fs = require('fs');
const path = require('path');

// Mock all heavy dependencies so requiring routes.js doesn't fail
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

describe('conditionalAuth dev mode', () => {
  const originalNodeEnv = process.env.NODE_ENV;

  afterAll(() => {
    process.env.NODE_ENV = originalNodeEnv;
  });

  test('injects mock user with uid (not sub) in development mode', () => {
    process.env.NODE_ENV = 'development';

    // Re-require to pick up the env change
    jest.resetModules();

    // Re-apply mocks after resetModules
    jest.doMock('firebase-admin', () => {
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
    jest.doMock('../src/logger', () => ({
      info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
    }));
    jest.doMock('../src/auth/index', () => ({ getAuthState: jest.fn() }));
    jest.doMock('../src/media', () => ({
      upload: {
        single: () => (req, res, next) => next(),
        fields: () => (req, res, next) => next(),
        array: () => (req, res, next) => next(),
      },
    }));
    jest.doMock('qrcode', () => ({ toDataURL: jest.fn() }));
    jest.doMock('../src/queueRedis', () => ({
      addMessage: jest.fn(), addBulkMessages: jest.fn(),
      getQueueStats: jest.fn().mockResolvedValue({}),
    }));
    jest.doMock('../src/metricsStore', () => ({
      record: jest.fn(), getMonthlyStats: jest.fn().mockResolvedValue({}),
      getUserSummary: jest.fn().mockResolvedValue({}),
      getCampaignProgress: jest.fn().mockResolvedValue({}),
    }));
    jest.doMock('../src/sessionManager', () => ({
      getSessionByToken: jest.fn(),
    }));
    jest.doMock('../src/config', () => ({
      publicDir: '/tmp/test-public', retentionHours: 24,
    }));

    // We need to extract the conditionalAuth behavior from routes.js
    // Since it's not exported, we test it through the router middleware stack
    const { buildRoutes } = require('../src/routes');
    const router = buildRoutes();

    // Find a route that uses conditionalAuth (e.g., GET /connection-status)
    const layer = router.stack.find(
      (l) => l.route && l.route.path === '/connection-status'
    );

    expect(layer).toBeDefined();

    // The first middleware in the route stack should be conditionalAuth
    const conditionalAuthMiddleware = layer.route.stack[0].handle;

    const req = { headers: {}, url: '/connection-status', method: 'GET' };
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    const next = jest.fn();

    conditionalAuthMiddleware(req, res, next);

    // Should have called next (not returned 401)
    expect(next).toHaveBeenCalled();

    // Should set req.auth with uid field
    expect(req.auth).toBeDefined();
    expect(req.auth.uid).toBe('dev-user-001');
    expect(req.auth.email).toBe('dev@test.com');
    expect(req.auth.name).toBe('Usuario Desarrollo');

    // Should NOT have 'sub' property
    expect(req.auth.sub).toBeUndefined();
  });
});

describe('routes.js has no req.auth.sub references', () => {
  test('no occurrences of req.auth.sub in routes.js source', () => {
    const routesPath = path.resolve(__dirname, '../src/routes.js');
    const source = fs.readFileSync(routesPath, 'utf8');

    // Search for req.auth.sub (with optional chaining too)
    const subRefs = source.match(/req\.auth\??\.(sub)\b/g);
    expect(subRefs).toBeNull();
  });

  test('routes.js uses req.auth.uid consistently', () => {
    const routesPath = path.resolve(__dirname, '../src/routes.js');
    const source = fs.readFileSync(routesPath, 'utf8');

    // Should have multiple references to req.auth.uid or req.auth?.uid
    const uidRefs = source.match(/req\.auth\??\.uid\b/g);
    expect(uidRefs).not.toBeNull();
    expect(uidRefs.length).toBeGreaterThan(5);
  });
});
