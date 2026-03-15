// tests/auth.test.js
// Tests for Firebase auth middleware (src/auth.js)

// Mock firebase-admin BEFORE requiring auth.js
const mockVerifyIdToken = jest.fn();

jest.mock('firebase-admin', () => {
  const mockAuth = { verifyIdToken: mockVerifyIdToken };
  const mockFirestore = {};
  const app = { auth: () => mockAuth, firestore: () => mockFirestore };
  return {
    apps: [app],  // non-empty so initFirebase() skips initialization
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

const { checkJwt, getBearerToken } = require('../src/auth');

// Helper to build mock req/res/next
function mockReqResNext(headers = {}) {
  const req = {
    headers,
    url: '/test',
    method: 'GET',
  };
  const res = {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
  };
  const next = jest.fn();
  return { req, res, next };
}

describe('getBearerToken', () => {
  test('extracts token from valid Authorization header', () => {
    const req = { headers: { authorization: 'Bearer abc123token' } };
    expect(getBearerToken(req)).toBe('abc123token');
  });

  test('returns null when no Authorization header', () => {
    const req = { headers: {} };
    expect(getBearerToken(req)).toBeNull();
  });

  test('returns null for non-Bearer auth type', () => {
    const req = { headers: { authorization: 'Basic abc123' } };
    expect(getBearerToken(req)).toBeNull();
  });

  test('returns null when Bearer keyword present but no token', () => {
    const req = { headers: { authorization: 'Bearer' } };
    // split('Bearer ') yields ['Bearer'] — token is undefined
    expect(getBearerToken(req)).toBeNull();
  });
});

describe('checkJwt', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('returns 401 when no token provided', async () => {
    const { req, res, next } = mockReqResNext({});

    await checkJwt(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: 'Missing Bearer token' });
    expect(next).not.toHaveBeenCalled();
  });

  test('verifies valid Firebase token and sets req.auth with uid, email, name', async () => {
    const decodedToken = {
      uid: 'firebase-uid-123',
      email: 'user@example.com',
      name: 'Test User',
      picture: 'https://example.com/photo.jpg',
      email_verified: true,
    };
    mockVerifyIdToken.mockResolvedValue(decodedToken);

    const { req, res, next } = mockReqResNext({
      authorization: 'Bearer valid-firebase-token',
    });

    await checkJwt(req, res, next);

    expect(mockVerifyIdToken).toHaveBeenCalledWith('valid-firebase-token');
    expect(next).toHaveBeenCalled();
    expect(req.auth).toEqual({
      uid: 'firebase-uid-123',
      email: 'user@example.com',
      name: 'Test User',
      picture: 'https://example.com/photo.jpg',
      email_verified: true,
      sign_in_provider: 'password',
    });
    expect(req.token).toBe('valid-firebase-token');
  });

  test('sets null for missing optional fields (email, name, picture)', async () => {
    const decodedToken = {
      uid: 'uid-minimal',
      // no email, name, picture, email_verified
    };
    mockVerifyIdToken.mockResolvedValue(decodedToken);

    const { req, res, next } = mockReqResNext({
      authorization: 'Bearer minimal-token',
    });

    await checkJwt(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(req.auth).toEqual({
      uid: 'uid-minimal',
      email: null,
      name: null,
      picture: null,
      email_verified: false,
      sign_in_provider: 'password',
    });
  });

  test('returns 401 when token is invalid/expired', async () => {
    mockVerifyIdToken.mockRejectedValue(
      new Error('Firebase ID token has expired')
    );

    const { req, res, next } = mockReqResNext({
      authorization: 'Bearer expired-token',
    });

    await checkJwt(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: 'Invalid or expired token' });
    expect(next).not.toHaveBeenCalled();
  });

  test('returns 401 when verifyIdToken throws auth/argument-error', async () => {
    const err = new Error('Decoding Firebase ID token failed');
    err.code = 'auth/argument-error';
    mockVerifyIdToken.mockRejectedValue(err);

    const { req, res, next } = mockReqResNext({
      authorization: 'Bearer malformed-token',
    });

    await checkJwt(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });
});
