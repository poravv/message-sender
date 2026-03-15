/**
 * @jest-environment jsdom
 * @jest-environment-options {"url": "http://localhost:3000/"}
 */

// tests/frontend-auth.test.js
// Tests for Phase 2: Frontend Firebase auth integration

const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Read an HTML file and load it into jsdom's document */
function loadHTML(relativePath) {
  const html = fs.readFileSync(
    path.join(__dirname, '..', relativePath),
    'utf-8'
  );
  document.documentElement.innerHTML = html;
}

/**
 * Load core.js functions into the global context.
 * We patch navigation and use indirect eval so that top-level `var`
 * declarations land on `window` (global scope) rather than being
 * trapped inside a Function() closure.
 */
function loadCoreJs() {
  let coreCode = fs.readFileSync(
    path.join(__dirname, '..', 'public', 'js', 'core.js'),
    'utf-8'
  );

  // Replace `window.location.href = X` with a trackable assignment
  // so jsdom doesn't throw "navigation not implemented"
  coreCode = coreCode.replace(
    /window\.location\.href\s*=\s*/g,
    'window.__lastNavigation = '
  );

  // Use indirect eval so top-level vars land in global/window scope,
  // matching how a <script> tag behaves in a real browser.
  // eslint-disable-next-line no-eval
  const indirectEval = eval;
  indirectEval(coreCode);
}

// ---------------------------------------------------------------------------
// SECTION 1: core.js — Firebase auth functions
// ---------------------------------------------------------------------------
describe('core.js Firebase auth functions', () => {
  let mockOnAuthStateChanged;
  let mockSignOut;
  let mockGetIdToken;
  let mockAuth;

  beforeEach(() => {
    jest.resetModules();
    jest.restoreAllMocks();
    // Suppress console.error / console.warn from core.js
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});

    // Clear navigation tracker
    window.__lastNavigation = undefined;

    // Clear any previous global state set by core.js
    delete window.currentUser;
    delete global.pollingInterval;
    delete global.authFetch;
    delete global.initFirebaseAuth;
    delete global.logout;
    delete global.showAlert;
    delete global.showTab;
    delete global.buildQuery;
    delete global.getChartTextColor;

    // Mock getIdToken
    mockGetIdToken = jest.fn().mockResolvedValue('mock-id-token-123');

    // Mock onAuthStateChanged — stores callback for manual triggering
    mockOnAuthStateChanged = jest.fn();

    // Mock signOut
    mockSignOut = jest.fn().mockResolvedValue(undefined);

    // Build mock firebase.auth()
    mockAuth = jest.fn(() => ({
      onAuthStateChanged: mockOnAuthStateChanged,
      signOut: mockSignOut,
    }));

    // Set up global firebase mock
    global.firebase = {
      initializeApp: jest.fn(),
      auth: mockAuth,
    };

    // Set up minimal DOM elements that core.js references
    document.body.innerHTML = `
      <div id="loading-screen"></div>
      <div id="alert-container"></div>
      <div id="user-info" class="d-none"></div>
      <span id="user-name"></span>
      <span id="user-email"></span>
    `;

    // Mock fetch — include headers.get, status, and clone for session-aware authFetch
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: jest.fn().mockReturnValue(null) },
      clone: function() { return this; },
      json: jest.fn().mockResolvedValue({}),
    });

    // Load core.js (with patched navigation)
    loadCoreJs();
  });

  // ---- initFirebaseAuth ----

  describe('initFirebaseAuth', () => {
    test('resolves true when user is authenticated', async () => {
      const fakeUser = {
        displayName: 'Test User',
        email: 'test@example.com',
        getIdToken: mockGetIdToken,
        emailVerified: true,
        providerData: [{ providerId: 'password' }],
      };

      mockOnAuthStateChanged.mockImplementation((successCb) => {
        // Fire callback async so that `unsubscribe` var is assigned first
        Promise.resolve().then(() => successCb(fakeUser));
        return jest.fn();
      });

      const result = await window.initFirebaseAuth();

      expect(result).toBe(true);
      expect(window.currentUser).toBe(fakeUser);
    });

    test('updates user info in DOM when authenticated', async () => {
      const fakeUser = {
        displayName: 'Maria Garcia',
        email: 'maria@example.com',
        getIdToken: mockGetIdToken,
        emailVerified: true,
        providerData: [{ providerId: 'password' }],
      };

      mockOnAuthStateChanged.mockImplementation((successCb) => {
        Promise.resolve().then(() => successCb(fakeUser));
        return jest.fn();
      });

      await window.initFirebaseAuth();

      const userNameEl = document.getElementById('user-name');
      expect(userNameEl.textContent).toBe('Maria Garcia');
    });

    test('redirects to /login.html when user is null (not authenticated)', async () => {
      mockOnAuthStateChanged.mockImplementation((successCb) => {
        Promise.resolve().then(() => successCb(null));
        return jest.fn();
      });

      const result = await window.initFirebaseAuth();

      expect(result).toBe(false);
      expect(window.__lastNavigation).toBe('/login.html');
    });

    test('rejects when onAuthStateChanged fires error callback', async () => {
      const authError = new Error('Auth service unavailable');

      mockOnAuthStateChanged.mockImplementation((_successCb, errorCb) => {
        Promise.resolve().then(() => errorCb(authError));
        return jest.fn();
      });

      await expect(window.initFirebaseAuth()).rejects.toThrow(
        'Auth service unavailable'
      );
    });
  });

  // ---- authFetch ----

  describe('authFetch', () => {
    beforeEach(() => {
      // Set currentUser globally so authFetch works
      window.currentUser = {
        displayName: 'Test',
        email: 'test@example.com',
        getIdToken: mockGetIdToken,
      };
    });

    test('adds Authorization Bearer header with token from getIdToken()', async () => {
      await window.authFetch('/api/test', {});

      expect(mockGetIdToken).toHaveBeenCalled();
      expect(global.fetch).toHaveBeenCalledWith(
        '/api/test',
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: 'Bearer mock-id-token-123',
          }),
        })
      );
    });

    test('merges existing headers with auth header', async () => {
      await window.authFetch('/api/test', {
        headers: { 'X-Custom': 'value' },
      });

      const callArgs = global.fetch.mock.calls[0][1];
      expect(callArgs.headers['Authorization']).toBe(
        'Bearer mock-id-token-123'
      );
      expect(callArgs.headers['X-Custom']).toBe('value');
    });

    test('adds Content-Type json when body is a string (not FormData)', async () => {
      await window.authFetch('/api/test', {
        method: 'POST',
        body: JSON.stringify({ key: 'value' }),
      });

      const callArgs = global.fetch.mock.calls[0][1];
      expect(callArgs.headers['Content-Type']).toBe('application/json');
    });

    test('does NOT add Content-Type when body is FormData', async () => {
      const formData = new FormData();
      formData.append('file', 'blob');

      await window.authFetch('/api/upload', {
        method: 'POST',
        body: formData,
      });

      const callArgs = global.fetch.mock.calls[0][1];
      expect(callArgs.headers['Content-Type']).toBeUndefined();
    });

    test('throws when currentUser is null', async () => {
      window.currentUser = null;

      await expect(window.authFetch('/api/test', {})).rejects.toThrow(
        'Not authenticated'
      );
    });

    test('redirects to /login.html when getIdToken fails', async () => {
      window.currentUser = {
        getIdToken: jest.fn().mockRejectedValue(new Error('Token expired')),
      };

      const result = await window.authFetch('/api/test', {});

      // authFetch returns undefined after redirect
      expect(result).toBeUndefined();
      expect(window.__lastNavigation).toBe('/login.html');
    });
  });

  // ---- logout ----

  describe('logout', () => {
    test('calls firebase.auth().signOut() and redirects to /login.html', async () => {
      window.currentUser = { email: 'test@example.com', getIdToken: mockGetIdToken };

      window.logout();

      // signOut is async — wait a tick
      await new Promise((r) => setTimeout(r, 0));

      expect(mockSignOut).toHaveBeenCalled();
      expect(window.__lastNavigation).toBe('/login.html');
    });

    test('redirects to /login.html even when signOut fails', async () => {
      mockSignOut.mockRejectedValue(new Error('signOut failed'));

      window.logout();
      await new Promise((r) => setTimeout(r, 0));

      expect(window.__lastNavigation).toBe('/login.html');
    });
  });

  // ---- firebase.initializeApp ----

  describe('firebase initialization', () => {
    test('calls firebase.initializeApp with config on load', () => {
      // initializeApp was already called when we loaded core.js in beforeEach
      expect(global.firebase.initializeApp).toHaveBeenCalledWith(
        expect.objectContaining({
          apiKey: expect.any(String),
          authDomain: expect.any(String),
          projectId: expect.any(String),
        })
      );
    });
  });
});

// ---------------------------------------------------------------------------
// SECTION 2: index.html — Firebase CDN scripts verification
// ---------------------------------------------------------------------------
describe('index.html Firebase integration', () => {
  let htmlContent;

  beforeAll(() => {
    htmlContent = fs.readFileSync(
      path.join(__dirname, '..', 'public', 'index.html'),
      'utf-8'
    );
  });

  test('includes firebase-app-compat.js CDN script', () => {
    expect(htmlContent).toContain('firebase-app-compat.js');
  });

  test('includes firebase-auth-compat.js CDN script', () => {
    expect(htmlContent).toContain('firebase-auth-compat.js');
  });

  test('loads Firebase scripts from gstatic.com', () => {
    expect(htmlContent).toContain('https://www.gstatic.com/firebasejs/');
  });

  test('does NOT include Keycloak scripts', () => {
    expect(htmlContent).not.toContain('keycloak.js');
    expect(htmlContent).not.toContain('keycloak.min.js');
    expect(htmlContent).not.toContain('Keycloak(');
  });

  test('loads core.js which contains Firebase auth init', () => {
    expect(htmlContent).toContain('src="/js/core.js"');
  });

  test('firebase-app-compat loads before firebase-auth-compat', () => {
    const appIdx = htmlContent.indexOf('firebase-app-compat.js');
    const authIdx = htmlContent.indexOf('firebase-auth-compat.js');
    expect(appIdx).toBeLessThan(authIdx);
  });
});

// ---------------------------------------------------------------------------
// SECTION 3: login.html — Form structure and Firebase config
// ---------------------------------------------------------------------------
describe('login.html structure', () => {
  beforeAll(() => {
    loadHTML('public/login.html');
  });

  test('contains an email input field', () => {
    const emailInput = document.getElementById('email');
    expect(emailInput).not.toBeNull();
    expect(emailInput.type).toBe('email');
  });

  test('contains a password input field', () => {
    const passwordInput = document.getElementById('password');
    expect(passwordInput).not.toBeNull();
    expect(passwordInput.type).toBe('password');
  });

  test('contains a submit button', () => {
    const submitBtn = document.getElementById('submitBtn');
    expect(submitBtn).not.toBeNull();
    expect(submitBtn.type).toBe('submit');
  });

  test('contains a Google sign-in button', () => {
    const googleBtn = document.getElementById('googleBtn');
    expect(googleBtn).not.toBeNull();
    expect(googleBtn.textContent).toContain('Google');
  });

  test('contains a display name field for registration', () => {
    const nameField = document.getElementById('displayName');
    expect(nameField).not.toBeNull();
  });

  test('has a toggle link to switch between login and register modes', () => {
    const toggleLink = document.getElementById('toggleLink');
    expect(toggleLink).not.toBeNull();
  });

  test('contains Firebase CDN scripts', () => {
    const html = fs.readFileSync(
      path.join(__dirname, '..', 'public', 'login.html'),
      'utf-8'
    );
    expect(html).toContain('firebase-app-compat.js');
    expect(html).toContain('firebase-auth-compat.js');
  });

  test('contains Firebase config with required fields', () => {
    const html = fs.readFileSync(
      path.join(__dirname, '..', 'public', 'login.html'),
      'utf-8'
    );
    expect(html).toContain('apiKey');
    expect(html).toContain('authDomain');
    expect(html).toContain('projectId');
    expect(html).toContain('firebase.initializeApp');
  });

  test('has auth form element', () => {
    const form = document.getElementById('authForm');
    expect(form).not.toBeNull();
    expect(form.tagName.toLowerCase()).toBe('form');
  });

  test('password field has minlength of 6', () => {
    const passwordInput = document.getElementById('password');
    expect(passwordInput.getAttribute('minlength')).toBe('6');
  });
});
