/** ======== Configuration ======== */
const CONFIG = {
  checkInterval: 3000,
  statusEndpoint: '/connection-status',
  keycloakConfig: {
    url: 'https://kc.mindtechpy.net',
    realm: 'message-sender',
    clientId: 'message-sender-web'
  },
  // Development mode fallback
  isDevelopment: window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1'
};

/** ======== Debug Helper ======== */
function logDebug(...args) {
  if (CONFIG.isDevelopment) {
    console.log('[DEBUG]', ...args);
  }
}

/** ======== Keycloak Authentication ======== */
let keycloak = null;
let isAuthenticated = false;

async function initKeycloak() {
  try {
    // En desarrollo local, omitir autenticación
    if (CONFIG.isDevelopment) {
      console.log('🛠️ Modo desarrollo: omitiendo autenticación Keycloak');
      isAuthenticated = true;
      hideLoadingScreen();
      showAlert('Modo desarrollo activado', 'info', 'Sin autenticación');
      return;
    }
    
    // Show loading screen
    showLoadingScreen('Inicializando autenticación...');
    
    keycloak = new Keycloak(CONFIG.keycloakConfig);
    
    const authenticated = await keycloak.init({
      onLoad: 'login-required',
      checkLoginIframe: false,
      pkceMethod: 'S256'
    });

    if (authenticated) {
      isAuthenticated = true;
      console.log('✅ Autenticación exitosa');
      
      // Set up token refresh
      setupTokenRefresh();
      
      // Hide loading screen
      hideLoadingScreen();
      
      showAlert('Bienvenido al sistema', 'success', 'Autenticación exitosa');
    } else {
      throw new Error('Autenticación fallida');
    }
  } catch (error) {
    console.error('❌ Error de autenticación:', error);
    hideLoadingScreen();
    
    // En desarrollo, continuar sin autenticación
    if (CONFIG.isDevelopment) {
      console.log('🛠️ Fallback a modo desarrollo sin autenticación');
      isAuthenticated = true;
      showAlert('Continuando sin autenticación (modo desarrollo)', 'warning', 'Fallback de desarrollo');
      return;
    }
    
    showAlert('Error en la autenticación. Recargando...', 'error', 'Error de autenticación');
    setTimeout(() => window.location.reload(), 2000);
  }
}

function setupTokenRefresh() {
  setInterval(() => {
    keycloak.updateToken(70).then(refreshed => {
      if (refreshed) {
        console.log('🔄 Token actualizado');
      }
    }).catch(() => {
      console.warn('⚠️ Fallo al actualizar token');
      keycloak.login();
    });
  }, 60000);
}

async function authFetch(url, options = {}) {
  // En modo desarrollo, usar fetch normal
  if (CONFIG.isDevelopment) {
    return fetch(url, options);
  }
  
  if (!keycloak?.token) {
    throw new Error('No hay token de autenticación');
  }
  
  return fetch(url, {
    ...options,
    headers: {
      ...options.headers,
      'Authorization': `Bearer ${keycloak.token}`
    }
  });
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
  
  // Update URL hash
  window.location.hash = tabName;
}

/** ======== QR Code Management ======== */
let qrInitialized = false;

function initializeQR() {
  if (qrInitialized) return;
  
  const qrImage = document.getElementById('qrImage');
  if (qrImage) {
    qrImage.src = `/qr?t=${Date.now()}`;
    qrInitialized = true;
    logDebug('QR inicializado');
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
          qrImage.src = `/qr?t=${Date.now()}`;
          logDebug('QR refrescado manualmente');
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
      statusText.textContent = 'Conectado';
      
      if (!isCurrentlyConnected) {
        showAlert('¡WhatsApp conectado exitosamente!', 'success', 'Conexión establecida');
        // Auto-switch to send tab after successful connection
        setTimeout(() => showTab('send'), 1500);
      }
      isCurrentlyConnected = true;
    } else {
      statusText.textContent = 'Autenticado (sincronizando...)';
      isCurrentlyConnected = false; // No considerar completamente conectado hasta que isReady sea true
    }
  } else {
    statusElement.classList.remove('connected');
    statusText.textContent = 'Desconectado';
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

async function checkStatus() {
  try {
    const url = `${CONFIG.statusEndpoint}?t=${Date.now()}`;
    const res = await authFetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const status = await res.json();
    updateInterface(status);
    return status;
  } catch (e) {
    console.error('Status check error:', e);
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

function setupMessageTextarea() {
  const textarea = document.getElementById('message');
  const charCount = document.getElementById('charCount');
  
  if (textarea && charCount) {
    textarea.addEventListener('input', (e) => {
      const length = e.target.value.length;
      charCount.textContent = length;
      
      // Color coding for character limit
      if (length > 3500) {
        charCount.style.color = 'var(--error-500)';
      } else if (length > 3000) {
        charCount.style.color = 'var(--warning-500)';
      } else {
        charCount.style.color = 'var(--text-tertiary)';
      }
    });
  }
}

/** ======== Message Status & Progress ======== */
let messageProgressPoll = null;

function updateMessageStatus(status) {
  const { sent, total, errors, messages, completed, speed } = status || {};

  // Update progress bar
  const progress = total > 0 ? Math.round((sent / total) * 100) : 0;
  const progressFill = document.querySelector('.progress-fill');
  const progressPercentage = document.querySelector('.progress-percentage');
  
  if (progressFill) progressFill.style.width = `${progress}%`;
  if (progressPercentage) progressPercentage.textContent = `${progress}%`;

  // Update stat cards
  updateStatCard('totalCount', total || 0);
  updateStatCard('sentCount', sent || 0);
  updateStatCard('errorCount', errors || 0);
  updateStatCard('currentSpeed', speed || 0);

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
    animateNumber(element, currentValue, value, 500);
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
  }, 1000);
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
  // Initialize authentication first
  await initKeycloak();
  
  // Setup all event listeners
  setupEventListeners();
  
  // Setup form handlers
  setupMessageTypeHandlers();
  setupFileInputHandlers();
  setupMessageTextarea();
  
  // Setup theme toggle
  setupThemeToggle();
  
  // Initially disable send tab until WhatsApp is connected
  const sendTabBtn = document.querySelector('[data-tab="send"]');
  if (sendTabBtn) {
    sendTabBtn.classList.add('disabled');
  }
  
  // Start status checking
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