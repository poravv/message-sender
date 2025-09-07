/** ======== Configuration ======== */
const CONFIG = {
  checkInterval: 15000, // Cambio de 3s a 15s para reducir carga del servidor
  statusEndpoint: '/connection-status',
  keycloakConfig: {
    url: 'https://kc.mindtechpy.net',
    realm: 'message-sender',
    clientId: 'message-sender-web'  // Usar el cliente web correcto
  },
  // Development mode fallback
  isDevelopment: false, // Siempre usar Keycloak
  // Prevent auth loops
  maxAuthAttempts: 3,
  authAttemptKey: 'keycloak_auth_attempts'
};

/** ======== Debug Helper ======== */
function logDebug(...args) {
  if (CONFIG.isDevelopment) {
    console.log('[DEBUG]', ...args);
  }
}

/** ======== Multi-Session State ======== */
let currentUser = {
  id: null,
  name: null,
  email: null
};

/** ======== User Interface Functions ======== */

// Función de diagnóstico para debug
function diagnoseKeycloak() {
  console.log('🔍 Diagnóstico de Keycloak:', {
    keycloakInitialized: !!keycloak,
    authenticated: keycloak?.authenticated,
    token: keycloak?.token ? 'Presente (longitud: ' + keycloak.token.length + ')' : 'Ausente',
    tokenParsed: keycloak?.tokenParsed,
    currentUser,
    config: CONFIG.keycloakConfig,
    url: window.location.href
  });
  
  if (keycloak?.token) {
    try {
      const payload = JSON.parse(atob(keycloak.token.split('.')[1]));
      console.log('📋 Payload del token:', payload);
    } catch (e) {
      console.error('❌ Error decodificando token:', e);
    }
  }
}

// Función de diagnóstico específica para el botón de logout
function diagnoseLogoutButton() {
  const logoutBtn = document.getElementById('logout-btn');
  console.log('🔍 Diagnóstico del botón de logout:', {
    buttonExists: !!logoutBtn,
    buttonVisible: logoutBtn?.offsetParent !== null,
    buttonDisabled: logoutBtn?.disabled,
    eventListeners: logoutBtn ? getEventListeners(logoutBtn) : 'N/A',
    buttonHTML: logoutBtn?.outerHTML
  });
  
  if (logoutBtn) {
    console.log('🖱️ Intentando hacer click programático...');
    logoutBtn.click();
  }
}

// Hacer disponible globalmente para debug
window.diagnoseKeycloak = diagnoseKeycloak;
window.diagnoseLogoutButton = diagnoseLogoutButton;
window.logoutKeycloak = logoutKeycloak;

function updateUserInfoNavbar(user) {
  const userInfoElement = document.getElementById('user-info');
  const userNameElement = document.getElementById('user-name');
  const userEmailElement = document.getElementById('user-email');
  
  if (userInfoElement && userNameElement && userEmailElement) {
    userNameElement.textContent = user.name || 'Usuario';
    userEmailElement.textContent = user.email || 'Sin email';
    userInfoElement.classList.remove('d-none');
    
    logDebug('Navbar actualizado con usuario:', user);
  }
}

/** ======== Keycloak Authentication ======== */
let keycloak = null;
let isAuthenticated = false;
let refreshing = false;
let refreshTimer = null;

// Inicializa Keycloak OBLIGATORIAMENTE (como en app-old.js)
async function initKeycloak() {
  try {
    // Verificar si ya estamos en un loop de autenticación
    const authAttempts = parseInt(sessionStorage.getItem(CONFIG.authAttemptKey) || '0');
    if (authAttempts >= CONFIG.maxAuthAttempts) {
      console.error('❌ Demasiados intentos de autenticación. Parando para evitar bucle.');
      hideLoadingScreen();
      showAlert('Error de autenticación persistente. Verifica la configuración de Keycloak.', 'error', 'Error crítico');
      return false;
    }
    
    showLoadingScreen('Inicializando autenticación...');
    
    console.log('🔧 Configuración Keycloak:', CONFIG.keycloakConfig);
    console.log('🌍 URL actual:', window.location.href);
    console.log('🔄 Intento de autenticación:', authAttempts + 1);
    console.log('🌐 Entorno detectado:', {
      hostname: window.location.hostname,
      origin: window.location.origin,
      nodeEnv: 'production (configurado en .env)'
    });
    
    // Incrementar contador de intentos
    sessionStorage.setItem(CONFIG.authAttemptKey, (authAttempts + 1).toString());
    
    keycloak = new Keycloak(CONFIG.keycloakConfig);
    
    console.log('🔄 Iniciando Keycloak...');
    
    // Configuración dinámica basada en el entorno
    const isLocalhost = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
    const baseUrl = window.location.origin;
    
    console.log('🌍 Entorno detectado:', {
      hostname: window.location.hostname,
      isLocalhost,
      baseUrl,
      keycloakUrl: CONFIG.keycloakConfig.url
    });
    
    const authenticated = await keycloak.init({
      onLoad: 'login-required', // Forzar login para asegurar autenticación
      checkLoginIframe: false,
      pkceMethod: 'S256',
      enableLogging: true,
      redirectUri: baseUrl + '/',
      silentCheckSsoRedirectUri: baseUrl + '/silent-check-sso.html',
      // Configuraciones específicas para producción
      flow: 'standard',
      responseMode: 'fragment'
    });

    console.log('✅ Keycloak inicializado. Autenticado:', authenticated);
    console.log('🔐 Token disponible:', !!keycloak.token);
    console.log('🎯 Token length:', keycloak.token ? keycloak.token.length : 0);
    
    if (keycloak.token) {
      console.log('📋 Info del token:', {
        sub: keycloak.tokenParsed?.sub,
        name: keycloak.tokenParsed?.name,
        email: keycloak.tokenParsed?.email,
        exp: new Date(keycloak.tokenParsed?.exp * 1000),
        aud: keycloak.tokenParsed?.aud,
        iss: keycloak.tokenParsed?.iss
      });
    }

    if (!authenticated) {
      console.log('🔐 Usuario no autenticado, redirigiendo al login...');
      hideLoadingScreen();
      
      // Verificar si venimos de una redirección de login fallida
      const urlParams = new URLSearchParams(window.location.search);
      if (urlParams.has('error')) {
        console.error('❌ Error en la redirección de Keycloak:', urlParams.get('error'));
        showAlert('Error de autenticación. Verifica tus credenciales.', 'error', 'Error de login');
        sessionStorage.removeItem(CONFIG.authAttemptKey);
        return false;
      }
      
      // Usar setTimeout para evitar loops inmediatos
      setTimeout(() => {
        keycloak.login({
          redirectUri: window.location.origin + window.location.pathname
        });
      }, 1000);
      return false;
    }

    // Si llegamos aquí, la autenticación fue exitosa - resetear contador
    sessionStorage.removeItem(CONFIG.authAttemptKey);
    
    isAuthenticated = true;
    console.log('✅ Autenticación exitosa');
    console.log('🔍 Token info:', keycloak.tokenParsed);
    
    // Extraer información del usuario
    if (keycloak.tokenParsed) {
      currentUser.id = keycloak.tokenParsed.sub;
      currentUser.name = keycloak.tokenParsed.name || keycloak.tokenParsed.preferred_username || keycloak.tokenParsed.email;
      currentUser.email = keycloak.tokenParsed.email;
      
      console.log('👤 Usuario autenticado exitosamente:', {
        id: currentUser.id,
        name: currentUser.name,
        email: currentUser.email,
        roles: keycloak.tokenParsed.resource_access,
        tokenExpires: new Date(keycloak.tokenParsed.exp * 1000).toLocaleString()
      });
      
      // Actualizar navbar con información del usuario de Keycloak
      updateUserInfoNavbar(currentUser);
      
      // Verificar que el usuario tiene los roles necesarios
      const hasApiRole = keycloak.tokenParsed.resource_access?.['message-sender-api']?.roles?.includes('sender_api');
      if (!hasApiRole) {
        console.warn('⚠️ Usuario no tiene el rol sender_api en message-sender-api');
        showAlert('Tu usuario no tiene permisos para usar esta aplicación. Contacta al administrador.', 'warning', 'Permisos insuficientes');
      } else {
        console.log('✅ Usuario tiene los permisos necesarios');
      }
    } else {
      console.error('❌ No se pudo obtener información del token');
    }
    
    // Renueva justo antes de expirar (sin loops)
    keycloak.onTokenExpired = async () => {
      if (refreshing) return;
      refreshing = true;
      console.log('🔄 Token expirado, renovando...');
      try {
        await keycloak.updateToken(30); // renueva si quedan <30s
        console.log('✅ Token renovado exitosamente');
      } catch (e) {
        console.error('❌ Fallo refrescando token', e);
        showAlert('Sesión expirada. Inicia sesión nuevamente.', 'warning');
        sessionStorage.removeItem(CONFIG.authAttemptKey); // Reset counter
        setTimeout(() => {
          keycloak.login();
        }, 2000);
      } finally {
        refreshing = false;
      }
    };

    // "Pulso" suave: cada 30s, si faltan <60s de token, intenta renovar
    const tick = async () => {
      clearTimeout(refreshTimer);
      try {
        if (!keycloak.authenticated) return;
        
        const expMs = keycloak.tokenParsed?.exp ? keycloak.tokenParsed.exp * 1000 : 0;
        if (expMs) {
          const delta = expMs - Date.now();
          if (delta < 60_000 && !refreshing) {
            console.log('🔄 Token próximo a expirar, renovando preventivamente...');
            await keycloak.updateToken(30);
          }
        }
      } catch (e) {
        console.warn('⚠️ Error en renovación preventiva:', e.message);
      }
      refreshTimer = setTimeout(tick, 30_000); // Aumentado a 30 segundos
    };
    tick();
    
    hideLoadingScreen();
    showAlert('Bienvenido al sistema', 'success', 'Autenticación exitosa');
    
    console.log('✅ Inicialización de Keycloak completada exitosamente');
    return true; // Retornar true en caso de éxito
    
  } catch (error) {
    console.error('❌ Error de autenticación:', error);
    hideLoadingScreen();
    
    // Reset contador en caso de error crítico
    sessionStorage.removeItem(CONFIG.authAttemptKey);
    
    // Verificar tipo de error
    if (error.message?.includes('CORS') || error.message?.includes('network')) {
      showAlert('Error de conectividad con Keycloak. Verifica tu conexión.', 'error', 'Error de red');
    } else if (error.message?.includes('client')) {
      showAlert('Error de configuración del cliente Keycloak.', 'error', 'Error de configuración');
    } else {
      showAlert('Error inesperado en la autenticación.', 'error', 'Error de autenticación');
    }
    
    // No recargar automáticamente para evitar loops
    console.log('🛑 Deteniendo para evitar bucle infinito. Revisa la configuración de Keycloak.');
    return false;
  }
}

// Helper: fetch con Authorization OBLIGATORIO (como en app-old.js)
async function authFetch(url, options = {}) {
  try {
    // Verificar que Keycloak esté inicializado
    if (!keycloak) {
      console.error('❌ Keycloak no está inicializado');
      throw new Error('Keycloak no está inicializado');
    }

    // Verificar autenticación
    if (!keycloak.authenticated) {
      console.error('❌ Usuario no autenticado');
      throw new Error('Usuario no autenticado');
    }

    // Intentar actualizar token si es necesario (30 segundos antes de expirar)
    try {
      const tokenRefreshed = await keycloak.updateToken(30);
      if (tokenRefreshed) {
        console.log('🔄 Token renovado automáticamente');
      }
    } catch (refreshError) {
      console.error('❌ Error renovando token:', refreshError);
      // Si falla la renovación, redirigir al login
      keycloak.login();
      throw new Error('Token expirado, redirigiendo al login');
    }

    // Verificar que tenemos un token válido
    if (!keycloak.token) {
      console.error('❌ No hay token disponible después de la renovación');
      keycloak.login();
      throw new Error('No hay token de autenticación disponible');
    }

    const headers = new Headers(options.headers || {});
    headers.set('Authorization', `Bearer ${keycloak.token}`);
    
    console.log('🔐 Enviando petición autenticada:', {
      url,
      userId: keycloak.tokenParsed?.sub,
      userName: keycloak.tokenParsed?.name || keycloak.tokenParsed?.preferred_username,
      tokenExpires: new Date(keycloak.tokenParsed?.exp * 1000).toLocaleString()
    });
    
    const response = await fetch(url, { ...options, headers });
    
    // Si recibimos 401, el token puede estar inválido
    if (response.status === 401) {
      console.error('❌ Respuesta 401 - Token inválido o expirado');
      keycloak.login();
      throw new Error('Token inválido, redirigiendo al login');
    }
    
    return response;
    
  } catch (error) {
    console.error('❌ Error en authFetch:', error);
    throw error;
  }
}

// Función para cerrar sesión de Keycloak
async function logoutKeycloak() {
  try {
    console.log('🚪 Iniciando proceso de logout...');
    
    // Verificar que Keycloak esté disponible
    if (!keycloak) {
      console.error('❌ Keycloak no está disponible para logout');
      showAlert('Error: Sistema de autenticación no disponible', 'error');
      return;
    }
    
    // Mostrar confirmación
    const confirmLogout = confirm('¿Estás seguro de que deseas cerrar sesión?');
    if (!confirmLogout) {
      console.log('🚫 Logout cancelado por el usuario');
      return;
    }
    
    console.log('✅ Confirmación de logout recibida, procediendo...');
    showLoadingScreen('Cerrando sesión...');
    
    // Limpiar datos locales
    console.log('🧹 Limpiando datos locales...');
    sessionStorage.removeItem(CONFIG.authAttemptKey);
    sessionStorage.clear();
    localStorage.clear();
    
    // Reiniciar estado de la aplicación
    isAuthenticated = false;
    currentUser = { id: null, name: null, email: null };
    
    console.log('🔄 Iniciando logout en Keycloak...');
    
    // Cerrar sesión en Keycloak con URL de redirección
    const logoutUrl = keycloak.createLogoutUrl({
      redirectUri: window.location.origin + window.location.pathname
    });
    
    console.log('🌐 Redirigiendo a:', logoutUrl);
    
    // Redireccionar manualmente para mayor control
    window.location.href = logoutUrl;
    
  } catch (error) {
    console.error('❌ Error durante el logout:', error);
    hideLoadingScreen();
    showAlert('Error al cerrar sesión. Inténtalo nuevamente.', 'error', 'Error de logout');
    
    // Como fallback, recargar la página
    setTimeout(() => {
      window.location.reload();
    }, 2000);
  }
}

/** ======== Loading Screen Management ======== */
function showLoadingScreen(message = 'Cargando...') {
  const loadingScreen = document.getElementById('loading-screen');
  const loadingMessage = document.getElementById('loadingMessage');
  
  if (loadingMessage) loadingMessage.textContent = message;
  if (loadingScreen) loadingScreen.classList.remove('d-none');
}

function hideLoadingScreen() {
  const loadingScreen = document.getElementById('loading-screen');
  if (loadingScreen) {
    setTimeout(() => {
      loadingScreen.classList.add('d-none');
    }, 500);
  }
}

/** ======== Enhanced Alert System ======== */
let alertContainer = null;

function createAlertContainer() {
  if (alertContainer) return;
  
  alertContainer = document.createElement('div');
  alertContainer.className = 'alert-container';
  alertContainer.style.cssText = `
    position: fixed;
    top: 20px;
    right: 20px;
    z-index: 9999;
    max-width: 400px;
  `;
  document.body.appendChild(alertContainer);
}

function showAlert(message, type = 'info', title = '') {
  createAlertContainer();
  
  const alertId = 'alert-' + Date.now();
  const typeClass = `alert-${type}`;
  const iconMap = {
    success: 'bi-check-circle-fill',
    error: 'bi-exclamation-triangle-fill',
    warning: 'bi-exclamation-triangle-fill',
    info: 'bi-info-circle-fill'
  };
  
  const alertElement = document.createElement('div');
  alertElement.id = alertId;
  alertElement.className = `alert ${typeClass} alert-dismissible fade show modern-alert`;
  alertElement.style.cssText = `
    margin-bottom: 10px;
    box-shadow: 0 4px 12px rgba(0,0,0,0.15);
    border: none;
    border-left: 4px solid var(--primary-500);
  `;
  
  alertElement.innerHTML = `
    <div class="d-flex align-items-start">
      <i class="bi ${iconMap[type] || iconMap.info} me-2 mt-1"></i>
      <div class="flex-grow-1">
        ${title ? `<strong class="alert-title">${title}</strong><br>` : ''}
        <span class="alert-message">${message}</span>
      </div>
      <button type="button" class="btn-close btn-close-white" data-bs-dismiss="alert"></button>
    </div>
  `;
  
  alertContainer.appendChild(alertElement);
  
  // Auto-dismiss after 5 seconds for non-error alerts
  if (type !== 'error') {
    setTimeout(() => {
      const alert = document.getElementById(alertId);
      if (alert) {
        const bsAlert = new bootstrap.Alert(alert);
        bsAlert.close();
      }
    }, 5000);
  }
}

/** ======== Tab Navigation ======== */
async function showTab(tabName) {
  // Check if tab is disabled
  const targetBtn = document.querySelector(`[data-tab="${tabName}"]`);
  if (targetBtn && targetBtn.classList.contains('disabled')) {
    showAlert('Esta sección está deshabilitada. Conecte WhatsApp primero.', 'warning', 'Acceso restringido');
    return;
  }

  // Validation for send tab - allow access when authenticated, but show warning if not ready
  if (tabName === 'send') {
    try {
      const res = await authFetch(CONFIG.statusEndpoint);
      const status = await res.json();
      const isConnected = status && (status.isReady === true || status.status === 'authenticated' || status.connectionState === 'authenticated');
      
      if (!isConnected) {
        showAlert('Debe conectar WhatsApp primero', 'warning', 'Conexión requerida');
        return;
      }
      
      // If authenticated but not ready, show info message
      if (!status.isReady && (status.status === 'authenticated' || status.connectionState === 'authenticated')) {
        showAlert('WhatsApp está autenticado y sincronizando. El botón de envío se habilitará automáticamente cuando esté listo.', 'info', 'Sincronización en proceso');
      }
    } catch (e) {
      showAlert('Error al verificar estado de conexión', 'error');
      return;
    }
  }

  // Initialize QR only when showing link tab and not connected
  if (tabName === 'link') {
    try {
      const res = await authFetch(CONFIG.statusEndpoint);
      const status = await res.json();
      if (!status.isReady) {
        initializeQR(); // Solo cargar QR si no está conectado
      }
    } catch (e) {
      initializeQR(); // En caso de error, asumir que no está conectado
    }
  }

  // Update tab buttons
  document.querySelectorAll('.tab-nav-btn').forEach(btn => {
    btn.classList.remove('active');
    if (btn.getAttribute('data-tab') === tabName) {
      btn.classList.add('active');
    }
  });
  
  // Update tab content
  document.querySelectorAll('.tab-pane').forEach(content => {
    content.classList.remove('active');
    if (content.id === tabName) {
      content.classList.add('active');
    }
  });
  
  // Reinitialize interactive components when showing send tab
  if (tabName === 'send') {
    // Small delay to ensure DOM is ready
    setTimeout(() => {
      setupVariablesSystem();
      setupEmojiPicker();
    }, 100);
  }
  
  // Update URL hash
  window.location.hash = tabName;
}

/** ======== QR Code Management ======== */
let qrInitialized = false;

function initializeQR() {
  if (qrInitialized) return;
  
  const qrImage = document.getElementById('qrImage');
  if (qrImage) {
    // Usar QR específico del usuario
    const userId = currentUser.id || 'default';
    qrImage.src = `/qr-${userId}.png?t=${Date.now()}`;
    qrInitialized = true;
    logDebug('QR inicializado para usuario:', userId);
  }
}

async function refreshQR() {
  const refreshBtn = document.getElementById('refreshQrBtn');
  const qrImage = document.getElementById('qrImage');
  
  if (refreshBtn) {
    refreshBtn.disabled = true;
    refreshBtn.innerHTML = '<span class="spinner-border spinner-border-sm me-2"></span>Refrescando...';
  }
  
  try {
    const response = await authFetch('/refresh-qr', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    });
    const result = await response.json();
    
    if (result.success) {
      showAlert('Código QR actualizado', 'success', 'QR Refrescado');
      // Wait a bit for the QR to be generated and then refresh the image
      setTimeout(() => {
        if (qrImage) {
          // Usar la URL específica del usuario que devuelve el servidor
          const qrUrl = result.qrUrl || `/qr-${currentUser.id}.png`;
          qrImage.src = `${qrUrl}?t=${Date.now()}`;
          logDebug('QR refrescado manualmente para usuario:', currentUser.id);
        }
      }, 1000);
    } else {
      showAlert(result.message || 'No se pudo refrescar el QR', 'warning', 'Error QR');
    }
  } catch (error) {
    console.error('Error al actualizar QR:', error);
    showAlert('Error al solicitar nuevo código QR', 'error', 'Error QR');
  } finally {
    if (refreshBtn) {
      refreshBtn.disabled = false;
      refreshBtn.innerHTML = '<i class="bi bi-arrow-clockwise"></i><span>Refrescar código</span>';
    }
  }
}

/** ======== Connection Status Management ======== */
let isCurrentlyConnected = false;
let statusCheckTimer = null;

// Fallback function to fetch user info when authenticated but userInfo not provided
async function fetchUserInfoFallback() {
  try {
    // Try to get additional info from backend
    const res = await authFetch(CONFIG.statusEndpoint);
    const status = await res.json();
    
    if (status.userInfo) {
      const nick = document.getElementById('user-nickname');
      const phone = document.getElementById('user-phone');
      if (nick) nick.textContent = status.userInfo.pushname || 'Usuario de WhatsApp';
      if (phone) phone.textContent = status.userInfo.phoneNumber || '—';
    } else {
      // Show generic authenticated state
      const nick = document.getElementById('user-nickname');
      const phone = document.getElementById('user-phone');
      if (nick) nick.textContent = 'Usuario autenticado';
      if (phone) phone.textContent = 'Sincronizando datos...';
    }
  } catch (e) {
    logDebug('Error fetching user info fallback:', e);
    // Show generic authenticated state as final fallback
    const nick = document.getElementById('user-nickname');
    const phone = document.getElementById('user-phone');
    if (nick) nick.textContent = 'Usuario autenticado';
    if (phone) phone.textContent = 'Conectado';
  }
}

function updateConnectionStatus(status) {
  const statusElement = document.querySelector('#connection-status');
  const statusText = statusElement?.querySelector('.status-text');
  
  if (!statusElement || !statusText) return;

  const isConnected = status && (status.isReady === true || status.status === 'authenticated' || status.connectionState === 'authenticated');
  const isFullyReady = status && status.isReady === true;

  if (isConnected) {
    statusElement.classList.add('connected');
    
    if (isFullyReady) {
      const userInfo = status.userInfo || {};
      const phoneNumber = userInfo.phoneNumber || '';
      
      statusText.innerHTML = `
        <div>WhatsApp Conectado</div>
        ${phoneNumber ? `<small style="opacity: 0.8;">Tel: ${phoneNumber}</small>` : ''}
      `;
      
      if (!isCurrentlyConnected) {
        showAlert(`¡WhatsApp conectado exitosamente!`, 'success', 'Conexión establecida');
        // Auto-switch to send tab after successful connection
        setTimeout(() => showTab('send'), 1500);
      }
      isCurrentlyConnected = true;
    } else {
      statusText.innerHTML = `
        <div>Autenticando WhatsApp...</div>
        <small style="opacity: 0.8;">Sincronizando</small>
      `;
      isCurrentlyConnected = false; // No considerar completamente conectado hasta que isReady sea true
    }
  } else {
    statusElement.classList.remove('connected');
    statusText.innerHTML = `
      <div>WhatsApp Desconectado</div>
      <small style="opacity: 0.8;">Escanear QR</small>
    `;
    isCurrentlyConnected = false;
  }
}

function updateSendButtonState(isReady, status) {
  const sendBtn = document.getElementById('sendMessageBtn');
  const btnText = sendBtn?.querySelector('.btn-text');
  const sendTabDescription = document.getElementById('sendTabDescription');
  const connectionDescription = document.getElementById('connectionDescription');
  
  logDebug('Actualizando estado del botón de envío:', { isReady, status, sendBtn: !!sendBtn, btnText: !!btnText });
  
  if (!sendBtn || !btnText) {
    logDebug('Botón de envío no encontrado en el DOM');
    return;
  }
  
  if (isReady) {
    sendBtn.disabled = false;
    sendBtn.classList.remove('disabled');
    btnText.textContent = 'Enviar mensajes';
    if (sendTabDescription) sendTabDescription.textContent = 'Configurar y enviar';
    if (connectionDescription) connectionDescription.textContent = 'Tu WhatsApp está vinculado y listo para enviar mensajes';
    logDebug('Botón habilitado para envío');
  } else if (status && (status.status === 'authenticated' || status.connectionState === 'authenticated')) {
    sendBtn.disabled = true;
    sendBtn.classList.add('disabled');
    btnText.textContent = 'Sincronizando...';
    if (sendTabDescription) sendTabDescription.textContent = 'Sincronizando datos...';
    if (connectionDescription) connectionDescription.textContent = 'WhatsApp autenticado, sincronizando datos para habilitar envío de mensajes';
    logDebug('Botón en estado de sincronización');
  } else {
    sendBtn.disabled = true;
    sendBtn.classList.add('disabled');
    btnText.textContent = 'Conectar WhatsApp primero';
    if (sendTabDescription) sendTabDescription.textContent = 'Conectar primero';
    if (connectionDescription) connectionDescription.textContent = 'Conecta tu WhatsApp para comenzar';
    logDebug('Botón deshabilitado - no conectado');
  }
}

function updateInterface(status) {
  logDebug('Actualizando interfaz con estado:', status);
  
  updateConnectionStatus(status);
  
  const qrContainer = document.getElementById('qr-container');
  const authMessage = document.getElementById('authenticated-message');

  if (!qrContainer || !authMessage) {
    logDebug('Elementos críticos de UI no encontrados');
    return;
  }

  // Check if authenticated (either ready or authenticated state)
  const isConnected = status && (status.isReady === true || status.status === 'authenticated' || status.connectionState === 'authenticated');
  const isFullyReady = status && status.isReady === true;

  if (isConnected) {
    // Connected state (authenticated or ready)
    qrContainer.classList.add('d-none');
    authMessage.classList.remove('d-none');

    // Update user info
    if (status.userInfo) {
      const nick = document.getElementById('user-nickname');
      const phone = document.getElementById('user-phone');
      if (nick) nick.textContent = status.userInfo.pushname || 'Usuario de WhatsApp';
      if (phone) phone.textContent = status.userInfo.phoneNumber || '—';
    } else if (status.status === 'authenticated') {
      // Show generic info when authenticated but no user details yet
      const nick = document.getElementById('user-nickname');
      const phone = document.getElementById('user-phone');
      if (nick) nick.textContent = 'Usuario autenticado';
      if (phone) phone.textContent = 'Esperando sincronización...';
    }

    // Update stats
    updateHeroStats(status);
    
    // Update send button state
    updateSendButtonState(isFullyReady, status);
    
    // Enable send tab navigation when authenticated (even if not fully ready)
    const sendTabBtn = document.querySelector('[data-tab="send"]');
    if (sendTabBtn) {
      sendTabBtn.classList.remove('disabled');
    }
  } else {
    // Disconnected state
    qrContainer.classList.remove('d-none');
    authMessage.classList.add('d-none');

    // Update send button state for disconnected
    updateSendButtonState(false, status);

    // Disable send tab navigation
    const sendTabBtn = document.querySelector('[data-tab="send"]');
    if (sendTabBtn) {
      sendTabBtn.classList.add('disabled');
    }

    // NO refrescar automáticamente el QR - solo cuando el usuario lo solicite
    // La imagen del QR se carga inicialmente y solo se actualiza manualmente
  }

  // Alert for inactivity (optional)
  if (status?.isReady && status?.lastActivity) {
    const inactivitySecs = Math.round((Date.now() - new Date(status.lastActivity).getTime()) / 1000);
    if (inactivitySecs > 1800) {
      showAlert('La conexión ha estado inactiva por mucho tiempo. Considere reiniciarla.', 'warning');
    }
  }
}

function updateHeroStats(status) {
  // Update hero section stats with real data
  const totalSentToday = document.getElementById('totalSentToday');
  const successRate = document.getElementById('successRate');
  const avgSpeed = document.getElementById('avgSpeed');

  if (totalSentToday && status.stats?.sentToday !== undefined) {
    animateNumber(totalSentToday, parseInt(totalSentToday.textContent) || 0, status.stats.sentToday);
  }
  
  if (successRate && status.stats?.successRate !== undefined) {
    successRate.textContent = `${status.stats.successRate}%`;
  }
  
  if (avgSpeed && status.stats?.avgSpeed !== undefined) {
    avgSpeed.textContent = `${status.stats.avgSpeed}s`;
  }
}

function animateNumber(element, start, end, duration = 1000) {
  const range = end - start;
  const increment = range / (duration / 16);
  let current = start;
  
  const timer = setInterval(() => {
    current += increment;
    if ((increment > 0 && current >= end) || (increment < 0 && current <= end)) {
      current = end;
      clearInterval(timer);
    }
    element.textContent = Math.floor(current).toLocaleString();
  }, 16);
}

// Variables para calcular velocidad en tiempo real
let lastSentCount = 0;
let lastUpdateTime = Date.now();
let speedHistory = [];

function calculateRealTimeSpeed(currentSent, total) {
  const now = Date.now();
  const timeDiff = (now - lastUpdateTime) / 1000; // segundos
  
  if (timeDiff > 0 && currentSent > lastSentCount) {
    const messagesSent = currentSent - lastSentCount;
    const currentSpeed = messagesSent / timeDiff;
    
    // Mantener historial de velocidades para suavizar
    speedHistory.push(currentSpeed);
    if (speedHistory.length > 10) {
      speedHistory.shift(); // Mantener solo los últimos 10 valores
    }
    
    // Promedio de velocidades para suavizar fluctuaciones
    const avgSpeed = speedHistory.reduce((sum, speed) => sum + speed, 0) / speedHistory.length;
    
    lastSentCount = currentSent;
    lastUpdateTime = now;
    
    return Math.round(avgSpeed * 60); // mensajes por minuto
  }
  
  // Si no hay cambios, devolver la velocidad promedio histórica
  if (speedHistory.length > 0) {
    const avgSpeed = speedHistory.reduce((sum, speed) => sum + speed, 0) / speedHistory.length;
    return Math.round(avgSpeed * 60);
  }
  
  return 0;
}

let statusCheckPromise = null;

async function checkStatus() {
  // Evitar múltiples llamadas concurrentes
  if (statusCheckPromise) {
    return statusCheckPromise;
  }
  
  statusCheckPromise = performStatusCheck();
  const result = await statusCheckPromise;
  statusCheckPromise = null;
  return result;
}

async function performStatusCheck() {
  try {
    console.log('🔄 Realizando status check...');
    console.log('🔐 Estado de autenticación:', {
      keycloakExists: !!keycloak,
      isAuthenticated: keycloak?.authenticated,
      hasToken: !!keycloak?.token,
      tokenLength: keycloak?.token?.length || 0
    });
    
    const url = `${CONFIG.statusEndpoint}?t=${Date.now()}`;
    console.log('📡 Enviando petición a:', url);
    
    const res = await authFetch(url);
    
    console.log('📨 Respuesta recibida:', {
      status: res.status,
      ok: res.ok,
      headers: Object.fromEntries(res.headers.entries())
    });
    
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const status = await res.json();
    
    console.log('✅ Status obtenido:', status);
    updateInterface(status);
    return status;
  } catch (e) {
    console.error('❌ Status check error:', e);
    return null;
  }
}

function startStatusCheck() {
  // Initial check
  setTimeout(async () => {
    await checkStatus();
    // Set up interval
    statusCheckTimer = setInterval(checkStatus, CONFIG.checkInterval);
  }, 500);
}

/** ======== Message Form Management ======== */
let currentMessageType = 'none';

function setupMessageTypeHandlers() {
  const messageTypeInputs = document.querySelectorAll('input[name="messageType"]');
  
  messageTypeInputs.forEach(input => {
    input.addEventListener('change', (e) => {
      currentMessageType = e.target.value;
      toggleMediaSections(currentMessageType);
    });
  });

  // Initialize with default
  toggleMediaSections(currentMessageType);
}

function toggleMediaSections(type) {
  const sections = {
    'singleImageSection': type === 'single',
    'multipleImagesSection': type === 'multiple',
    'audioSection': type === 'audio'
  };

  Object.entries(sections).forEach(([sectionId, shouldShow]) => {
    const section = document.getElementById(sectionId);
    if (section) {
      if (shouldShow) {
        section.classList.remove('d-none');
      } else {
        section.classList.add('d-none');
      }
    }
  });

  // Clear file inputs when switching types
  if (type !== 'single') clearFileInput('singleImage');
  if (type !== 'multiple') clearFileInput('images');
  if (type !== 'audio') clearFileInput('audioFile');
}

function clearFileInput(inputId) {
  const input = document.getElementById(inputId);
  if (input) {
    input.value = '';
    updateFileInfo(inputId, null);
  }
}

function updateFileInfo(inputId, files) {
  const infoId = inputId + 'Info';
  const infoElement = document.getElementById(infoId);
  
  if (!infoElement) return;

  if (!files || files.length === 0) {
    infoElement.classList.remove('show');
    return;
  }

  let infoContent = '';
  Array.from(files).forEach(file => {
    const sizeStr = formatFileSize(file.size);
    infoContent += `
      <div class="file-info-item">
        <span class="file-name">${file.name}</span>
        <span class="file-size">${sizeStr}</span>
      </div>
    `;
  });

  infoElement.innerHTML = infoContent;
  infoElement.classList.add('show');
}

function formatFileSize(bytes) {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

function setupFileInputHandlers() {
  const fileInputs = ['csvFile', 'singleImage', 'images', 'audioFile'];
  
  fileInputs.forEach(inputId => {
    const input = document.getElementById(inputId);
    if (input) {
      input.addEventListener('change', (e) => {
        updateFileInfo(inputId, e.target.files);
      });
    }
  });
}

function updateCharacterCount() {
  const textarea = document.getElementById('message');
  const charCount = document.getElementById('charCount');
  
  if (textarea && charCount) {
    const length = textarea.value.length;
    charCount.textContent = length;
    
    // Color coding for character limit
    if (length > 3500) {
      charCount.style.color = 'var(--error-500)';
    } else if (length > 3000) {
      charCount.style.color = 'var(--warning-500)';
    } else {
      charCount.style.color = 'var(--text-tertiary)';
    }
  }
}

function setupMessageTextarea() {
  const textarea = document.getElementById('message');
  
  if (textarea) {
    // Solo agregar el listener de character count, no input
    // El highlighting se maneja en setupVariablesSystem
    textarea.addEventListener('input', updateCharacterCount);
    // Initialize character count
    updateCharacterCount();
  }
}

/** ======== Emoji Picker ======== */
const emojiCategories = {
  smileys: ['😀', '😃', '😄', '😁', '😆', '😅', '🤣', '😂', '🙂', '🙃', '🫠', '😉', '😊', '😇', '🥰', '😍', '🤩', '😘', '😗', '☺️', '😚', '😙', '🥲', '😋', '😛', '😜', '🤪', '😝', '🤑', '🤗', '🤭', '🫢', '🫣', '🤫', '🤔', '🫡', '🤐', '🤨', '😐', '😑', '😶', '🫥', '😶‍🌫️', '😏', '😒', '🙄', '😬', '😮‍💨', '🤥', '😔', '😪', '🤤', '😴', '😷', '🤒', '🤕', '🤢', '🤮', '🤧', '🥵', '🥶', '🥴', '😵', '😵‍💫', '🤯', '🤠', '🥳', '🥸', '😎', '🤓', '🧐'],
  people: ['👋', '🤚', '🖐️', '✋', '🖖', '🫱', '🫲', '🫳', '🫴', '👌', '🤌', '🤏', '✌️', '🤞', '🫰', '🤟', '🤘', '🤙', '👈', '👉', '👆', '🖕', '👇', '☝️', '🫵', '👍', '👎', '👊', '✊', '🤛', '🤜', '👏', '🙌', '🫶', '👐', '🤲', '🤝', '🙏', '✍️', '💅', '🤳', '💪', '🦾', '🦿', '🦵', '🦶', '👂', '🦻', '👃', '🧠', '🫀', '🫁', '🦷', '🦴', '👀', '👁️', '👅', '👄', '🫦', '👶', '🧒', '👦', '👧', '🧑', '👱', '👨', '🧔', '🧔‍♂️', '🧔‍♀️', '👨‍🦰', '👨‍🦱', '👨‍🦳', '👨‍🦲', '👩', '👩‍🦰', '🧑‍🦰', '👩‍🦱', '🧑‍🦱', '👩‍🦳', '🧑‍🦳', '👩‍🦲', '🧑‍🦲', '👱‍♀️', '👱‍♂️'],
  nature: ['🐶', '🐱', '🐭', '🐹', '🐰', '🦊', '🐻', '🐼', '🐻‍❄️', '🐨', '🐯', '🦁', '🐮', '🐷', '🐽', '🐸', '🐵', '🙈', '🙉', '🙊', '🐒', '🐔', '🐧', '🐦', '🐤', '🐣', '🐥', '🦆', '🦅', '🦉', '🦇', '🐺', '🐗', '🐴', '🦄', '🐝', '🪱', '🐛', '🦋', '🐌', '🐞', '🐜', '🪰', '🪲', '🪳', '🦟', '🦗', '🕷️', '🕸️', '🦂', '🐢', '🐍', '🦎', '🦖', '🦕', '🐙', '🦑', '🦐', '🦞', '🦀', '🐡', '🐠', '🐟', '🐕', '🐩', '🦮', '🐕‍🦺', '🐈', '🐈‍⬛', '🪶', '🐓', '🦃', '🦤', '🦚', '🦜', '🦢', '🦩', '🕊️', '🐇', '🦝', '🦨', '🦡', '🦫', '🦦', '🦘', '🦬', '🐃', '🐂', '🐄', '🐎', '🐖', '🐏', '🐑', '🦙', '🐐', '🦌', '🐕', '🐩', '🦮', '🐕‍🦺', '🐈', '🐈‍⬛'],
  food: ['🍎', '🍐', '🍊', '🍋', '🍌', '🍉', '🍇', '🍓', '🫐', '🍈', '🍒', '🍑', '🥭', '🍍', '🥥', '🥝', '🍅', '🍆', '🥑', '🥦', '🥬', '🥒', '🌶️', '🫑', '🌽', '🥕', '🫒', '🧄', '🧅', '🥔', '🍠', '🥐', '🥯', '🍞', '🥖', '🥨', '🧀', '🥚', '🍳', '🧈', '🥞', '🧇', '🥓', '🥩', '🍗', '🍖', '🦴', '🌭', '🍔', '🍟', '🍕', '🫓', '🥪', '🥙', '🧆', '🌮', '🌯', '🫔', '🥗', '🥘', '🫕', '🥫', '🍝', '🍜', '🍲', '🍛', '🍣', '🍱', '🥟', '🦪', '🍤', '🍙', '🍚', '🍘', '🍥', '🥠', '🥮', '🍢', '🍡', '🍧', '🍨', '🍦', '🥧', '🧁', '🍰', '🎂', '🍮', '🍭', '🍬', '🍫', '🍿', '🍩', '🍪', '🌰', '🥜', '🍯'],
  activities: ['⚽', '🏀', '🏈', '⚾', '🥎', '🎾', '🏐', '🏉', '🥏', '🎱', '🪀', '🏓', '🏸', '🏒', '🏑', '🥍', '🏏', '🪃', '🥅', '⛳', '🪁', '🏹', '🎣', '🤿', '🥊', '🥋', '🎽', '🛹', '🛼', '🛷', '⛸️', '🥌', '🎿', '⛷️', '🏂', '🪂', '🏋️‍♀️', '🏋️', '🏋️‍♂️', '🤼‍♀️', '🤼', '🤼‍♂️', '🤸‍♀️', '🤸', '🤸‍♂️', '⛹️‍♀️', '⛹️', '⛹️‍♂️', '🤺', '🤾‍♀️', '🤾', '🤾‍♂️', '🏌️‍♀️', '🏌️', '🏌️‍♂️', '🏇', '🧘‍♀️', '🧘', '🧘‍♂️', '🏄‍♀️', '🏄', '🏄‍♂️', '🏊‍♀️', '🏊', '🏊‍♂️', '🤽‍♀️', '🤽', '🤽‍♂️', '🚣‍♀️', '🚣', '🚣‍♂️', '🧗‍♀️', '🧗', '🧗‍♂️', '🚵‍♀️', '🚵', '🚵‍♂️', '🚴‍♀️', '🚴', '🚴‍♂️', '🏆', '🥇', '🥈', '🥉', '🏅', '🎖️', '🏵️', '🎗️', '🎫', '🎟️', '🎪', '🤹', '🤹‍♂️', '🤹‍♀️', '🎭', '🩰', '🎨', '🎬', '🎤', '🎧', '🎼', '🎵', '🎶', '🪘', '🥁', '🪗', '🎹', '🎷', '🎺', '🪕', '🎸', '🪈', '🎻', '🎲', '♟️', '🎯', '🎳', '🎮', '🎰', '🧩'],
  travel: ['🚗', '🚕', '🚙', '🚌', '🚎', '🏎️', '🚓', '🚑', '🚒', '🚐', '🛻', '🚚', '🚛', '🚜', '🏍️', '🛵', '🚲', '🛴', '🛹', '🛼', '🚁', '🛸', '✈️', '🛩️', '🛫', '🛬', '🪂', '💺', '🚀', '🛰️', '🚉', '🚞', '🚝', '🚄', '🚅', '🚈', '🚂', '🚆', '🚇', '🚊', '🚉', '✈️', '🛩️', '🛫', '🛬', '🛰️', '🚀', '🛸', '🚁', '🛶', '⛵', '🚤', '🛥️', '🛳️', '⛴️', '🚢', '⚓', '🪝', '⛽', '🚧', '🚨', '🚥', '🚦', '🛑', '🚏', '🗺️', '🗿', '🗽', '🗼', '🏰', '🏯', '🏟️', '🎡', '🎢', '🎠', '⛲', '⛱️', '🏖️', '🏝️', '🏜️', '🌋', '⛰️', '🏔️', '🗻', '🏕️', '⛺', '🛖', '🏠', '🏡', '🏘️', '🏚️', '🏗️', '🏭', '🏢', '🏬', '🏣', '🏤', '🏥', '🏦', '🏨', '🏪', '🏫', '🏩', '💒', '🏛️', '⛪', '🕌', '🛕', '🕍', '🕊️', '🏞️', '🏜️', '🏝️', '🏖️'],
  objects: ['⌚', '📱', '📲', '💻', '⌨️', '🖥️', '🖨️', '🖱️', '🖲️', '🕹️', '🗜️', '💽', '💾', '💿', '📀', '📼', '📷', '📸', '📹', '🎥', '📽️', '🎞️', '📞', '☎️', '📟', '📠', '📺', '📻', '🎙️', '🎚️', '🎛️', '🧭', '⏱️', '⏲️', '⏰', '🕰️', '⌛', '⏳', '📡', '🔋', '🪫', '🔌', '💡', '🔦', '🕯️', '🪔', '🧯', '🛢️', '💸', '💵', '💴', '💶', '💷', '🪙', '💰', '💳', '💎', '⚖️', '🪜', '🧰', '🔧', '🔨', '⚒️', '🛠️', '⛏️', '🪚', '🔩', '⚙️', '🪤', '🧱', '⛓️', '🧲', '🔫', '💣', '🧨', '🪓', '🔪', '🗡️', '⚔️', '🛡️', '🚬', '⚰️', '🪦', '⚱️', '🏺', '🔮', '📿', '🧿', '💈', '⚗️', '🔭', '🔬', '🕳️', '🩹', '🩺', '💊', '💉', '🩸', '🧬', '🦠', '🧫', '🧪', '🌡️', '🧹', '🪠', '🧽', '🧴', '🛎️', '🔑', '🗝️', '🚪', '🪑', '🛏️', '🛋️', '🪞', '🚿', '🛁', '🚽', '🪤', '🪒', '🧴', '🧷', '🧹', '🧺', '🧻', '🪣', '🧼', '🪥', '🧽', '🧯', '🛒'],
  symbols: ['❤️', '🧡', '💛', '💚', '💙', '💜', '🖤', '🤍', '🤎', '💔', '❣️', '💕', '💞', '💓', '💗', '💖', '💘', '💝', '💟', '☮️', '✝️', '☪️', '🕉️', '☸️', '✡️', '🔯', '🕎', '☯️', '☦️', '🛐', '⛎', '♈', '♉', '♊', '♋', '♌', '♍', '♎', '♏', '♐', '♑', '♒', '♓', '🆔', '⚛️', '🉑', '☢️', '☣️', '📴', '📳', '🈶', '🈚', '🈸', '🈺', '🈷️', '✴️', '🆚', '💮', '🉐', '㊙️', '㊗️', '🈴', '🈵', '🈹', '🈲', '🅰️', '🅱️', '🆎', '🆑', '🅾️', '🆘', '❌', '⭕', '🛑', '⛔', '📛', '🚫', '💯', '💢', '♨️', '🚷', '🚯', '🚳', '🚱', '🔞', '📵', '🚭', '❗', '❕', '❓', '❔', '‼️', '⁉️', '🔅', '🔆', '〽️', '⚠️', '🚸', '🔱', '⚜️', '🔰', '♻️', '✅', '🈯', '💹', '❇️', '✳️', '❎', '🌐', '💠', 'Ⓜ️', '🌀', '💤', '🏧', '🚾', '♿', '🅿️', '🛗', '🈳', '🈂️', '🛂', '🛃', '🛄', '🛅', '🚹', '🚺', '🚼', '⚧️', '🚻', '🚮', '🎦', '📶', '🈁', '🔣', 'ℹ️', '🔤', '🔡', '🔠', '🆖', '🆗', '🆙', '🆒', '🆕', '🆓', '0️⃣', '1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟'],
  flags: ['🏁', '🚩', '🎌', '🏴', '🏳️', '🏳️‍🌈', '🏳️‍⚧️', '🏴‍☠️', '🇦🇨', '🇦🇩', '🇦🇪', '🇦🇫', '🇦🇬', '🇦🇮', '🇦🇱', '🇦🇲', '🇦🇴', '🇦🇶', '🇦🇷', '🇦🇸', '🇦🇹', '🇦🇺', '🇦🇼', '🇦🇽', '🇦🇿', '🇧🇦', '🇧🇧', '🇧🇩', '🇧🇪', '🇧🇫', '🇧🇬', '🇧🇭', '🇧🇮', '🇧🇯', '🇧🇱', '🇧🇲', '🇧🇳', '🇧🇴', '🇧🇶', '🇧🇷', '🇧🇸', '🇧🇹', '🇧🇻', '🇧🇼', '🇧🇾', '🇧🇿', '🇨🇦', '🇨🇨', '🇨🇩', '🇨🇫', '🇨🇬', '🇨🇭', '🇨🇮', '🇨🇰', '🇨🇱', '🇨🇲', '🇨🇳', '🇨🇴', '🇨🇵', '🇨🇷', '🇨🇺', '🇨🇻', '🇨🇼', '🇨🇽', '🇨🇾', '🇨🇿', '🇩🇪', '🇩🇬', '🇩🇯', '🇩🇰', '🇩🇲', '🇩🇴', '🇩🇿', '🇪🇦', '🇪🇨', '🇪🇪', '🇪🇬', '🇪🇭', '🇪🇷', '🇪🇸', '🇪🇹', '🇪🇺', '🇫🇮', '🇫🇯', '🇫🇰', '🇫🇲', '🇫🇴', '🇫🇷', '🇬🇦', '🇬🇧', '🇬🇩', '🇬🇪', '🇬🇫', '🇬🇬', '🇬🇭', '🇬🇮', '🇬🇱', '🇬🇲', '🇬🇳', '🇬🇵', '🇬🇶', '🇬🇷', '🇬🇸', '🇬🇹', '🇬🇺', '🇬🇼', '🇬🇾', '🇭🇰', '🇭🇲', '🇭🇳', '🇭🇷', '🇭🇹', '🇭🇺', '🇮🇨', '🇮🇩', '🇮🇪', '🇮🇱', '🇮🇲', '🇮🇳', '🇮🇴', '🇮🇶', '🇮🇷', '🇮🇸', '🇮🇹', '🇯🇪', '🇯🇲', '🇯🇴', '🇯🇵', '🇰🇪', '🇰🇬', '🇰🇭', '🇰🇮', '🇰🇲', '🇰🇳', '🇰🇵', '🇰🇷', '🇰🇼', '🇰🇾', '🇰🇿', '🇱🇦', '🇱🇧', '🇱🇨', '🇱🇮', '🇱🇰', '🇱🇷', '🇱🇸', '🇱🇹', '🇱🇺', '🇱🇻', '🇱🇾', '🇲🇦', '🇲🇨', '🇲🇩', '🇲🇪', '🇲🇫', '🇲🇬', '🇲🇭', '🇲🇰', '🇲🇱', '🇲🇲', '🇲🇳', '🇲🇴', '🇲🇵', '🇲🇶', '🇲🇷', '🇲🇸', '🇲🇹', '🇲🇺', '🇲🇻', '🇲🇼', '🇲🇽', '🇲🇾', '🇲🇿', '🇳🇦', '🇳🇨', '🇳🇪', '🇳🇫', '🇳🇬', '🇳🇮', '🇳🇱', '🇳🇴', '🇳🇵', '🇳🇷', '🇳🇺', '🇳🇿', '🇴🇲', '🇵🇦', '🇵🇪', '🇵🇫', '🇵🇬', '🇵🇭', '🇵🇰', '🇵🇱', '🇵🇲', '🇵🇳', '🇵🇷', '🇵🇸', '🇵🇹', '🇵🇼', '🇵🇾', '🇶🇦', '🇷🇪', '🇷🇴', '🇷🇸', '🇷🇺', '🇷🇼', '🇸🇦', '🇸🇧', '🇸🇨', '🇸🇩', '🇸🇪', '🇸🇬', '🇸🇭', '🇸🇮', '🇸🇯', '🇸🇰', '🇸🇱', '🇸🇲', '🇸🇳', '🇸🇴', '🇸🇷', '🇸🇸', '🇸🇹', '🇸🇻', '🇸🇽', '🇸🇾', '🇸🇿', '🇹🇦', '🇹🇨', '🇹🇩', '🇹🇫', '🇹🇬', '🇹🇭', '🇹🇯', '🇹🇰', '🇹🇱', '🇹🇲', '🇹🇳', '🇹🇴', '🇹🇷', '🇹🇹', '🇹🇻', '🇹🇼', '🇹🇿', '🇺🇦', '🇺🇬', '🇺🇲', '🇺🇳', '🇺🇸', '🇺🇾', '🇺🇿', '🇻🇦', '🇻🇨', '🇻🇪', '🇻🇬', '🇻🇮', '🇻🇳', '🇻🇺', '🇼🇫', '🇼🇸', '🇽🇰', '🇾🇪', '🇾🇹', '🇿🇦', '🇿🇲', '🇿🇼', '🏴󠁧󠁢󠁥󠁮󠁧󠁿', '🏴󠁧󠁢󠁳󠁣󠁴󠁿', '🏴󠁧󠁢󠁷󠁬󠁳󠁿']
};

let currentEmojiCategory = 'smileys';
let emojiSystemInitialized = false;

function setupEmojiPicker() {
  // Evitar inicialización múltiple
  if (emojiSystemInitialized) {
    return;
  }
  
  const emojiBtn = document.getElementById('emojiBtn');
  const emojiPicker = document.getElementById('emojiPicker');
  const emojiGrid = document.getElementById('emojiGrid');
  const textarea = document.getElementById('message');
  
  if (!emojiBtn || !emojiPicker || !emojiGrid || !textarea) {
    return;
  }
  
  // Marcar como inicializado
  emojiSystemInitialized = true;
  
  // Toggle emoji picker
  emojiBtn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    emojiPicker.classList.toggle('d-none');
    if (!emojiPicker.classList.contains('d-none')) {
      populateEmojis(currentEmojiCategory);
    }
  });
  
  // Close picker when clicking outside
  document.addEventListener('click', (e) => {
    if (!emojiPicker.contains(e.target) && !emojiBtn.contains(e.target)) {
      emojiPicker.classList.add('d-none');
    }
  });
  
  // Category buttons
  const categoryButtons = emojiPicker.querySelectorAll('.emoji-category');
  categoryButtons.forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      const category = btn.getAttribute('data-category');
      
      // Update active category
      categoryButtons.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      
      currentEmojiCategory = category;
      populateEmojis(category);
    });
  });
  
  function populateEmojis(category) {
    const emojis = emojiCategories[category] || emojiCategories.smileys;
    emojiGrid.innerHTML = '';
    
    emojis.forEach(emoji => {
      const emojiBtn = document.createElement('button');
      emojiBtn.className = 'emoji-item';
      emojiBtn.textContent = emoji;
      emojiBtn.type = 'button';
      
      emojiBtn.addEventListener('click', (e) => {
        e.preventDefault();
        insertEmoji(emoji);
      });
      
      emojiGrid.appendChild(emojiBtn);
    });
  }
  
  function insertEmoji(emoji) {
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const text = textarea.value;
    
    // Insert emoji at cursor position
    const newText = text.substring(0, start) + emoji + text.substring(end);
    textarea.value = newText;
    
    // Update cursor position
    const newCursorPos = start + emoji.length;
    textarea.setSelectionRange(newCursorPos, newCursorPos);
    
    // Focus back to textarea
    textarea.focus();
    
    // Trigger input event to update character count
    textarea.dispatchEvent(new Event('input'));
    
    // Close picker after selection
    emojiPicker.classList.add('d-none');
  }
  
  // Initialize with default category
  populateEmojis(currentEmojiCategory);
}

/** ======== Message Status & Progress ======== */
let messageProgressPoll = null;

function updateMessageStatus(status) {
  const { sent, total, errors, messages, completed, speed } = status || {};

  // Update progress bar with smooth animation
  const progress = total > 0 ? Math.round((sent / total) * 100) : 0;
  const progressFill = document.querySelector('.progress-fill');
  const progressPercentage = document.querySelector('.progress-percentage');
  
  if (progressFill) {
    // Add active class during sending for faster animation
    if (!completed && total > 0) {
      progressFill.classList.add('active');
    } else {
      progressFill.classList.remove('active');
    }
    
    progressFill.style.width = `${progress}%`;
  }
  if (progressPercentage) {
    progressPercentage.textContent = `${progress}%`;
  }

  // Update stat cards with smooth number animation
  updateStatCard('totalCount', total || 0);
  updateStatCard('sentCount', sent || 0);
  updateStatCard('errorCount', errors || 0);
  
  // Calculate and display real-time speed
  const currentSpeed = calculateRealTimeSpeed(sent, total);
  updateStatCard('currentSpeed', currentSpeed);

  // Update status table
  updateStatusTable(messages || []);

  // Handle completion
  if (completed) {
    stopProgressPolling();
    const sendBtn = document.getElementById('sendMessageBtn');
    if (sendBtn) {
      sendBtn.classList.remove('loading');
      sendBtn.disabled = false;
    }
    
    // Add success animation to progress bar
    if (progressFill && (errors || 0) === 0) {
      progressFill.classList.add('success');
      setTimeout(() => {
        progressFill.classList.remove('success');
      }, 3000);
    }
    
    if ((errors || 0) === 0) {
      showAlert('Todos los mensajes fueron enviados exitosamente', 'success', 'Envío completado');
    } else {
      showAlert(`Envío completado con ${errors} errores`, 'warning', 'Envío completado');
    }
  }
}

function updateStatCard(statId, value) {
  const element = document.getElementById(statId);
  if (element) {
    const currentValue = parseInt(element.textContent) || 0;
    // Animación más rápida durante envío activo para mejor respuesta
    animateNumber(element, currentValue, value, 300);
  }
}

function updateStatusTable(messages) {
  const tbody = document.getElementById('statusTableBody');
  if (!tbody || !Array.isArray(messages)) return;

  // Clear existing rows if needed
  messages.forEach(message => {
    const key = String(message.number);
    let row = tbody.querySelector(`[data-number="${key}"]`);
    
    if (!row) {
      row = document.createElement('tr');
      row.setAttribute('data-number', key);
      tbody.appendChild(row);
    }

    const badgeClass = {
      'queued': 'badge-queued',
      'sending': 'badge-sending',
      'sent': 'badge-sent',
      'error': 'badge-error'
    }[message.status] || 'badge-queued';

    const timestamp = message.timestamp ? 
      new Date(message.timestamp).toLocaleTimeString() : '—';

    row.innerHTML = `
      <td>${message.number}</td>
      <td><span class="status-badge ${badgeClass}">${message.status}</span></td>
      <td>${timestamp}</td>
      <td>${message.response || message.message || '—'}</td>
    `;

    row.className = message.status === 'error' ? 'status-row-error' : 'status-row-success';
  });
}

function startProgressPolling() {
  if (messageProgressPoll) clearInterval(messageProgressPoll);
  
  messageProgressPoll = setInterval(async () => {
    try {
      const res = await authFetch('/message-status');
      const status = await res.json();
      updateMessageStatus(status);
      
      if (status.completed) {
        stopProgressPolling();
      }
    } catch (e) {
      console.error('Progress polling error:', e);
    }
  }, 300); // Polling más frecuente para mejor respuesta (cada 300ms)
}

function stopProgressPolling() {
  if (messageProgressPoll) {
    clearInterval(messageProgressPoll);
    messageProgressPoll = null;
  }
}

/** ======== Form Submission ======== */
async function handleMessageFormSubmit(event) {
  event.preventDefault();

  // First, verify WhatsApp connection
  try {
    const statusRes = await authFetch(CONFIG.statusEndpoint);
    const currentStatus = await statusRes.json();
    if (!currentStatus.isReady) {
      showAlert('WhatsApp no está conectado. Por favor conecte primero.', 'error', 'Conexión requerida');
      showTab('link'); // Redirect to connection tab
      return;
    }
  } catch (e) {
    showAlert('Error al verificar estado de conexión', 'error');
    return;
  }

  const sendBtn = document.getElementById('sendMessageBtn');
  const messageStatus = document.getElementById('messageStatus');

  // Show progress section
  if (messageStatus) {
    messageStatus.classList.remove('d-none');
  }

  // Update button state
  if (sendBtn) {
    sendBtn.classList.add('loading');
    sendBtn.disabled = true;
  }

  // Clear previous results
  const tbody = document.getElementById('statusTableBody');
  if (tbody) tbody.innerHTML = '';

  // Reset speed calculation variables
  lastSentCount = 0;
  lastUpdateTime = Date.now();
  speedHistory = [];

  // Validate form
  const csvFile = document.getElementById('csvFile').files[0];
  if (!csvFile) {
    showAlert('Debe seleccionar un archivo CSV', 'error', 'Error de validación');
    resetFormSubmission(sendBtn);
    return;
  }

  // Validate media files based on type
  if (!validateMediaFiles()) {
    resetFormSubmission(sendBtn);
    return;
  }

  // Prepare form data
  const formData = new FormData();
  formData.append('message', document.getElementById('message').value);
  formData.append('csvFile', csvFile);
  formData.append('mode', currentMessageType);

  // Add media files
  appendMediaFiles(formData);

  try {
    const res = await authFetch('/send-messages', { 
      method: 'POST', 
      body: formData 
    });
    
    const result = await res.json();

    if (res.ok) {
      showAlert('Envío iniciado correctamente', 'success', 'Proceso iniciado');
      
      if (result.initialStats) {
        updateMessageStatus(result.initialStats);
      }
      
      // Start polling for progress
      startProgressPolling();
    } else {
      showAlert(result.error || 'Error al enviar mensajes', 'error', 'Error en envío');
      resetFormSubmission(sendBtn);
    }
  } catch (err) {
    console.error('Form submission error:', err);
    showAlert(`Error: ${err.message}`, 'error', 'Error de conexión');
    resetFormSubmission(sendBtn);
  }
}

function validateMediaFiles() {
  if (currentMessageType === 'single') {
    const singleImage = document.getElementById('singleImage').files[0];
    if (!singleImage) {
      showAlert('Debe seleccionar una imagen', 'warning', 'Archivo requerido');
      return false;
    }
  } else if (currentMessageType === 'multiple') {
    const images = document.getElementById('images').files;
    if (!images || images.length === 0) {
      showAlert('Debe seleccionar al menos una imagen', 'warning', 'Archivos requeridos');
      return false;
    }
  } else if (currentMessageType === 'audio') {
    const audioFile = document.getElementById('audioFile').files[0];
    if (!audioFile) {
      showAlert('Debe seleccionar un archivo de audio', 'warning', 'Archivo requerido');
      return false;
    }
  }
  return true;
}

function appendMediaFiles(formData) {
  if (currentMessageType === 'single') {
    const singleImage = document.getElementById('singleImage').files[0];
    if (singleImage) formData.append('singleImage', singleImage);
  } else if (currentMessageType === 'multiple') {
    const images = document.getElementById('images').files;
    for (let i = 0; i < images.length; i++) {
      formData.append('images', images[i]);
    }
  } else if (currentMessageType === 'audio') {
    const audioFile = document.getElementById('audioFile').files[0];
    if (audioFile) formData.append('audioFile', audioFile);
  }
}

function resetFormSubmission(sendBtn) {
  if (sendBtn) {
    sendBtn.classList.remove('loading');
    sendBtn.disabled = false;
  }
  stopProgressPolling();
}

/** ======== Theme Management ======== */
function setupThemeToggle() {
  const THEME_KEY = 'ms-theme';
  const root = document.documentElement;
  const switchEl = document.getElementById('themeSwitch');

  // Load saved preference or detect system
  const saved = localStorage.getItem(THEME_KEY);
  const prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
  const initial = saved || (prefersDark ? 'dark' : 'light');

  setTheme(initial);

  function setTheme(mode) {
    root.setAttribute('data-theme', mode);
    localStorage.setItem(THEME_KEY, mode);
    if (switchEl) switchEl.checked = (mode === 'dark');
  }

  // Switch listener
  if (switchEl) {
    switchEl.addEventListener('change', () => {
      setTheme(switchEl.checked ? 'dark' : 'light');
    });
  }

  // Auto-adjust if system changes and no saved preference
  if (window.matchMedia) {
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', e => {
      const current = localStorage.getItem(THEME_KEY);
      if (!current) setTheme(e.matches ? 'dark' : 'light');
    });
  }
}

/** ======== Event Listeners Setup ======== */
function setupEventListeners() {
  // Tab navigation
  document.querySelectorAll('.tab-nav-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      const tabId = btn.getAttribute('data-tab');
      if (tabId) showTab(tabId);
    });
  });

  // QR refresh button
  const refreshBtn = document.getElementById('refreshQrBtn');
  if (refreshBtn) {
    refreshBtn.addEventListener('click', refreshQR);
  }

  // Message form
  const messageForm = document.getElementById('messageForm');
  if (messageForm) {
    messageForm.addEventListener('submit', handleMessageFormSubmit);
  }

  // Export button
  const exportBtn = document.getElementById('exportBtn');
  if (exportBtn) {
    exportBtn.addEventListener('click', exportResults);
  }

  // Logout button  
  console.log('🔍 Buscando botón de logout...');
  const logoutBtn = document.getElementById('logout-btn');
  console.log('🔍 Estado del botón:', {
    exists: !!logoutBtn,
    visible: logoutBtn?.offsetParent !== null,
    disabled: logoutBtn?.disabled,
    classList: logoutBtn?.classList.toString(),
    parentElement: logoutBtn?.parentElement?.tagName
  });
  
  if (logoutBtn) {
    console.log('✅ Botón de logout encontrado, configurando event listener...');
    
    // Remover event listeners previos si existen
    logoutBtn.replaceWith(logoutBtn.cloneNode(true));
    const newLogoutBtn = document.getElementById('logout-btn');
    
    newLogoutBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      console.log('🖱️ Click en botón de logout detectado');
      console.log('🔍 Event details:', e);
      logoutKeycloak();
    });
    
    // Agregar también el event listener para debug
    newLogoutBtn.addEventListener('mousedown', () => {
      console.log('👆 Mouse down en botón de logout');
    });
    
    newLogoutBtn.addEventListener('mouseup', () => {
      console.log('👆 Mouse up en botón de logout');
    });
    
    console.log('✅ Event listeners configurados en botón de logout');
  } else {
    console.warn('⚠️ Botón de logout no encontrado en el DOM');
    console.log('🔍 Elementos disponibles con ID:', 
      Array.from(document.querySelectorAll('[id]')).map(el => el.id)
    );
  }
}

/** ======== Export Functionality ======== */
function exportResults() {
  const tbody = document.getElementById('statusTableBody');
  if (!tbody || tbody.children.length === 0) {
    showAlert('No hay datos para exportar', 'warning', 'Sin datos');
    return;
  }

  const rows = Array.from(tbody.children);
  const csvContent = [
    'Número,Estado,Hora,Respuesta',
    ...rows.map(row => {
      const cells = Array.from(row.children);
      return cells.map(cell => `"${cell.textContent.trim()}"`).join(',');
    })
  ].join('\n');

  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const link = document.createElement('a');
  const url = URL.createObjectURL(blob);
  link.setAttribute('href', url);
  link.setAttribute('download', `mensaje-resultados-${new Date().toISOString().slice(0, 10)}.csv`);
  link.style.visibility = 'hidden';
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);

  showAlert('Resultados exportados exitosamente', 'success', 'Exportación completada');
}

/** ======== Application Initialization ======== */
document.addEventListener('DOMContentLoaded', async () => {
  console.log('🚀 Iniciando aplicación...');
  
  // Initialize authentication first
  const authSuccess = await initKeycloak();
  
  if (!authSuccess) {
    console.error('❌ Falló la inicialización de Keycloak, deteniendo la carga de la aplicación');
    return;
  }
  
  console.log('✅ Keycloak inicializado correctamente, continuando con la aplicación...');
  
  // Setup all event listeners
  setupEventListeners();
  
  // Setup form handlers
  setupMessageTypeHandlers();
  setupFileInputHandlers();
  setupMessageTextarea();
  setupVariablesSystem();
  setupEmojiPicker();
  
  // Setup theme toggle
  setupThemeToggle();
  
  // Initially disable send tab until WhatsApp is connected
  const sendTabBtn = document.querySelector('[data-tab="send"]');
  if (sendTabBtn) {
    sendTabBtn.classList.add('disabled');
  }
  
  // Start status checking ONLY after successful authentication
  console.log('🔄 Iniciando verificación de estado...');
  startStatusCheck();
  
  // Initialize tab from hash
  const hash = window.location.hash.substring(1);
  if (hash && ['link', 'send', 'analytics'].includes(hash)) {
    showTab(hash);
  } else {
    showTab('link');
  }
  
  console.log('🚀 WhatsApp Sender Pro initialized successfully');
});

// Global functions for HTML onclick handlers
window.showTab = showTab;
window.refreshQR = refreshQR;

/** ======== Variables System ======== */
let variablesSystemInitialized = false;

function setupVariablesSystem() {
  // Evitar inicialización múltiple
  if (variablesSystemInitialized) {
    return;
  }
  
  const variablesBtn = document.getElementById('variablesBtn');
  const variablesHelper = document.getElementById('variablesHelper');
  const messageTextarea = document.getElementById('message');
  
  if (!variablesBtn || !variablesHelper || !messageTextarea) {
    return;
  }
  
  // Marcar como inicializado
  variablesSystemInitialized = true;
  
  // Toggle variables helper
  variablesBtn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    variablesHelper.classList.toggle('d-none');
  });
  
  // Insert variables into message
  const variableBtns = variablesHelper.querySelectorAll('.variable-btn');
  variableBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      const variable = btn.getAttribute('data-variable');
      const start = messageTextarea.selectionStart;
      const end = messageTextarea.selectionEnd;
      const text = messageTextarea.value;
      
      // Insert variable at cursor position
      const newText = text.substring(0, start) + variable + text.substring(end);
      messageTextarea.value = newText;
      
      // Update character count
      updateCharacterCount();
      
      // Set cursor position after inserted variable
      const newCursorPos = start + variable.length;
      messageTextarea.setSelectionRange(newCursorPos, newCursorPos);
      messageTextarea.focus();
      
      // Hide helper after insertion
      variablesHelper.classList.add('d-none');
    });
  });
  
  // Hide helper when clicking outside
  document.addEventListener('click', (e) => {
    if (!variablesHelper.contains(e.target) && !variablesBtn.contains(e.target)) {
      variablesHelper.classList.add('d-none');
    }
  });
}