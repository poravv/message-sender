// Variable para rastrear el último estado de conexión
window.lastConnectionState = false;

// Actualiza forzosamente el estado cada vez que se carga la página
document.addEventListener('DOMContentLoaded', () => {
    console.log('Iniciando verificación inmediata del estado...');
    forceStateUpdate();
});

// Función para forzar una actualización inmediata del estado
async function forceStateUpdate() {
    try {
        console.log('Forzando actualización del estado...');
        const response = await fetch('/connection-status?nocache=' + Date.now());
        const status = await response.json();
        console.log('Estado actual:', status);
        
        // Actualizar UI basado en este estado
        updateUIWithStatus(status);
        
        return status;
    } catch (error) {
        console.error('Error en la actualización forzada:', error);
    }
}

// Función para actualizar el estado de la UI con verificación más frecuente
async function updateUIStateImproved() {
    try {
        // Agregar un parámetro aleatorio para evitar caché
        const response = await fetch('/connection-status?t=' + Date.now());
        const status = await response.json();
        console.log('Estado actualizado:', status);
        
        // Actualizar UI basado en el estado
        updateUIWithStatus(status);
        
        return status;
    } catch (error) {
        console.error('Error actualizando estado:', error);
        return null;
    }
}

// Función separada para actualizar la UI basada en el estado
function updateUIWithStatus(status) {
    const statusElement = document.getElementById('connection-status');
    const button = document.getElementById('toggleWhatsApp');
    const qrContainer = document.getElementById('qr-container');
    const authenticatedMessage = document.getElementById('authenticated-message');
    const linkBtn = document.getElementById('linkBtn');
    const sendBtn = document.getElementById('sendBtn');

    if (status && status.isReady) {
        console.log('¡Usuario conectado! Actualizando UI...');
        
        // Cliente autenticado y listo
        button.textContent = 'Deshabilitar';
        button.className = 'btn btn-danger';
        statusElement.textContent = 'Conectado';
        statusElement.className = 'status-connected';
        
        // Cambiar el contenido de la pestaña de enlace
        qrContainer.classList.add('d-none');
        authenticatedMessage.classList.remove('d-none');
        
        // Activar la pestaña de envío
        linkBtn.classList.remove('btn-primary');
        linkBtn.classList.add('btn-outline-primary');
        sendBtn.classList.remove('btn-secondary');
        sendBtn.classList.add('btn-primary');
        
        // Si se detecta cambio a estado conectado, mostrar alerta
        if (window.lastConnectionState === false) {
            showAlert('¡Conexión establecida correctamente!', 'success');
            // Cambiar automáticamente a la pestaña de envío
            setTimeout(() => showTab('send'), 1000);
        }
        
        // Guardar estado actual
        window.lastConnectionState = true;
    } else {
        console.log('Usuario no conectado, mostrando QR...');
        
        // Cliente no autenticado
        button.textContent = 'Habilitar';
        button.className = 'btn btn-success';
        statusElement.textContent = 'Desconectado';
        statusElement.className = 'status-disconnected';
        
        // Mostrar QR y ocultar mensaje de autenticado
        qrContainer.classList.remove('d-none');
        authenticatedMessage.classList.add('d-none');
        
        // Restablecer estilos de botones
        linkBtn.classList.add('btn-primary');
        linkBtn.classList.remove('btn-outline-primary');
        sendBtn.classList.add('btn-secondary'); 
        sendBtn.classList.remove('btn-primary');
        
        // Guardar estado actual
        window.lastConnectionState = false;
    }

        // Verificar si hay un QR para mostrar
        const qrImage = document.getElementById('qrImage');
        const refreshQrBtn = document.getElementById('refreshQrBtn');
        
        if (status.isReady) {
            // Si está conectado, ocultar el QR y el botón de refrescar
            qrImage.style.display = 'none';
            refreshQrBtn.style.display = 'none';
            console.log('Usuario conectado, ocultando QR');
        } else if (!status.isReady && status.hasQR) {
            // No conectado pero hay QR disponible
            qrImage.style.display = 'block';
            qrImage.src = `/qr?t=${Date.now()}`;
            refreshQrBtn.style.display = 'inline-block';
            console.log('Mostrando QR disponible');
        } else {
            // No conectado y sin QR, mostrar imagen por defecto
            qrImage.style.display = 'block';
            qrImage.src = `/qr?t=${Date.now()}`;
            refreshQrBtn.style.display = 'inline-block';
            console.log('No hay QR, mostrando botón de refrescar');
        }

        // Si hay inactividad prolongada, mostrar alerta
        const inactivityTime = (Date.now() - new Date(status.lastActivity)) / 1000;
        if (inactivityTime > 1800 && status.isReady) { // 30 minutos
            showAlert('La conexión ha estado inactiva por mucho tiempo. Considere reiniciarla.', 'warning');
        }
        
        return status;

}

// Iniciar verificación periódica con intervalo mejorado
function startStatusCheckImproved() {
    // Verificación inicial
    updateUIStateImproved();
    
    // Verificación frecuente (cada 2 segundos) mientras se espera conexión
    connectionCheckInterval = setInterval(async () => {
        const status = await updateUIStateImproved();
        
        // Si ya está conectado, reducir frecuencia de verificación
        if (status && status.isReady) {
            clearInterval(connectionCheckInterval);
            connectionCheckInterval = setInterval(updateUIStateImproved, 10000); // Cada 10 segundos cuando está conectado
        }
    }, 2000); 
}

// Reemplazar funciones originales después de cargar la página
window.addEventListener('DOMContentLoaded', () => {
    // Reemplazar la función original de actualización de estado
    window.updateUIState = updateUIStateImproved;
    window.startStatusCheck = startStatusCheckImproved;
    
    // Iniciar la verificación de estado mejorada
    startStatusCheckImproved();
    
    console.log('Sistema de actualización mejorado activado');
});
