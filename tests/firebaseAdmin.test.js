// tests/firebaseAdmin.test.js
// Tests for Firebase Admin SDK initialization (src/firebaseAdmin.js)

// We need to test initFirebase under different env var scenarios.
// Each test resets modules so the top-level initFirebase() re-runs.

const mockInitializeApp = jest.fn();
const mockCert = jest.fn().mockReturnValue('cert-credential');
const mockApplicationDefault = jest.fn().mockReturnValue('app-default-credential');
const mockAuth = { verifyIdToken: jest.fn() };
const mockFirestore = {};

jest.mock('../src/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

// Save original env
const originalEnv = { ...process.env };

beforeEach(() => {
  jest.resetModules();
  jest.clearAllMocks();
  // Clean env vars
  delete process.env.FIREBASE_SERVICE_ACCOUNT;
  delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
});

afterAll(() => {
  process.env = originalEnv;
});

function setupFirebaseMock({ appsLength = 0 } = {}) {
  const apps = Array(appsLength).fill({});
  jest.doMock('firebase-admin', () => ({
    apps,
    initializeApp: mockInitializeApp,
    credential: { cert: mockCert, applicationDefault: mockApplicationDefault },
    auth: () => mockAuth,
    firestore: () => mockFirestore,
  }));
}

describe('firebaseAdmin initialization', () => {
  test('initializes with FIREBASE_SERVICE_ACCOUNT base64 env var', () => {
    const serviceAccount = { project_id: 'test-project', client_email: 'test@test.iam.gserviceaccount.com', private_key: 'pk' };
    const base64 = Buffer.from(JSON.stringify(serviceAccount)).toString('base64');
    process.env.FIREBASE_SERVICE_ACCOUNT = base64;

    setupFirebaseMock({ appsLength: 0 });
    const { admin, db, auth } = require('../src/firebaseAdmin');

    expect(mockInitializeApp).toHaveBeenCalledTimes(1);
    expect(mockCert).toHaveBeenCalledWith(serviceAccount);
    expect(mockInitializeApp).toHaveBeenCalledWith({
      credential: 'cert-credential',
    });
    // Exports should be defined
    expect(auth).toBeDefined();
    expect(db).toBeDefined();
    expect(admin).toBeDefined();
  });

  test('initializes with GOOGLE_APPLICATION_CREDENTIALS env var', () => {
    process.env.GOOGLE_APPLICATION_CREDENTIALS = '/path/to/credentials.json';

    setupFirebaseMock({ appsLength: 0 });
    const { admin, db, auth } = require('../src/firebaseAdmin');

    expect(mockInitializeApp).toHaveBeenCalledTimes(1);
    expect(mockApplicationDefault).toHaveBeenCalled();
    expect(mockInitializeApp).toHaveBeenCalledWith({
      credential: 'app-default-credential',
    });
    expect(auth).toBeDefined();
    expect(db).toBeDefined();
  });

  test('skips Firebase in non-production when no env vars set', () => {
    setupFirebaseMock({ appsLength: 0 });
    const { db, auth, firebaseAvailable } = require('../src/firebaseAdmin');

    // In non-production without credentials, Firebase is skipped
    expect(mockInitializeApp).not.toHaveBeenCalled();
    expect(db).toBeNull();
    expect(auth).toBeNull();
    expect(firebaseAvailable).toBe(false);
  });

  test('falls back to default credentials in production when no env vars set', () => {
    process.env.NODE_ENV = 'production';
    setupFirebaseMock({ appsLength: 0 });
    const { admin } = require('../src/firebaseAdmin');

    expect(mockInitializeApp).toHaveBeenCalledTimes(1);
    expect(mockInitializeApp).toHaveBeenCalledWith();
    expect(mockCert).not.toHaveBeenCalled();
    expect(mockApplicationDefault).not.toHaveBeenCalled();
    delete process.env.NODE_ENV;
  });

  test('skips initialization when app already exists', () => {
    setupFirebaseMock({ appsLength: 1 }); // already initialized
    require('../src/firebaseAdmin');

    expect(mockInitializeApp).not.toHaveBeenCalled();
  });

  test('does not throw in dev when FIREBASE_SERVICE_ACCOUNT is invalid base64/JSON', () => {
    process.env.FIREBASE_SERVICE_ACCOUNT = 'not-valid-base64-json!!!';

    setupFirebaseMock({ appsLength: 0 });
    // In non-production, bad credentials are handled gracefully
    const { db, auth, firebaseAvailable } = require('../src/firebaseAdmin');
    expect(db).toBeNull();
    expect(auth).toBeNull();
    expect(firebaseAvailable).toBe(false);
  });

  test('throws in production when FIREBASE_SERVICE_ACCOUNT is invalid base64/JSON', () => {
    process.env.NODE_ENV = 'production';
    process.env.FIREBASE_SERVICE_ACCOUNT = 'not-valid-base64-json!!!';

    setupFirebaseMock({ appsLength: 0 });
    expect(() => require('../src/firebaseAdmin')).toThrow();
    delete process.env.NODE_ENV;
  });

  test('exports admin, db, auth, and firebaseAvailable', () => {
    setupFirebaseMock({ appsLength: 0 });
    const exports = require('../src/firebaseAdmin');

    expect(exports).toHaveProperty('admin');
    expect(exports).toHaveProperty('db');
    expect(exports).toHaveProperty('auth');
    expect(exports).toHaveProperty('firebaseAvailable');
  });
});
