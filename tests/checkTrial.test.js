// tests/checkTrial.test.js
// Tests for checkTrial middleware (src/middleware/checkTrial.js)

const mockUpdate = jest.fn();
const mockDoc = jest.fn(() => ({ update: mockUpdate }));
const mockCollection = jest.fn(() => ({ doc: mockDoc }));

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

const { checkTrial } = require('../src/middleware/checkTrial');

function makeRes() {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('checkTrial middleware', () => {
  test('admin users always pass through regardless of plan', async () => {
    const req = {
      auth: { uid: 'admin-1' },
      userProfile: { uid: 'admin-1', role: 'admin', plan: 'expired' },
    };
    const res = makeRes();
    const next = jest.fn();

    await checkTrial(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  test('active plan users pass through', async () => {
    const req = {
      auth: { uid: 'user-1' },
      userProfile: { uid: 'user-1', role: 'user', plan: 'active' },
    };
    const res = makeRes();
    const next = jest.fn();

    await checkTrial(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  test('trial users with valid trial (future trialEndsAt) pass through', async () => {
    const futureDate = new Date(Date.now() + 10 * 24 * 60 * 60 * 1000); // 10 days ahead
    const req = {
      auth: { uid: 'user-2' },
      userProfile: { uid: 'user-2', role: 'user', plan: 'trial', trialEndsAt: futureDate },
    };
    const res = makeRes();
    const next = jest.fn();

    await checkTrial(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  test('trial users with expired trial get 403 trial_expired', async () => {
    const pastDate = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000); // 1 day ago
    mockUpdate.mockResolvedValueOnce(undefined);

    const req = {
      auth: { uid: 'user-3' },
      userProfile: { uid: 'user-3', role: 'user', plan: 'trial', trialEndsAt: pastDate },
    };
    const res = makeRes();
    const next = jest.fn();

    await checkTrial(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: 'trial_expired',
        message: 'Tu periodo de prueba ha expirado',
      })
    );
    // Should also update Firestore to mark plan as expired
    expect(mockUpdate).toHaveBeenCalledWith({ plan: 'expired' });
  });

  test('expired plan users get 403 account_inactive', async () => {
    const req = {
      auth: { uid: 'user-4' },
      userProfile: { uid: 'user-4', role: 'user', plan: 'expired' },
    };
    const res = makeRes();
    const next = jest.fn();

    await checkTrial(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({
      error: 'account_inactive',
      message: 'Tu cuenta esta inactiva',
    });
  });

  test('handles missing userProfile gracefully — calls next', async () => {
    const req = { auth: { uid: 'user-5' }, userProfile: undefined };
    const res = makeRes();
    const next = jest.fn();

    await checkTrial(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  test('handles null userProfile gracefully', async () => {
    const req = { auth: { uid: 'user-6' }, userProfile: null };
    const res = makeRes();
    const next = jest.fn();

    await checkTrial(req, res, next);

    expect(next).toHaveBeenCalled();
  });

  test('trial with Firestore Timestamp-like trialEndsAt (toDate method)', async () => {
    const futureDate = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000);
    const firestoreTimestamp = { toDate: () => futureDate };
    const req = {
      auth: { uid: 'user-7' },
      userProfile: { uid: 'user-7', role: 'user', plan: 'trial', trialEndsAt: firestoreTimestamp },
    };
    const res = makeRes();
    const next = jest.fn();

    await checkTrial(req, res, next);

    expect(next).toHaveBeenCalled();
  });

  test('trial with string trialEndsAt (ISO format)', async () => {
    const futureDate = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000);
    const req = {
      auth: { uid: 'user-8' },
      userProfile: { uid: 'user-8', role: 'user', plan: 'trial', trialEndsAt: futureDate.toISOString() },
    };
    const res = makeRes();
    const next = jest.fn();

    await checkTrial(req, res, next);

    expect(next).toHaveBeenCalled();
  });

  test('unknown plan type passes through with warning', async () => {
    const req = {
      auth: { uid: 'user-9' },
      userProfile: { uid: 'user-9', role: 'user', plan: 'premium' },
    };
    const res = makeRes();
    const next = jest.fn();

    await checkTrial(req, res, next);

    expect(next).toHaveBeenCalled();
  });
});
