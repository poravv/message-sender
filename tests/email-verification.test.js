// tests/email-verification.test.js
// Tests for ensureEmailVerified middleware

jest.mock('../src/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

const { ensureEmailVerified } = require('../src/middleware/ensureEmailVerified');

function mockReqResNext(authOverrides) {
  const req = { auth: authOverrides || null };
  const res = {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
  };
  const next = jest.fn();
  return { req, res, next };
}

describe('ensureEmailVerified middleware', () => {
  test('passes Google users through without checking email_verified', () => {
    const { req, res, next } = mockReqResNext({
      uid: 'google-user-1',
      email: 'user@gmail.com',
      email_verified: false, // even if false, Google users pass
      sign_in_provider: 'google.com',
    });

    ensureEmailVerified(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  test('blocks unverified email/password users with 403', () => {
    const { req, res, next } = mockReqResNext({
      uid: 'email-user-1',
      email: 'user@example.com',
      email_verified: false,
      sign_in_provider: 'password',
    });

    ensureEmailVerified(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: 'email_not_verified' })
    );
  });

  test('passes verified email/password users through', () => {
    const { req, res, next } = mockReqResNext({
      uid: 'email-user-2',
      email: 'verified@example.com',
      email_verified: true,
      sign_in_provider: 'password',
    });

    ensureEmailVerified(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  test('returns 401 when req.auth is missing', () => {
    const { req, res, next } = mockReqResNext(null);
    req.auth = undefined;

    ensureEmailVerified(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
  });

  test('defaults sign_in_provider to password when not set', () => {
    const { req, res, next } = mockReqResNext({
      uid: 'user-no-provider',
      email: 'test@example.com',
      email_verified: false,
      // sign_in_provider not set
    });

    ensureEmailVerified(req, res, next);

    // Should block because defaults to password and email not verified
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });
});
