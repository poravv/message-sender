/** ======== Keycloak: init sin bucles y fetch con token ======== */

// Configura tu cliente (usa exactamente los valores de tu Realm/Client)
const keycloak = new Keycloak({
  url: 'https://kc.mindtechpy.net',
  realm: 'message-sender',
  clientId: 'message-sender-web',
});

let refreshing = false;
let refreshTimer = null;

// Inicializa y realiza login UNA sola vez (sin setInterval agresivos)
(async function initAuth() {
  try {
    const authenticated = await keycloak.init({
      onLoad: 'login-required',
      checkLoginIframe: false, // evita pings en iframe que pueden causar comportamientos raros
      pkceMethod: 'S256',      // recomendado si el cliente lo permite
    });

    if (!authenticated) {
      // Una sola redirección si no hay sesión
      return keycloak.login();
    }

    // Renueva justo antes de expirar (sin loops)
    keycloak.onTokenExpired = async () => {
      if (refreshing) return;
      refreshing = true;
      try {
        await keycloak.updateToken(30); // renueva si quedan <30s
      } catch (e) {
        console.error('Fallo refrescando token', e);
        // Muestra aviso en vez de entrar en bucle de login
        showAlert('Sesión expirada. Inicia sesión nuevamente.', 'warning');
        // Si quieres forzar login, hazlo UNA vez:
        // keycloak.login();
      } finally {
        refreshing = false;
      }
    };

    // “Pulso” suave: cada 20s, si faltan <60s de token, intenta renovar
    const tick = async () => {
      clearTimeout(refreshTimer);
      try {
        const expMs = keycloak.tokenParsed?.exp ? keycloak.tokenParsed.exp * 1000 : 0;
        if (expMs) {
          const delta = expMs - Date.now();
          if (delta < 60_000) await keycloak.updateToken(30);
        }
      } catch { /* no crítico */ }
      refreshTimer = setTimeout(tick, 20_000);
    };
    tick();

  } catch (err) {
    console.error('Error iniciando Keycloak:', err);
    showAlert('Error de autenticación', 'danger');
  }
})();

// Helper: fetch con Authorization automáticamente
async function authFetch(url, options = {}) {
  const headers = new Headers(options.headers || {});
  if (keycloak?.token) headers.set('Authorization', `Bearer ${keycloak.token}`);
  return fetch(url, { ...options, headers });
}

/** =========================================================================
 * Frontend App - Message Sender
 * Unificado: lógica de UI, sincronización de estado, manejo de formularios.
 * =========================================================================*/

// ===================== Config / Utils =====================
const CONFIG = {
  checkInterval: 10000,             // ms entre verificaciones de estado
  statusEndpoint: '/connection-status',
  debug: false
};

function logDebug(message, data) {
  if (!CONFIG.debug) return;
  if (data !== undefined) console.log(`[App] ${message}`, data);
  else console.log(`[App] ${message}`);
}

// Alertita flotante (usa #alert del HTML)
function showAlert(message, type = 'success') {
  const alert = document.getElementById('alert');
  if (!alert) return;
  alert.textContent = message;
  alert.className = `alert alert-${type}`;
  alert.style.display = 'block';
  setTimeout(() => (alert.style.display = 'none'), 5000);
}

// ===================== Tabs & QR =====================
async function showTab(tabId) {
  if (tabId === 'send') {
    // Verificar estado antes de cambiar a la pestaña de envío
    const res = await fetch(CONFIG.statusEndpoint);
    const status = await res.json();
    if (!status.isReady) {
      showAlert('Debe habilitar / enlazar WhatsApp primero', 'warning');
      return;
    }
  }

  document.querySelectorAll('.tab').forEach(tab => tab.classList.remove('active'));
  const tabEl = document.getElementById(tabId);
  if (tabEl) tabEl.classList.add('active');
}

// Refrescar QR desde botón en UI
async function refreshQR() {
  try {
    const response = await fetch('/refresh-qr', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    });
    const result = await response.json();
    if (result.success) {
      showAlert('Solicitando nuevo código QR, por favor espere...', 'info');
      setTimeout(() => {
        const img = document.getElementById('qrImage');
        if (img) img.src = `/qr?t=${Date.now()}`;
      }, 2000);
    } else {
      showAlert(result.message || 'No se pudo refrescar el QR', 'warning');
    }
  } catch (e) {
    logDebug('Error al refrescar QR', e);
    showAlert('Error al solicitar nuevo código QR', 'danger');
  }
}

// ===================== Status Sync (unificado) =====================
let isCurrentlyConnected = false;

function updateInterface(status) {
  logDebug('Actualizando interfaz con estado:', status);

  const statusIndicator = document.getElementById('connection-status');
  const qrContainer = document.getElementById('qr-container');
  const authMessage = document.getElementById('authenticated-message');
  const linkBtn = document.getElementById('linkBtn');
  const sendBtn = document.getElementById('sendBtn');

  if (!statusIndicator || !qrContainer || !authMessage) {
    logDebug('Elementos críticos de UI no encontrados');
    return;
  }

  if (status && status.isReady === true) {
    // Conectado
    statusIndicator.textContent = 'Conectado';
    statusIndicator.className = 'status-connected';

    qrContainer.classList.add('d-none');
    authMessage.classList.remove('d-none');
    authMessage.style.display = 'block';

    // user info si llega
    if (status.userInfo) {
      const nick = document.getElementById('user-nickname');
      const phone = document.getElementById('user-phone');
      if (nick) nick.textContent = status.userInfo.pushname || 'Usuario de WhatsApp';
      if (phone) phone.textContent = status.userInfo.phoneNumber || '—';
    }

    // Enfatizar el tab “Enviar”
    if (linkBtn && sendBtn) {
      linkBtn.classList.remove('btn-primary');
      linkBtn.classList.add('btn-outline-primary');
      sendBtn.classList.remove('btn-secondary');
      sendBtn.classList.add('btn-primary');
    }

    // Cambio de desconectado -> conectado
    if (!isCurrentlyConnected) {
      showAlert('¡Conexión establecida correctamente!', 'success');
      setTimeout(() => showTab('send'), 1200);
    }
    isCurrentlyConnected = true;
  } else {
    // Desconectado
    statusIndicator.textContent = 'Desconectado';
    statusIndicator.className = 'status-disconnected';

    qrContainer.classList.remove('d-none');
    authMessage.classList.add('d-none');
    authMessage.style.display = 'none';

    // Enfatizar el tab “Enlazar”
    if (linkBtn && sendBtn) {
      linkBtn.classList.add('btn-primary');
      linkBtn.classList.remove('btn-outline-primary');
      sendBtn.classList.add('btn-secondary');
      sendBtn.classList.remove('btn-primary');
    }

    isCurrentlyConnected = false;

    // Intentar mostrar QR si está disponible
    const qrImage = document.getElementById('qrImage');
    const refreshQrBtn = document.getElementById('refreshQrBtn');
    if (qrImage && refreshQrBtn) {
      qrImage.src = `/qr?t=${Date.now()}`;
      refreshQrBtn.style.display = 'inline-block';
    }
  }

  // Alerta por inactividad (opcional)
  if (status?.isReady && status?.lastActivity) {
    const inactivitySecs = Math.round((Date.now() - new Date(status.lastActivity).getTime()) / 1000);
    if (inactivitySecs > 1800) {
      showAlert('La conexión ha estado inactiva por mucho tiempo. Considere reiniciarla.', 'warning');
    }
  }
}

async function checkStatus() {
  try {
    const url = `${CONFIG.statusEndpoint}?t=${Date.now()}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const status = await res.json();
    updateInterface(status);
    return status;
  } catch (e) {
    logDebug('Error al consultar estado', e);
    return null;
  }
}

function startStatusCheck() {
  // Primer chequeo y luego intervalos
  setTimeout(() => {
    checkStatus();
    setInterval(checkStatus, CONFIG.checkInterval);
  }, 500);
}

// ===================== Form: Mostrar/ocultar campos =====================
function toggleImageFields() {
  const imageOption = document.getElementById('imageOption')?.value;
  const multipleImagesField = document.getElementById('multipleImagesField');
  const singleImageField = document.getElementById('singleImageField');
  const audioField = document.getElementById('audioField');

  if (!multipleImagesField || !singleImageField || !audioField) return;

  // Ocultar todos
  multipleImagesField.classList.add('hidden');
  singleImageField.classList.add('hidden');
  audioField.classList.add('hidden');

  // Quitar required de todos
  document.getElementById('images')?.removeAttribute('required');
  document.getElementById('singleImage')?.removeAttribute('required');
  document.getElementById('audioFile')?.removeAttribute('required');

  // Mostrar y poner required si aplica
  if (imageOption === 'multiple') {
    multipleImagesField.classList.remove('hidden');
    // document.getElementById('images')?.setAttribute('required', 'required'); // opcional
  } else if (imageOption === 'single') {
    singleImageField.classList.remove('hidden');
    // document.getElementById('singleImage')?.setAttribute('required', 'required'); // opcional
  } else if (imageOption === 'audio') {
    audioField.classList.remove('hidden');
    document.getElementById('audioFile')?.setAttribute('required', 'required');
  }
}

// ===================== Estado del envío (tabla/progreso) =====================
function updateMessageStatus(status) {
  const { sent, total, errors, messages, completed } = status || {};

  // Progreso
  const progress = total > 0 ? Math.round((sent / total) * 100) : 0;
  const progressBar = document.querySelector('.progress-bar');
  if (progressBar) {
    progressBar.style.width = `${progress}%`;
    progressBar.textContent = `${progress}%`;
  }

  // Contadores
  const sentCount = document.getElementById('sentCount');
  const totalCount = document.getElementById('totalCount');
  const errorCount = document.getElementById('errorCount');
  if (sentCount) sentCount.textContent = sent ?? 0;
  if (totalCount) totalCount.textContent = total ?? 0;
  if (errorCount) errorCount.textContent = errors ?? 0;

  // Tabla
  const tbody = document.getElementById('statusTableBody');
  if (tbody && Array.isArray(messages)) {
    // Si completed, reinicia la tabla para mostrar estado final limpio
    if (completed) tbody.innerHTML = '';

    messages.forEach(m => {
      const key = String(m.number);
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
      }[m.status] || 'badge-queued';

      row.innerHTML = `
        <td>${m.number}</td>
        <td><span class="status-badge ${badgeClass}">${m.status}</span></td>
        <td>${m.message || ''}</td>
      `;
      row.className = m.status === 'error' ? 'status-row-error' : 'status-row-success';
    });
  }

  // Mensaje final
  if (completed) {
    const spinner = document.getElementById('spinner');
    if (spinner) spinner.style.display = 'none';
    if ((errors ?? 0) === 0) showAlert('Todos los mensajes fueron enviados exitosamente', 'success');
    else showAlert(`Envío completado con ${errors} errores`, 'warning');
  }
}

// ===================== Submit del formulario (ENVÍO) =====================
document.getElementById('messageForm').addEventListener('submit', async (event) => {
  event.preventDefault();

  const messageStatus = document.getElementById('messageStatus');
  if (messageStatus) {
    messageStatus.style.display = 'block';
  }
  const tableBody = document.getElementById('statusTableBody');
  if (tableBody) tableBody.innerHTML = '';

  const option = document.getElementById('imageOption')?.value || 'none';
  const audioInput = document.getElementById('audioFile');

  // Validación específica si es audio
  if (option === 'audio' && (!audioInput || audioInput.files.length === 0)) {
    showAlert('Debes seleccionar un archivo de audio.', 'warning');
    return;
  }

  const formData = new FormData();
  formData.append('message', document.getElementById('message').value);
  formData.append('csvFile', document.getElementById('csvFile').files[0]);
  formData.append('mode', option); // útil para validaciones en el backend

  if (option === 'single') {
    const singleImage = document.getElementById('singleImage').files[0];
    if (singleImage) formData.append('singleImage', singleImage);
  } else if (option === 'multiple') {
    const images = document.getElementById('images').files;
    for (let i = 0; i < images.length; i++) formData.append('images', images[i]);
  } else if (option === 'audio') {
    const audioFile = audioInput.files[0];
    formData.append('audioFile', audioFile);
  }

  const spinner = document.getElementById('spinner');
  if (spinner) spinner.style.display = 'block';

  try {
    const res = await authFetch('/send-messages', { method: 'POST', body: formData });
    const result = await res.json();

    if (res.ok) {
      if (result.initialStats) updateMessageStatus(result.initialStats);

      const poll = setInterval(async () => {
        const sRes = await authFetch('/message-status');
        const status = await sRes.json();
        updateMessageStatus(status);
        if (status.completed) clearInterval(poll);
      }, 1000);
    } else {
      showAlert(result.error || 'Error al enviar', 'danger');
      if (spinner) spinner.style.display = 'none';
    }
  } catch (err) {
    showAlert(`Error: ${err.message}`, 'danger');
    if (spinner) spinner.style.display = 'none';
  }
});

// ===================== Arranque =====================
document.addEventListener('DOMContentLoaded', () => {
  // Listeners de UI
  const sel = document.getElementById('imageOption');
  if (sel) {
    sel.addEventListener('change', toggleImageFields);
    toggleImageFields(); // estado inicial correcto
  }

  const linkBtn = document.getElementById('linkBtn');
  const sendBtn = document.getElementById('sendBtn');
  if (linkBtn) linkBtn.addEventListener('click', () => showTab('link'));
  if (sendBtn) sendBtn.addEventListener('click', () => showTab('send'));

  const refreshBtn = document.getElementById('refreshQrBtn');
  if (refreshBtn) refreshBtn.addEventListener('click', refreshQR);

  // Iniciar sincronización de estado
  startStatusCheck();
});

// ===================
// Toggle de tema
// ===================
(function() {
  const THEME_KEY = 'ms-theme';
  const root = document.documentElement; // <html>
  const switchEl = document.getElementById('themeSwitch');
  const labelEl = document.getElementById('themeLabel');

  // Cargar preferencia guardada o detectar sistema
  const saved = localStorage.getItem(THEME_KEY);
  const prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
  const initial = saved || (prefersDark ? 'dark' : 'light');

  setTheme(initial);

  function setTheme(mode) {
    root.setAttribute('data-theme', mode);
    localStorage.setItem(THEME_KEY, mode);
    if (switchEl) switchEl.checked = (mode === 'dark');
    if (labelEl) labelEl.textContent = (mode === 'dark' ? 'Oscuro' : 'Claro');
  }

  // Listener del switch
  if (switchEl) {
    switchEl.addEventListener('change', () => {
      setTheme(switchEl.checked ? 'dark' : 'light');
    });
  }

  // Auto-ajuste si cambia el sistema y no hay preferencia guardada
  if (window.matchMedia) {
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', e => {
      const current = localStorage.getItem(THEME_KEY);
      if (!current) setTheme(e.matches ? 'dark' : 'light');
    });
  }
})();