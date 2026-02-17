/**
 * Core - Authentication, Utils, and Base Functions
 */

// Authentication state
let keycloak = null;
let currentOwnerUserId = null;
let pollingInterval = null;

// API Base
async function authFetch(url, options = {}) {
  if (!keycloak || !keycloak.authenticated) {
    console.error('Not authenticated');
    throw new Error('Not authenticated');
  }
  
  try {
    await keycloak.updateToken(30);
  } catch (err) {
    console.warn('Token refresh failed, redirecting to login');
    keycloak.login();
    return;
  }
  
  const headers = {
    'Authorization': `Bearer ${keycloak.token}`,
    ...options.headers
  };
  
  if (!(options.body instanceof FormData) && options.body) {
    headers['Content-Type'] = 'application/json';
  }
  
  return fetch(url, { ...options, headers });
}

// Initialize Keycloak
async function initKeycloak() {
  try {
    keycloak = new Keycloak({
      url: 'https://auth.mindtechpy.net',
      realm: 'message-sender',
      clientId: 'message-sender-web'
    });

    const authenticated = await keycloak.init({
      onLoad: 'login-required',
      checkLoginIframe: false,
      enableLogging: true
    });

    if (authenticated) {
      currentOwnerUserId = keycloak.tokenParsed?.sub || keycloak.tokenParsed?.preferred_username;
      updateUserInfo();
      hideLoadingScreen();
      return true;
    } else {
      keycloak.login();
      return false;
    }
  } catch (error) {
    console.error('Keycloak init failed:', error);
    hideLoadingScreen();
    showAlert('Error de autenticación. Intente recargar la página.', 'danger', 'Error');
    return false;
  }
}

// Update user info in UI
function updateUserInfo() {
  const userInfoEl = document.getElementById('user-info');
  const userNameEl = document.getElementById('user-name');
  const userEmailEl = document.getElementById('user-email');
  
  if (keycloak && keycloak.tokenParsed) {
    const name = keycloak.tokenParsed.name || keycloak.tokenParsed.preferred_username || 'Usuario';
    const email = keycloak.tokenParsed.email || '';
    
    if (userNameEl) userNameEl.textContent = name;
    if (userEmailEl) userEmailEl.textContent = email;
    if (userInfoEl) userInfoEl.classList.remove('d-none');
  }
}

// Logout
function logout() {
  if (keycloak) {
    keycloak.logout({ redirectUri: window.location.origin });
  }
}

// Loading Screen
function hideLoadingScreen() {
  const loadingScreen = document.getElementById('loading-screen');
  if (loadingScreen) {
    loadingScreen.classList.add('fade-out');
    setTimeout(() => loadingScreen.remove(), 500);
  }
}

// Alert System
function showAlert(message, type = 'info', title = null) {
  const container = document.getElementById('alert-container');
  if (!container) return;
  
  const alertId = `alert-${Date.now()}`;
  const alert = document.createElement('div');
  alert.id = alertId;
  alert.className = `alert alert-${type} alert-dismissible fade show`;
  
  const iconMap = {
    success: 'bi-check-circle-fill',
    danger: 'bi-exclamation-triangle-fill',
    warning: 'bi-exclamation-circle-fill',
    info: 'bi-info-circle-fill'
  };
  
  alert.innerHTML = `
    <div class="alert-content">
      <i class="bi ${iconMap[type] || iconMap.info} alert-icon"></i>
      <div class="alert-text">
        ${title ? `<strong>${title}</strong><br>` : ''}
        ${message}
      </div>
    </div>
    <button type="button" class="btn-close" onclick="this.parentElement.remove()"></button>
  `;
  
  container.appendChild(alert);
  setTimeout(() => alert.remove(), 5000);
}

// Theme Toggle
function setupThemeToggle() {
  const themeSwitch = document.getElementById('themeSwitch');
  if (!themeSwitch) return;
  
  const savedTheme = localStorage.getItem('theme') || 'dark';
  document.documentElement.setAttribute('data-theme', savedTheme);
  themeSwitch.checked = savedTheme === 'light';
  
  themeSwitch.addEventListener('change', () => {
    const theme = themeSwitch.checked ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('theme', theme);
    
    // Redraw charts if needed
    if (typeof loadDashboard === 'function') {
      loadDashboard();
    }
  });
}

// Tab Navigation
function showTab(tabId) {
  // Update buttons
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tab === tabId);
  });
  
  // Update panes
  document.querySelectorAll('.tab-pane').forEach(pane => {
    pane.classList.toggle('active', pane.id === tabId);
  });
  
  // Update hash
  history.replaceState(null, '', `#${tabId}`);
  
  // Load tab content
  if (tabId === 'dashboard' && typeof loadDashboard === 'function') {
    loadDashboard();
  } else if (tabId === 'contacts' && typeof loadContacts === 'function') {
    loadContacts();
  }
}

// Query builder
function buildQuery(params = {}) {
  const q = new URLSearchParams();
  Object.entries(params).forEach(([k, v]) => {
    if (v !== undefined && v !== null && String(v).trim() !== '') {
      q.set(k, String(v));
    }
  });
  const s = q.toString();
  return s ? `?${s}` : '';
}

// Get chart text color based on theme
function getChartTextColor() {
  return getComputedStyle(document.documentElement).getPropertyValue('--text-primary').trim() || '#d8dee9';
}

// Global exports
window.authFetch = authFetch;
window.showAlert = showAlert;
window.showTab = showTab;
window.buildQuery = buildQuery;
window.getChartTextColor = getChartTextColor;
window.logout = logout;
