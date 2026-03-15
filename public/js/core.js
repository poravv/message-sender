/**
 * Core - Firebase Authentication, Utils, and Base Functions
 */

// Firebase configuration
const firebaseConfig = {
  apiKey: "AIzaSyDpY5e473wovRQDTFfBCG7Wfv57ZydAaNI",
  authDomain: "whatsapp-sender-d0f81.firebaseapp.com",
  projectId: "whatsapp-sender-d0f81",
  storageBucket: "whatsapp-sender-d0f81.firebasestorage.app",
  messagingSenderId: "54385260165",
  appId: "1:54385260165:web:e660c8a97932ac1c14dbec",
  measurementId: "G-XR2QGFXV30"
};

// Initialize Firebase
firebase.initializeApp(firebaseConfig);

// Authentication state
var currentUser = null;
var pollingInterval = null;

// API Base - authenticated fetch
async function authFetch(url, options) {
  options = options || {};

  if (!currentUser) {
    console.error('Not authenticated');
    throw new Error('Not authenticated');
  }

  var token;
  try {
    token = await currentUser.getIdToken();
  } catch (err) {
    console.warn('Token refresh failed, redirecting to login');
    window.location.href = '/login.html';
    return;
  }

  var headers = {
    'Authorization': 'Bearer ' + token
  };

  // Attach session token if available
  var sessionToken = localStorage.getItem('sessionToken');
  if (sessionToken) {
    headers['X-Session-Token'] = sessionToken;
  }

  // Merge existing headers
  if (options.headers) {
    var existing = options.headers;
    for (var key in existing) {
      if (existing.hasOwnProperty(key)) {
        headers[key] = existing[key];
      }
    }
  }

  if (!(options.body instanceof FormData) && options.body) {
    headers['Content-Type'] = 'application/json';
  }

  var fetchOptions = {};
  for (var k in options) {
    if (options.hasOwnProperty(k)) {
      fetchOptions[k] = options[k];
    }
  }
  fetchOptions.headers = headers;

  var response = await fetch(url, fetchOptions);

  // Capture session token from response header
  var newSessionToken = response.headers.get('X-Session-Token');
  if (newSessionToken) {
    localStorage.setItem('sessionToken', newSessionToken);
  }

  // Intercept 401 session conflict
  if (response.status === 401) {
    try {
      var cloned401 = response.clone();
      var body401 = await cloned401.json();
      if (body401.error === 'session_conflict') {
        showSessionConflictModal();
        return response;
      }
    } catch (e) {
      // ignore parse errors
    }
  }

  // Intercept 403 trial/account/verification errors
  if (response.status === 403) {
    try {
      var cloned = response.clone();
      var body = await cloned.json();
      if (body.error === 'email_not_verified') {
        // Reload user to get fresh state, then show verification block
        var freshUser = firebase.auth().currentUser;
        if (freshUser) {
          showEmailVerificationBlock(freshUser);
        }
      } else if (body.error === 'trial_expired') {
        showTrialExpiredModal(body.trialEndsAt);
      } else if (body.error === 'account_inactive') {
        showTrialExpiredModal(null, true);
      } else if (body.error === 'account_suspended') {
        showAccountBlockedModal('suspended', body.message);
      } else if (body.error === 'account_disabled') {
        showAccountBlockedModal('disabled', body.message);
      }
    } catch (e) {
      // ignore parse errors
    }
  }

  return response;
}

// Initialize Firebase Auth
function initFirebaseAuth() {
  return new Promise(function(resolve, reject) {
    var unsubscribe = firebase.auth().onAuthStateChanged(function(user) {
      unsubscribe();

      if (user) {
        // Check if email is verified (Google users are auto-verified)
        var isGoogle = user.providerData.length > 0 &&
          user.providerData[0].providerId === 'google.com';

        if (!isGoogle && !user.emailVerified) {
          // Block unverified users — show verification pending UI
          hideLoadingScreen();
          showEmailVerificationBlock(user);
          resolve(false);
          return;
        }

        currentUser = user;
        updateUserInfo();
        hideLoadingScreen();
        resolve(true);
      } else {
        // Not authenticated - redirect to login
        window.location.href = '/login.html';
        resolve(false);
      }
    }, function(error) {
      unsubscribe();
      console.error('Firebase auth error:', error);
      hideLoadingScreen();
      showAlert('Error de autenticación. Intente recargar la página.', 'danger', 'Error');
      reject(error);
    });
  });
}

// Show blocking UI when email is not verified
function showEmailVerificationBlock(user) {
  // Create overlay that blocks the entire app
  var overlay = document.createElement('div');
  overlay.id = 'email-verify-overlay';
  overlay.className = 'trial-modal-overlay';
  overlay.innerHTML =
    '<div class="trial-modal-card" style="max-width: 440px;">' +
      '<div class="trial-modal-icon"><i class="bi bi-envelope-check" style="color:#25D366;font-size:2.5rem;"></i></div>' +
      '<h2>Verifica tu correo electronico</h2>' +
      '<p>Enviamos un enlace de verificacion a:</p>' +
      '<p style="color:#25D366; font-weight:600; margin: 0.25rem 0 1rem;">' + (user.email || '') + '</p>' +
      '<div id="verifyOverlayAlert" style="margin-bottom:1rem;"></div>' +
      '<div class="trial-modal-actions" style="flex-direction:column; gap:0.5rem;">' +
        '<button class="btn-primary" id="overlayCheckVerifiedBtn" style="width:100%;">' +
          '<i class="bi bi-check-circle"></i> Ya verifique mi correo' +
        '</button>' +
        '<button class="btn-primary" id="overlayResendBtn" style="width:100%; background:var(--bg-tertiary,#242b33); color:var(--text-primary,#e7e9ea);">' +
          '<i class="bi bi-arrow-repeat"></i> Reenviar correo de verificacion' +
        '</button>' +
        '<button class="btn-primary" id="overlayLogoutBtn" style="width:100%; background:transparent; color:var(--text-secondary,#8b98a5); border:1px solid var(--border-color,#2f3640);">' +
          'Cerrar sesion' +
        '</button>' +
      '</div>' +
    '</div>';

  document.body.appendChild(overlay);

  function showOverlayMsg(msg, isSuccess) {
    var el = document.getElementById('verifyOverlayAlert');
    if (!el) return;
    el.style.padding = '0.6rem 1rem';
    el.style.borderRadius = '6px';
    el.style.fontSize = '0.875rem';
    if (isSuccess) {
      el.style.background = 'rgba(74, 222, 128, 0.1)';
      el.style.color = '#4ade80';
      el.style.border = '1px solid rgba(74, 222, 128, 0.2)';
    } else {
      el.style.background = 'rgba(248, 113, 113, 0.1)';
      el.style.color = '#f87171';
      el.style.border = '1px solid rgba(248, 113, 113, 0.2)';
    }
    el.textContent = msg;
  }

  // "Ya verifique" button
  document.getElementById('overlayCheckVerifiedBtn').addEventListener('click', function() {
    var btn = this;
    btn.disabled = true;
    btn.textContent = 'Verificando...';

    user.reload().then(function() {
      var freshUser = firebase.auth().currentUser;
      if (freshUser && freshUser.emailVerified) {
        // Verified — reload the page to proceed normally
        window.location.reload();
      } else {
        btn.disabled = false;
        btn.innerHTML = '<i class="bi bi-check-circle"></i> Ya verifique mi correo';
        showOverlayMsg('Todavia no verificaste tu correo. Revisa tu bandeja de entrada.', false);
      }
    }).catch(function() {
      btn.disabled = false;
      btn.innerHTML = '<i class="bi bi-check-circle"></i> Ya verifique mi correo';
      showOverlayMsg('Error al verificar. Intenta de nuevo.', false);
    });
  });

  // "Reenviar" button
  document.getElementById('overlayResendBtn').addEventListener('click', function() {
    var btn = this;
    btn.disabled = true;
    btn.textContent = 'Enviando...';

    user.sendEmailVerification().then(function() {
      btn.disabled = false;
      btn.innerHTML = '<i class="bi bi-arrow-repeat"></i> Reenviar correo de verificacion';
      showOverlayMsg('Correo de verificacion reenviado.', true);
    }).catch(function(err) {
      btn.disabled = false;
      btn.innerHTML = '<i class="bi bi-arrow-repeat"></i> Reenviar correo de verificacion';
      if (err.code === 'auth/too-many-requests') {
        showOverlayMsg('Demasiados intentos. Espera unos minutos.', false);
      } else {
        showOverlayMsg('Error al reenviar. Intenta de nuevo.', false);
      }
    });
  });

  // Logout button
  document.getElementById('overlayLogoutBtn').addEventListener('click', function() {
    firebase.auth().signOut().then(function() {
      currentUser = null;
      window.location.href = '/login.html';
    });
  });
}

// Update user info in UI
function updateUserInfo() {
  var userInfoEl = document.getElementById('user-info');
  var userNameEl = document.getElementById('user-name');
  var userEmailEl = document.getElementById('user-email');

  if (currentUser) {
    var name = currentUser.displayName || currentUser.email || 'Usuario';
    var email = currentUser.email || '';

    if (userNameEl) userNameEl.textContent = name;
    if (userEmailEl) userEmailEl.textContent = email;
    if (userInfoEl) userInfoEl.classList.remove('d-none');
  }
}

// Session management — create a new session after login
async function createAppSession() {
  if (!currentUser) return null;

  try {
    var token = await currentUser.getIdToken();
    var resp = await fetch('/auth/session', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + token,
        'Content-Type': 'application/json'
      }
    });

    if (!resp.ok) {
      console.error('Failed to create session:', resp.status);
      return null;
    }

    var data = await resp.json();
    if (data.sessionToken) {
      localStorage.setItem('sessionToken', data.sessionToken);
      console.log('Session created successfully');
      return data.sessionToken;
    }
  } catch (err) {
    console.error('Error creating session:', err);
  }
  return null;
}

// Session conflict modal
function showSessionConflictModal() {
  // Prevent duplicates
  var existing = document.getElementById('session-conflict-modal');
  if (existing) return;

  var modal = document.createElement('div');
  modal.id = 'session-conflict-modal';
  modal.className = 'trial-modal-overlay';
  modal.innerHTML =
    '<div class="trial-modal-card">' +
      '<div class="trial-modal-icon"><i class="bi bi-laptop" style="color:#e67e22;"></i></div>' +
      '<h2>Sesion activa en otro dispositivo</h2>' +
      '<p>Tu cuenta fue abierta desde otro navegador o dispositivo. Solo se permite una sesion activa.</p>' +
      '<div class="trial-modal-actions">' +
        '<button class="btn-primary" id="sessionConflictUseHereBtn">Usar aqui</button>' +
        '<button class="btn-secondary" onclick="logout()" style="margin-left:8px;">Cerrar sesion</button>' +
      '</div>' +
    '</div>';

  document.body.appendChild(modal);

  document.getElementById('sessionConflictUseHereBtn').addEventListener('click', async function() {
    this.disabled = true;
    this.textContent = 'Conectando...';
    var token = await createAppSession();
    if (token) {
      var m = document.getElementById('session-conflict-modal');
      if (m) m.remove();
      // Reload to re-fetch data with new session
      window.location.reload();
    } else {
      this.disabled = false;
      this.textContent = 'Usar aqui';
      showAlert('Error al crear sesion. Intente de nuevo.', 'danger');
    }
  });
}

// Logout
function logout() {
  // Clear session from backend (fire-and-forget)
  if (currentUser) {
    currentUser.getIdToken().then(function(token) {
      fetch('/auth/logout-session', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + token }
      }).catch(function() {});
    }).catch(function() {});
  }

  // Clear local session token
  localStorage.removeItem('sessionToken');

  firebase.auth().signOut().then(function() {
    currentUser = null;
    window.location.href = '/login.html';
  }).catch(function(error) {
    console.error('Logout error:', error);
    // Force redirect anyway
    window.location.href = '/login.html';
  });
}

// Loading Screen
function hideLoadingScreen() {
  var loadingScreen = document.getElementById('loading-screen');
  if (loadingScreen) {
    loadingScreen.classList.add('fade-out');
    setTimeout(function() { loadingScreen.remove(); }, 500);
  }
}

// Alert System
function showAlert(message, type, title) {
  type = type || 'info';
  title = title || null;
  var container = document.getElementById('alert-container');
  if (!container) return;

  var dismissTime = 5000;
  var alertEl = document.createElement('div');
  alertEl.className = 'alert alert-' + type;

  var iconMap = {
    success: 'bi-check-circle-fill',
    danger: 'bi-x-circle-fill',
    warning: 'bi-exclamation-triangle-fill',
    info: 'bi-info-circle-fill'
  };

  function removeAlert() {
    if (alertEl.classList.contains('alert-removing')) return;
    alertEl.classList.add('alert-removing');
    setTimeout(function() { alertEl.remove(); }, 300);
  }

  alertEl.innerHTML =
    '<div class="alert-body">' +
      '<div class="alert-icon"><i class="bi ' + (iconMap[type] || iconMap.info) + '"></i></div>' +
      '<div class="alert-text">' +
        (title ? '<strong>' + title + '</strong>' : '') +
        message +
      '</div>' +
    '</div>' +
    '<button type="button" class="alert-close-btn" aria-label="Cerrar"><i class="bi bi-x-lg"></i></button>' +
    '<div class="alert-progress" style="animation-duration: ' + dismissTime + 'ms;"></div>';

  alertEl.querySelector('.alert-close-btn').addEventListener('click', removeAlert);

  container.appendChild(alertEl);
  setTimeout(removeAlert, dismissTime);
}

// Theme Toggle
function setupThemeToggle() {
  var themeSwitch = document.getElementById('themeSwitch');
  if (!themeSwitch) return;

  var savedTheme = localStorage.getItem('theme') || 'dark';
  document.documentElement.setAttribute('data-theme', savedTheme);
  themeSwitch.checked = savedTheme === 'light';

  themeSwitch.addEventListener('change', function() {
    var theme = themeSwitch.checked ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('theme', theme);

    // Redraw charts if needed
    if (typeof loadDashboard === 'function') {
      loadDashboard();
    }
  });
}

// More menu dropdown
function setupMoreMenu() {
  var wrapper = document.querySelector('.tab-more-wrapper');
  var trigger = document.getElementById('moreTabsBtn');
  var menu = document.getElementById('moreTabsMenu');
  if (!wrapper || !trigger || !menu) return;

  // Toggle dropdown on click
  trigger.addEventListener('click', function(e) {
    e.stopPropagation();
    wrapper.classList.toggle('open');
  });

  // Close on click outside
  document.addEventListener('click', function(e) {
    if (!wrapper.contains(e.target)) {
      wrapper.classList.remove('open');
    }
  });

  // Handle dropdown item clicks
  menu.querySelectorAll('.tab-more-item').forEach(function(item) {
    item.addEventListener('click', function() {
      var tab = item.dataset.tab;
      wrapper.classList.remove('open');

      // Check if send tab requires connection
      if (tab === 'send' && !window.isWhatsAppConnected?.()) {
        showAlert('Primero conecta WhatsApp', 'warning');
        showTab('whatsapp');
        return;
      }

      showTab(tab);
    });
  });
}

// Tab Navigation
function showTab(tabId) {
  // Determine if tab is in the dropdown
  var isDropdownTab = false;
  var dropdownItem = document.querySelector('.tab-more-item[data-tab="' + tabId + '"]');
  if (dropdownItem) {
    isDropdownTab = true;
  }

  // Update primary tab buttons
  document.querySelectorAll('.tabs-nav > .tab-btn').forEach(function(btn) {
    btn.classList.toggle('active', btn.dataset.tab === tabId);
  });

  // Update dropdown items
  document.querySelectorAll('.tab-more-item').forEach(function(item) {
    item.classList.toggle('active', item.dataset.tab === tabId);
  });

  // Highlight the "Mas" trigger when a dropdown tab is active
  var moreTrigger = document.getElementById('moreTabsBtn');
  if (moreTrigger) {
    moreTrigger.classList.toggle('active', isDropdownTab);
  }

  // Update panes
  document.querySelectorAll('.tab-pane').forEach(function(pane) {
    pane.classList.toggle('active', pane.id === tabId);
  });

  // Update hash
  history.replaceState(null, '', '#' + tabId);

  // Load tab content
  if (tabId === 'dashboard' && typeof loadDashboard === 'function') {
    loadDashboard();
  } else if (tabId === 'contacts' && typeof loadContacts === 'function') {
    loadContacts();
  } else if (tabId === 'templates' && typeof loadTemplates === 'function') {
    loadTemplates();
  } else if (tabId === 'plans' && typeof loadPlans === 'function') {
    loadPlans();
  } else if (tabId === 'api' && typeof loadApi === 'function') {
    loadApi();
  } else if (tabId === 'inbox' && typeof loadInbox === 'function') {
    loadInbox();
  } else if (tabId === 'campaigns' && typeof loadCampaigns === 'function') {
    loadCampaigns();
  } else if (tabId === 'chatbot' && typeof loadChatbot === 'function') {
    loadChatbot();
  } else if (tabId === 'admin' && typeof loadAdmin === 'function') {
    loadAdmin();
  }

  // Stop inbox polling when leaving inbox tab
  if (tabId !== 'inbox' && typeof stopInboxPolling === 'function') {
    stopInboxPolling();
  }
}

// Query builder
function buildQuery(params) {
  params = params || {};
  var q = new URLSearchParams();
  Object.entries(params).forEach(function(entry) {
    var k = entry[0];
    var v = entry[1];
    if (v !== undefined && v !== null && String(v).trim() !== '') {
      q.set(k, String(v));
    }
  });
  var s = q.toString();
  return s ? '?' + s : '';
}

// Get chart text color based on theme
function getChartTextColor() {
  return getComputedStyle(document.documentElement).getPropertyValue('--text-primary').trim() || '#d8dee9';
}

// Trial status
var userProfile = null;

function loadUserProfile() {
  return authFetch('/user/profile')
    .then(function(res) {
      if (!res || !res.ok) return null;
      return res.json();
    })
    .then(function(profile) {
      if (!profile) return;
      userProfile = profile;
      window.userProfile = profile;
      updateTrialBadge(profile);
      return profile;
    })
    .catch(function(err) {
      console.error('Failed to load user profile:', err);
    });
}

function updateTrialBadge(profile) {
  var badge = document.getElementById('trial-badge');
  if (!badge) return;

  if (profile.role === 'admin') {
    badge.innerHTML = '<i class="bi bi-shield-check"></i> Admin';
    badge.className = 'trial-badge badge-admin';
    badge.classList.remove('d-none');
    return;
  }

  if (profile.plan === 'active') {
    badge.innerHTML = '<i class="bi bi-check-circle"></i> Plan Activo';
    badge.className = 'trial-badge badge-active';
    badge.classList.remove('d-none');
    return;
  }

  if (profile.plan === 'trial' && profile.trialDaysLeft > 0) {
    badge.innerHTML = '<i class="bi bi-clock"></i> Prueba: ' + profile.trialDaysLeft + ' dias';
    badge.className = 'trial-badge badge-trial';
    if (profile.trialDaysLeft <= 3) {
      badge.className += ' badge-trial-urgent';
    }
    badge.classList.remove('d-none');
    return;
  }

  if (profile.plan === 'expired' || (profile.plan === 'trial' && profile.trialDaysLeft <= 0)) {
    badge.innerHTML = '<i class="bi bi-exclamation-triangle"></i> Expirado';
    badge.className = 'trial-badge badge-expired';
    badge.classList.remove('d-none');
    showTrialExpiredModal(null, profile.plan === 'expired');
    return;
  }
}

function showTrialExpiredModal(trialEndsAt, isInactive) {
  // Remove existing modal if any
  var existing = document.getElementById('trial-expired-modal');
  if (existing) existing.remove();

  var title = isInactive ? 'Cuenta Inactiva' : 'Periodo de Prueba Expirado';
  var message = isInactive
    ? 'Tu cuenta esta inactiva. Contacta al administrador para activar tu plan.'
    : 'Tu periodo de prueba ha expirado. Contacta al administrador para continuar usando el servicio.';

  var modal = document.createElement('div');
  modal.id = 'trial-expired-modal';
  modal.className = 'trial-modal-overlay';
  modal.innerHTML =
    '<div class="trial-modal-card">' +
      '<div class="trial-modal-icon"><i class="bi bi-exclamation-triangle-fill"></i></div>' +
      '<h2>' + title + '</h2>' +
      '<p>' + message + '</p>' +
      (trialEndsAt ? '<p class="trial-date">Expiro: ' + new Date(trialEndsAt).toLocaleDateString() + '</p>' : '') +
      '<div class="trial-modal-actions">' +
        '<button class="btn-primary" onclick="logout()">Cerrar Sesion</button>' +
      '</div>' +
    '</div>';

  document.body.appendChild(modal);
}

// Account blocked modal (suspended/disabled)
function showAccountBlockedModal(type, message) {
  var existing = document.getElementById('account-blocked-modal');
  if (existing) existing.remove();

  var title = type === 'suspended' ? 'Cuenta Suspendida' : 'Cuenta Deshabilitada';
  var msg = message || (type === 'suspended'
    ? 'Tu cuenta ha sido suspendida. Contacta al administrador.'
    : 'Tu cuenta ha sido deshabilitada. Contacta al administrador.');
  var iconColor = type === 'suspended' ? '#f59e0b' : '#ef4444';

  var modal = document.createElement('div');
  modal.id = 'account-blocked-modal';
  modal.className = 'trial-modal-overlay';
  modal.innerHTML =
    '<div class="trial-modal-card">' +
      '<div class="trial-modal-icon"><i class="bi bi-shield-exclamation" style="color:' + iconColor + ';"></i></div>' +
      '<h2>' + title + '</h2>' +
      '<p>' + msg + '</p>' +
      '<div class="trial-modal-actions">' +
        '<button class="btn-primary" onclick="logout()">Cerrar Sesion</button>' +
      '</div>' +
    '</div>';

  document.body.appendChild(modal);
}

// Global exports
window.authFetch = authFetch;
window.showAlert = showAlert;
window.showTab = showTab;
window.setupMoreMenu = setupMoreMenu;
window.buildQuery = buildQuery;
window.getChartTextColor = getChartTextColor;
window.logout = logout;
window.initFirebaseAuth = initFirebaseAuth;
window.loadUserProfile = loadUserProfile;
window.showTrialExpiredModal = showTrialExpiredModal;
window.createAppSession = createAppSession;
window.showSessionConflictModal = showSessionConflictModal;
window.showAccountBlockedModal = showAccountBlockedModal;
window.userProfile = userProfile;
