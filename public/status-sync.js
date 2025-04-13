/**
 * Este script tiene un único propósito: actualizar el estado visual de la interfaz
 * basado en el estado real de la conexión de WhatsApp.
 */

// Configuración
const CONFIG = {
    checkInterval: 10000, // Milisegundos entre verificaciones
    endpoint: '/connection-status', // Endpoint para verificar el estado
    debug: false // Activar logs de depuración
};

// Estado inicial
let isCurrentlyConnected = false;

// Función para el log de depuración
function log(message, data) {
    if (CONFIG.debug) {
        if (data) {
            console.log(`[StatusSync] ${message}`, data);
        } else {
            console.log(`[StatusSync] ${message}`);
        }
    }
}

// Función principal que actualiza la interfaz
function updateInterface(status) {
    log('Actualizando interfaz con estado:', status);
    
    // 1. Obtener referencias directas a los elementos DOM
    const statusIndicator = document.getElementById('connection-status');
    const qrContainer = document.getElementById('qr-container');
    const authMessage = document.getElementById('authenticated-message');
    const toggleBtn = document.getElementById('toggleWhatsApp');
    
    if (!statusIndicator || !qrContainer || !authMessage) {
        log('ERROR: No se encontraron elementos críticos de la UI');
        return;
    }

    // 2. Actualizar según el estado de conexión
    if (status && status.isReady === true) {
        // CONECTADO
        log('Estado: CONECTADO - Actualizando UI');
        
        // Cambiar indicador de estado
        statusIndicator.textContent = 'Conectado';
        statusIndicator.className = 'status-connected';
        
        // Cambiar visibilidad de elementos
        qrContainer.style.display = 'none';
        authMessage.style.display = 'block';
        authMessage.classList.remove('d-none');
        
        // Actualizar botón
        if (toggleBtn) {
            toggleBtn.textContent = 'Deshabilitar';
            toggleBtn.className = 'btn btn-danger';
        }
        
        // Detectar cambio de estado (desconectado -> conectado)
        if (!isCurrentlyConnected) {
            log('Cambio de estado: DESCONECTADO -> CONECTADO');
            showAlert('¡Conexión establecida correctamente!', 'success');
            
            // Cambiar automáticamente a la pestaña de envío
            setTimeout(() => {
                showTab('send');
            }, 1500);
        }
        
        isCurrentlyConnected = true;
    } else {
        // DESCONECTADO
        log('Estado: DESCONECTADO - Actualizando UI');
        
        // Cambiar indicador de estado
        statusIndicator.textContent = 'Desconectado';
        statusIndicator.className = 'status-disconnected';
        
        // Cambiar visibilidad de elementos
        qrContainer.style.display = 'block';
        authMessage.style.display = 'none';
        
        // Actualizar botón
        if (toggleBtn) {
            toggleBtn.textContent = 'Habilitar';
            toggleBtn.className = 'btn btn-success';
        }
        
        isCurrentlyConnected = false;
    }
}

// Función para verificar el estado actual
async function checkStatus() {
    try {
        const timestamp = Date.now();
        const url = `${CONFIG.endpoint}?t=${timestamp}`;
        
        log(`Verificando estado en: ${url}`);
        const response = await fetch(url);
        
        if (!response.ok) {
            throw new Error(`Error en la respuesta: ${response.status}`);
        }
        
        const data = await response.json();
        log('Estado recibido:', data);
        
        // Actualizar la interfaz con el estado actual
        updateInterface(data);
        
        return data;
    } catch (error) {
        log('Error al verificar el estado:', error);
        return null;
    }
}

// Función para forzar una verificación inmediata
function forceCheck() {
    return checkStatus();
}

// Inicializar el sistema cuando se carga la página
document.addEventListener('DOMContentLoaded', () => {
    log('Inicializando sistema de sincronización de estado...');
    
    // Verificación inicial
    setTimeout(() => {
        checkStatus();
        
        // Verificaciones periódicas
        setInterval(checkStatus, CONFIG.checkInterval);
        
        log(`Sistema iniciado. Verificando cada ${CONFIG.checkInterval}ms`);
    }, 500);
});

// Exponer función de verificación forzada globalmente
window.forceStatusCheck = forceCheck;
