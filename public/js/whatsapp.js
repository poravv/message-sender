/**
 * WhatsApp - Connection and QR Management
 */

let statusPollingInterval = null;
let isConnected = false;

// Check WhatsApp status
async function checkWhatsAppStatus() {
  try {
    const res = await authFetch('/connection-status');
    if (!res.ok) throw new Error('Status check failed');
    
    const data = await res.json();
    updateConnectionStatus(data);
    return data;
  } catch (error) {
    console.error('Error checking status:', error);
    updateConnectionStatus({ status: 'error' });
    return null;
  }
}

// Update connection status UI
function updateConnectionStatus(data) {
  const statusEl = document.getElementById('connection-status');
  const statusDot = statusEl?.querySelector('.status-dot');
  const statusText = statusEl?.querySelector('.status-text');
  
  const qrContainer = document.getElementById('qr-container');
  const authenticatedMsg = document.getElementById('authenticated-message');
  const sendTab = document.querySelector('[data-tab="send"]');
  
  const status = data?.status || 'disconnected';
  isConnected = status === 'connected' || status === 'authenticated';
  
  // Update status badge
  if (statusEl) {
    statusEl.classList.remove('connected', 'disconnected', 'connecting');
    if (isConnected) {
      statusEl.classList.add('connected');
    } else if (status === 'connecting') {
      statusEl.classList.add('connecting');
    } else {
      statusEl.classList.add('disconnected');
    }
  }
  
  // Update status text
  if (statusText) {
    const texts = {
      connected: 'Conectado',
      authenticated: 'Conectado',
      connecting: 'Conectando...',
      disconnected: 'Desconectado',
      error: 'Error'
    };
    statusText.textContent = texts[status] || 'Desconectado';
  }
  
  // Toggle QR / Connected message
  if (qrContainer && authenticatedMsg) {
    if (isConnected) {
      qrContainer.classList.add('d-none');
      authenticatedMsg.classList.remove('d-none');
      
      // Update user info
      if (data.user) {
        const nicknameEl = document.getElementById('wa-user-nickname');
        const phoneEl = document.getElementById('wa-user-phone');
        if (nicknameEl) nicknameEl.textContent = data.user.name || data.user.pushName || 'Usuario';
        if (phoneEl) phoneEl.textContent = data.user.phone || data.user.id?.replace(/@.*/, '') || '';
      }
    } else {
      qrContainer.classList.remove('d-none');
      authenticatedMsg.classList.add('d-none');
    }
  }
  
  // Enable/disable send tab
  if (sendTab) {
    if (isConnected) {
      sendTab.classList.remove('disabled');
    } else {
      sendTab.classList.add('disabled');
    }
  }
}

// Load QR Code
async function loadQR() {
  const qrImage = document.getElementById('qrImage');
  if (!qrImage) return;
  
  try {
    const res = await authFetch('/qr');
    if (!res.ok) {
      if (res.status === 204 || res.status === 400) {
        // Already authenticated
        checkWhatsAppStatus();
        return;
      }
      throw new Error('QR fetch failed');
    }
    
    // Backend returns image/png directly
    const contentType = res.headers.get('content-type');
    if (contentType && contentType.includes('image/')) {
      const blob = await res.blob();
      const imageUrl = URL.createObjectURL(blob);
      
      // Cleanup old blob URL
      if (qrImage.src && qrImage.src.startsWith('blob:')) {
        URL.revokeObjectURL(qrImage.src);
      }
      
      qrImage.src = imageUrl;
      qrImage.style.display = 'block';
    } else {
      // Fallback for JSON response
      const data = await res.json();
      if (data.qr) {
        qrImage.src = data.qr;
        qrImage.style.display = 'block';
      }
    }
  } catch (error) {
    console.error('Error loading QR:', error);
  }
}

// Refresh QR
async function refreshQR() {
  const btn = document.getElementById('refreshQrBtn');
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '<i class="bi bi-arrow-clockwise spin"></i> Cargando...';
  }
  
  await loadQR();
  
  if (btn) {
    btn.disabled = false;
    btn.innerHTML = '<i class="bi bi-arrow-clockwise"></i> Refrescar código';
  }
}

// Clear Redis Session
async function clearRedisSession() {
  try {
    const res = await authFetch('/refresh-qr', { method: 'POST' });
    if (res.ok) {
      showAlert('QR refrescado. Puede escanear nuevamente.', 'success');
      setTimeout(loadQR, 1000);
    } else {
      showAlert('Error al refrescar QR', 'warning');
    }
  } catch (error) {
    showAlert('Error al refrescar QR', 'danger');
  }
}

// Start status polling
function startStatusPolling() {
  checkWhatsAppStatus();
  loadQR();
  
  if (statusPollingInterval) {
    clearInterval(statusPollingInterval);
  }
  
  statusPollingInterval = setInterval(() => {
    checkWhatsAppStatus();
    if (!isConnected) {
      loadQR();
    }
  }, 5000);
}

// Stop status polling
function stopStatusPolling() {
  if (statusPollingInterval) {
    clearInterval(statusPollingInterval);
    statusPollingInterval = null;
  }
}

// Initialize WhatsApp module
function initWhatsApp() {
  startStatusPolling();
  
  // Setup refresh button
  const refreshBtn = document.getElementById('refreshQrBtn');
  if (refreshBtn) {
    refreshBtn.addEventListener('click', refreshQR);
  }
  
  // Setup clear cache button
  const clearBtn = document.getElementById('clearRedisBtn');
  if (clearBtn) {
    clearBtn.addEventListener('click', clearRedisSession);
  }
}

// Global exports
window.refreshQR = refreshQR;
window.clearRedisSession = clearRedisSession;
window.initWhatsApp = initWhatsApp;
window.isWhatsAppConnected = () => isConnected;
