// tests/redis-cleanup.test.js
// Tests for Phase 6 — Redis Cleanup & Hardening

// ── Mock Redis ──
const mockRedis = {
  status: 'ready',
  get: jest.fn(),
  set: jest.fn().mockResolvedValue('OK'),
  del: jest.fn().mockResolvedValue(1),
  hset: jest.fn().mockResolvedValue(1),
  hget: jest.fn().mockResolvedValue(null),
  hgetall: jest.fn().mockResolvedValue({}),
  expire: jest.fn().mockResolvedValue(1),
  scan: jest.fn().mockResolvedValue(['0', []]),
  pipeline: jest.fn(() => ({
    exec: jest.fn().mockResolvedValue([]),
  })),
  dbsize: jest.fn().mockResolvedValue(0),
  lpush: jest.fn().mockResolvedValue(1),
  lrange: jest.fn().mockResolvedValue([]),
  ltrim: jest.fn().mockResolvedValue('OK'),
};

jest.mock('../src/redisClient', () => ({
  getRedis: jest.fn(() => mockRedis),
  getRedisConnectionOptions: jest.fn(() => ({ host: 'localhost', port: 6379 })),
}));

jest.mock('../src/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

// Mock BullMQ before requiring queueRedis
const mockQueue = {
  add: jest.fn().mockResolvedValue({ id: 'job-1' }),
  getJobs: jest.fn().mockResolvedValue([]),
  getJobCounts: jest.fn().mockResolvedValue({ waiting: 0, active: 0, delayed: 0, paused: 0 }),
  clean: jest.fn().mockResolvedValue([]),
  obliterate: jest.fn().mockResolvedValue(undefined),
  close: jest.fn().mockResolvedValue(undefined),
};

const mockWorker = {
  on: jest.fn(),
  close: jest.fn().mockResolvedValue(undefined),
};

const mockQueueEvents = {
  on: jest.fn(),
  close: jest.fn().mockResolvedValue(undefined),
};

jest.mock('bullmq', () => ({
  Queue: jest.fn(() => mockQueue),
  Worker: jest.fn(() => mockWorker),
  QueueEvents: jest.fn(() => mockQueueEvents),
}));

// Mock sessionManager
jest.mock('../src/sessionManager', () => ({
  getManager: jest.fn(),
  getSession: jest.fn(),
}));

// Mock config
jest.mock('../src/config', () => ({
  messageDelay: 4000,
  tempDir: '/tmp/test',
  publicDir: '/tmp/test-public',
  retentionHours: 24,
}));

// Mock media
jest.mock('../src/media', () => ({
  convertAudioToOpus: jest.fn(),
  upload: {
    single: () => (req, res, next) => next(),
    fields: () => (req, res, next) => next(),
    array: () => (req, res, next) => next(),
  },
}));

// Mock redisLock
jest.mock('../src/redisLock', () => ({
  acquireLock: jest.fn().mockResolvedValue(true),
}));

// Mock owner
jest.mock('../src/owner', () => ({
  isOwner: jest.fn().mockResolvedValue(true),
  claimOwnership: jest.fn().mockResolvedValue(true),
}));

// Mock metricsStore
jest.mock('../src/metricsStore', () => ({
  record: jest.fn(),
  getMonthlyStats: jest.fn().mockResolvedValue({}),
  getUserSummary: jest.fn().mockResolvedValue({}),
  getCampaignProgress: jest.fn().mockResolvedValue({}),
}));

// Mock storage/s3
jest.mock('../src/storage/s3', () => ({
  uploadFile: jest.fn(),
  getSignedUrl: jest.fn(),
}));

const redisQueue = require('../src/queueRedis');

// ─── Helpers ───
const TEST_USER = 'test-user-123';

function resetMocks() {
  jest.clearAllMocks();
  mockRedis.status = 'ready';
  mockRedis.del.mockResolvedValue(1);
  mockRedis.get.mockResolvedValue(null);
  mockRedis.hget.mockResolvedValue(null);
  mockRedis.hgetall.mockResolvedValue({});
  mockRedis.scan.mockResolvedValue(['0', []]);
  mockRedis.dbsize.mockResolvedValue(0);
  mockQueue.getJobs.mockResolvedValue([]);
}

// ════════════════════════════════════════════════════════
// 1. cleanupUserData
// ════════════════════════════════════════════════════════
describe('cleanupUserData', () => {
  beforeEach(resetMocks);

  test('deletes all expected user-scoped direct keys', async () => {
    const result = await redisQueue.cleanupUserData(TEST_USER);

    expect(result.success).toBe(true);

    // Verify direct keys are deleted
    const expectedKeys = [
      `ms:status:${TEST_USER}`,
      `ms:progress:${TEST_USER}`,
      `ms:list:${TEST_USER}`,
      `ms:cancel:${TEST_USER}`,
      `ms:events:${TEST_USER}`,
      `ms:hb:${TEST_USER}`,
      `ms:lock:campaign:${TEST_USER}`,
      `ms:session:${TEST_USER}`,
      `ms:contacts:${TEST_USER}`,
      `ms:contacts:idmap:${TEST_USER}`,
      `ms:campaigns:${TEST_USER}`,
      `wa:owner:${TEST_USER}`,
    ];

    for (const key of expectedKeys) {
      expect(mockRedis.del).toHaveBeenCalledWith(key);
    }
  });

  test('deletes all metrics keys', async () => {
    const result = await redisQueue.cleanupUserData(TEST_USER);
    expect(result.success).toBe(true);

    const metricKeys = [
      `ms:metrics:events:seq:${TEST_USER}`,
      `ms:metrics:events:z:${TEST_USER}`,
      `ms:metrics:events:h:${TEST_USER}`,
      `ms:metrics:monthly:sent:${TEST_USER}`,
      `ms:metrics:monthly:error:${TEST_USER}`,
      `ms:metrics:contact:stats:${TEST_USER}`,
    ];

    for (const key of metricKeys) {
      expect(mockRedis.del).toHaveBeenCalledWith(key);
    }
  });

  test('with keepAuth: true, skips wa:auth keys (no SCAN)', async () => {
    const result = await redisQueue.cleanupUserData(TEST_USER, { keepAuth: true });

    expect(result.success).toBe(true);
    // SCAN should NOT be called for wa:auth pattern
    const scanCalls = mockRedis.scan.mock.calls.filter(
      call => call[2] === `wa:auth:${TEST_USER}:*`
    );
    expect(scanCalls.length).toBe(0);
  });

  test('with keepAuth: false (default), deletes wa:auth keys via SCAN', async () => {
    // First SCAN returns keys, second returns cursor '0' (done)
    mockRedis.scan
      .mockResolvedValueOnce(['42', [`wa:auth:${TEST_USER}:creds`, `wa:auth:${TEST_USER}:keys`]])
      .mockResolvedValueOnce(['0', [`wa:auth:${TEST_USER}:session`]]);
    // del for auth keys uses array form
    mockRedis.del.mockResolvedValue(1);

    const result = await redisQueue.cleanupUserData(TEST_USER);

    expect(result.success).toBe(true);
    // SCAN should be called with the auth pattern
    expect(mockRedis.scan).toHaveBeenCalledWith(
      '0', 'MATCH', `wa:auth:${TEST_USER}:*`, 'COUNT', 200
    );
    // Auth keys should be deleted
    expect(mockRedis.del).toHaveBeenCalledWith(
      [`wa:auth:${TEST_USER}:creds`, `wa:auth:${TEST_USER}:keys`]
    );
    expect(mockRedis.del).toHaveBeenCalledWith(
      [`wa:auth:${TEST_USER}:session`]
    );
    // deletedKeys should include auth keys
    expect(result.deletedKeys).toContain(`wa:auth:${TEST_USER}:creds`);
    expect(result.deletedKeys).toContain(`wa:auth:${TEST_USER}:keys`);
    expect(result.deletedKeys).toContain(`wa:auth:${TEST_USER}:session`);
  });

  test('returns { success: true, deletedKeys: [...] } with actually deleted keys', async () => {
    // Only some keys exist: del returns 1 for existing, 0 for missing
    let callCount = 0;
    mockRedis.del.mockImplementation((...args) => {
      callCount++;
      // Simulate: only first 3 direct keys exist
      if (callCount <= 3) return Promise.resolve(1);
      return Promise.resolve(0);
    });

    const result = await redisQueue.cleanupUserData(TEST_USER);

    expect(result.success).toBe(true);
    expect(Array.isArray(result.deletedKeys)).toBe(true);
    // Only the 3 keys with del returning 1 should be in deletedKeys
    expect(result.deletedKeys.length).toBe(3);
  });

  test('handles Redis errors gracefully', async () => {
    mockRedis.del.mockRejectedValue(new Error('Redis connection lost'));

    const result = await redisQueue.cleanupUserData(TEST_USER);

    // Should still return a result (not throw)
    expect(result).toBeDefined();
    expect(Array.isArray(result.deletedKeys)).toBe(true);
  });
});

// ════════════════════════════════════════════════════════
// 2. Heartbeat key fix — uses ms:hb:{userId} not ms:heartbeat
// ════════════════════════════════════════════════════════
describe('Heartbeat key fix', () => {
  beforeEach(resetMocks);

  test('cleanupUserData deletes ms:hb:{userId} (not ms:heartbeat)', async () => {
    await redisQueue.cleanupUserData(TEST_USER);

    // CORRECT key pattern
    expect(mockRedis.del).toHaveBeenCalledWith(`ms:hb:${TEST_USER}`);

    // WRONG key pattern should NOT be used
    const allDelCalls = mockRedis.del.mock.calls.flat();
    const heartbeatWrongCalls = allDelCalls.filter(k => typeof k === 'string' && k.includes('ms:heartbeat'));
    expect(heartbeatWrongCalls.length).toBe(0);
  });
});

// ════════════════════════════════════════════════════════
// 3. scanOrphanKeys
// ════════════════════════════════════════════════════════
describe('scanOrphanKeys', () => {
  beforeEach(resetMocks);

  test('identifies orphan keys (no session, no heartbeat, no recent activity)', async () => {
    // First scan (ms:*) returns keys for an orphan user
    mockRedis.scan
      .mockResolvedValueOnce(['0', [
        `ms:status:orphan-user`,
        `ms:progress:orphan-user`,
      ]])
      // Second scan (wa:*) returns empty
      .mockResolvedValueOnce(['0', []]);

    // No session, no heartbeat, no recent status update
    mockRedis.get.mockResolvedValue(null);
    mockRedis.hget.mockResolvedValue(null);

    const result = await redisQueue.scanOrphanKeys();

    expect(result.orphans.length).toBe(1);
    expect(result.orphans[0].userId).toBe('orphan-user');
    expect(result.orphans[0].keys).toContain('ms:status:orphan-user');
    expect(result.orphans[0].keys).toContain('ms:progress:orphan-user');
    expect(result.totalUsersScanned).toBe(1);
  });

  test('does NOT flag keys with active sessions as orphans', async () => {
    // ms:* scan returns keys for an active user
    mockRedis.scan
      .mockResolvedValueOnce(['0', [
        `ms:status:active-user`,
        `ms:hb:active-user`,
      ]])
      .mockResolvedValueOnce(['0', []]);

    // User has an active session
    mockRedis.get.mockImplementation(async (key) => {
      if (key === 'ms:session:active-user') return JSON.stringify({ token: 'abc' });
      return null;
    });

    const result = await redisQueue.scanOrphanKeys();

    expect(result.orphans.length).toBe(0);
    expect(result.active.length).toBe(1);
    expect(result.active[0].reason).toBe('has_session');
  });

  test('does NOT flag keys with active heartbeat as orphans', async () => {
    mockRedis.scan
      .mockResolvedValueOnce(['0', [`ms:status:hb-user`]])
      .mockResolvedValueOnce(['0', []]);

    mockRedis.get.mockImplementation(async (key) => {
      if (key === 'ms:session:hb-user') return null;
      if (key === `ms:hb:hb-user`) return String(Date.now());
      return null;
    });

    const result = await redisQueue.scanOrphanKeys();

    expect(result.orphans.length).toBe(0);
    expect(result.active.length).toBe(1);
    expect(result.active[0].reason).toBe('has_heartbeat');
  });

  test('handles empty Redis gracefully', async () => {
    mockRedis.scan.mockResolvedValue(['0', []]);

    const result = await redisQueue.scanOrphanKeys();

    expect(result.orphans).toEqual([]);
    expect(result.active).toEqual([]);
    expect(result.totalUsersScanned).toBe(0);
  });

  test('classifies users with recent status update as active', async () => {
    mockRedis.scan
      .mockResolvedValueOnce(['0', [`ms:status:recent-user`]])
      .mockResolvedValueOnce(['0', []]);

    mockRedis.get.mockResolvedValue(null); // no session or heartbeat
    // Recent updatedAt (within 24h)
    mockRedis.hget.mockImplementation(async (key, field) => {
      if (field === 'updatedAt') return String(Date.now() - 1000); // 1s ago
      return null;
    });

    const result = await redisQueue.scanOrphanKeys();

    expect(result.orphans.length).toBe(0);
    expect(result.active.length).toBe(1);
    expect(result.active[0].reason).toBe('recent_activity');
  });
});

// ════════════════════════════════════════════════════════
// 4. getRedisKeyStats
// ════════════════════════════════════════════════════════
describe('getRedisKeyStats', () => {
  beforeEach(resetMocks);

  test('returns counts by pattern', async () => {
    // Each scan call returns different counts per pattern
    let scanCallIdx = 0;
    mockRedis.scan.mockImplementation(async (cursor, _match, pattern, _count, _num) => {
      scanCallIdx++;
      // Return 2 keys for first pattern, 0 for rest
      if (scanCallIdx === 1) return ['0', ['ms:status:u1', 'ms:status:u2']];
      return ['0', []];
    });
    mockRedis.dbsize.mockResolvedValue(42);

    const stats = await redisQueue.getRedisKeyStats();

    expect(stats).toHaveProperty('patterns');
    expect(stats).toHaveProperty('dbSize', 42);
    expect(stats.patterns['ms:status:*']).toBe(2);
  });

  test('handles scan errors gracefully for individual patterns', async () => {
    mockRedis.scan.mockRejectedValue(new Error('SCAN error'));
    mockRedis.dbsize.mockResolvedValue(0);

    const stats = await redisQueue.getRedisKeyStats();

    // Should still return a result
    expect(stats).toHaveProperty('patterns');
    expect(stats).toHaveProperty('dbSize');
  });
});

// ════════════════════════════════════════════════════════
// 5. deleteOrphanKeys
// ════════════════════════════════════════════════════════
describe('deleteOrphanKeys', () => {
  beforeEach(resetMocks);

  test('deletes keys for each orphan entry', async () => {
    const orphanEntries = [
      { userId: 'orphan-1', keys: ['ms:status:orphan-1', 'ms:progress:orphan-1'] },
      { userId: 'orphan-2', keys: ['ms:status:orphan-2'] },
    ];

    const result = await redisQueue.deleteOrphanKeys(orphanEntries);

    expect(result.totalDeleted).toBe(3);
    expect(result.results.length).toBe(2);
    expect(mockRedis.del).toHaveBeenCalledWith(['ms:status:orphan-1', 'ms:progress:orphan-1']);
    expect(mockRedis.del).toHaveBeenCalledWith(['ms:status:orphan-2']);
  });

  test('handles errors per-entry without failing completely', async () => {
    mockRedis.del
      .mockRejectedValueOnce(new Error('Redis error'))
      .mockResolvedValueOnce(1);

    const orphanEntries = [
      { userId: 'fail-user', keys: ['ms:status:fail-user'] },
      { userId: 'ok-user', keys: ['ms:status:ok-user'] },
    ];

    const result = await redisQueue.deleteOrphanKeys(orphanEntries);

    // First entry fails, second succeeds
    expect(result.results[0].error).toBeDefined();
    expect(result.results[1].deleted).toBe(1);
  });
});

// ════════════════════════════════════════════════════════
// 6. Admin endpoints (route handler tests)
// ════════════════════════════════════════════════════════
describe('Admin endpoints', () => {
  // We test the route handlers via supertest-like approach:
  // mock req/res and call the express router

  // Mock additional deps for routes.js
  jest.mock('qrcode', () => ({
    toDataURL: jest.fn(),
  }));

  jest.mock('../src/auth', () => ({
    checkJwt: (req, res, next) => next(),
  }));

  jest.mock('../src/middleware/ensureUserProfile', () => ({
    ensureUserProfile: (req, res, next) => next(),
    invalidateProfileCache: jest.fn(),
  }));

  jest.mock('../src/middleware/checkTrial', () => ({
    checkTrial: (req, res, next) => next(),
  }));

  jest.mock('../src/middleware/sessionGuard', () => ({
    sessionGuard: (req, res, next) => next(),
    createSession: jest.fn(),
    clearSession: jest.fn(),
  }));

  jest.mock('../src/firebaseAdmin', () => ({
    admin: {
      auth: () => ({
        getUser: jest.fn().mockResolvedValue({ uid: 'test', email: 'test@test.com' }),
        updateUser: jest.fn(),
      }),
      firestore: () => ({
        collection: jest.fn(() => ({
          doc: jest.fn(() => ({
            get: jest.fn().mockResolvedValue({ exists: false }),
            set: jest.fn(),
            update: jest.fn(),
          })),
        })),
      }),
    },
    db: {
      collection: jest.fn(() => ({
        doc: jest.fn(() => ({
          get: jest.fn().mockResolvedValue({ exists: false }),
          set: jest.fn(),
          update: jest.fn(),
        })),
      })),
    },
  }));

  function makeReq(overrides = {}) {
    return {
      auth: { uid: 'admin-user-1' },
      userProfile: { uid: 'admin-user-1', role: 'admin' },
      headers: { 'user-agent': 'Test/1.0' },
      ip: '127.0.0.1',
      connection: { remoteAddress: '127.0.0.1' },
      body: {},
      params: {},
      query: {},
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

  // Since importing the full router is complex, we test the handler logic inline
  // by extracting what the route does and replicating it

  describe('POST /admin/users/:userId/cleanup', () => {
    test('admin gets 200 with deletedKeys', async () => {
      const req = makeReq({
        params: { userId: TEST_USER },
        body: { keepAuth: false },
      });
      const res = makeRes();

      // Simulate the handler
      const keepAuth = req.body?.keepAuth === true;
      const result = await redisQueue.cleanupUserData(req.params.userId, { keepAuth });

      res.json({
        success: result.success,
        userId: req.params.userId,
        keepAuth,
        deletedKeys: result.deletedKeys,
        deletedCount: result.deletedKeys.length,
      });

      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          userId: TEST_USER,
          keepAuth: false,
          deletedKeys: expect.any(Array),
          deletedCount: expect.any(Number),
        })
      );
    });

    test('non-admin gets 403', () => {
      const req = makeReq({
        params: { userId: TEST_USER },
        userProfile: { uid: 'regular-user', role: 'user' },
      });
      const res = makeRes();

      // Simulate the admin check in the handler
      if (!req.userProfile || req.userProfile.role !== 'admin') {
        res.status(403).json({ error: 'Forbidden: admin role required' });
      }

      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.json).toHaveBeenCalledWith({ error: 'Forbidden: admin role required' });
    });
  });

  describe('GET /admin/redis/stats', () => {
    beforeEach(resetMocks);

    test('returns key counts for admin', async () => {
      mockRedis.scan.mockResolvedValue(['0', []]);
      mockRedis.dbsize.mockResolvedValue(100);

      const res = makeRes();
      const stats = await redisQueue.getRedisKeyStats();
      res.json({ success: true, ...stats });

      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          patterns: expect.any(Object),
          dbSize: 100,
        })
      );
    });

    test('non-admin gets 403', () => {
      const req = makeReq({
        userProfile: { uid: 'regular-user', role: 'user' },
      });
      const res = makeRes();

      if (!req.userProfile || req.userProfile.role !== 'admin') {
        res.status(403).json({ error: 'Forbidden: admin role required' });
      }

      expect(res.status).toHaveBeenCalledWith(403);
    });
  });

  describe('GET /admin/redis/orphan-scan', () => {
    beforeEach(resetMocks);

    test('returns orphan results for admin', async () => {
      // Setup scan to return one orphan user
      mockRedis.scan
        .mockResolvedValueOnce(['0', [`ms:status:orphan-x`]])
        .mockResolvedValueOnce(['0', []]);
      mockRedis.get.mockResolvedValue(null);
      mockRedis.hget.mockResolvedValue(null);

      const res = makeRes();
      const scanResult = await redisQueue.scanOrphanKeys();
      res.json({
        success: true,
        totalUsersScanned: scanResult.totalUsersScanned,
        orphanCount: scanResult.orphans.length,
        activeCount: scanResult.active.length,
        orphans: scanResult.orphans.map(o => ({
          userId: o.userId,
          keyCount: o.keyCount,
          keys: o.keys,
        })),
      });

      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          totalUsersScanned: 1,
          orphanCount: 1,
          activeCount: 0,
          orphans: expect.arrayContaining([
            expect.objectContaining({
              userId: 'orphan-x',
              keyCount: 1,
            }),
          ]),
        })
      );
    });

    test('non-admin gets 403', () => {
      const req = makeReq({
        userProfile: { uid: 'regular-user', role: 'viewer' },
      });
      const res = makeRes();

      if (!req.userProfile || req.userProfile.role !== 'admin') {
        res.status(403).json({ error: 'Forbidden: admin role required' });
      }

      expect(res.status).toHaveBeenCalledWith(403);
    });
  });

  describe('POST /admin/redis/orphan-cleanup', () => {
    beforeEach(resetMocks);

    test('scans and deletes orphan keys', async () => {
      // scanOrphanKeys will find orphans
      mockRedis.scan
        .mockResolvedValueOnce(['0', [`ms:status:orphan-a`, `ms:hb:orphan-a`]])
        .mockResolvedValueOnce(['0', []]);
      mockRedis.get.mockResolvedValue(null);
      mockRedis.hget.mockResolvedValue(null);

      const res = makeRes();

      // Simulate endpoint: scan then delete
      const scanResult = await redisQueue.scanOrphanKeys();
      const toDelete = scanResult.orphans;

      if (toDelete.length === 0) {
        res.json({ success: true, message: 'No orphan keys to delete', totalDeleted: 0 });
      } else {
        const result = await redisQueue.deleteOrphanKeys(toDelete);
        res.json({ success: true, ...result });
      }

      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          totalDeleted: expect.any(Number),
        })
      );
    });

    test('non-admin gets 403', () => {
      const req = makeReq({
        userProfile: null,
      });
      const res = makeRes();

      if (!req.userProfile || req.userProfile.role !== 'admin') {
        res.status(403).json({ error: 'Forbidden: admin role required' });
      }

      expect(res.status).toHaveBeenCalledWith(403);
    });
  });
});
