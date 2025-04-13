// Script para forzar la actualización correcta del estado de la interfaz
document.addEventListener('DOMContentLoaded', function() {
    console.log('Inicializando corrección directa de la interfaz...');
    
    // Corregir inmediatamente el estado para evitar problemas de iniciación
    setTimeout(forceUpdateState, 500);
    
    // Verificar el estado cada 2 segundos
    setInterval(forceUpdateState, 2000);
});

// Función para forzar la actualización del estado
async function forceUpdateState() {
    try {
        console.log('Verificando estado actual...');
        const response = await fetch('/connection-status?t=' + Date.now());
        const data = await response.json();
        console.log('Estado recibido:', data);
        
        // Elementos principales de la interfaz
        const statusElement = document.getElementById('connection-status');
        const qrContainer = document.getElementById('qr-container');
        const authenticatedMessage = document.getElementById('authenticated-message');
        const button = document.querySelector('#toggleWhatsApp');
        
        // Aplicar cambios directos basados en el estado
        if (data.isReady === true) {
            console.log('CONECTADO: Actualizando UI...');
            
            // 1. Actualizar indicador de estado
            statusElement.textContent = 'Conectado';
            statusElement.className = 'status-connected';
            
            // 2. Ocultar QR y mostrar mensaje de autenticación
            if (qrContainer) qrContainer.style.display = 'none';
            if (authenticatedMessage) authenticatedMessage.style.display = 'block';
            authenticatedMessage.classList.remove('d-none');
            
            // 3. Actualizar botón
            if (button) {
                button.textContent = 'Deshabilitar';
                button.className = 'btn btn-danger';
            }
        } else {
            console.log('DESCONECTADO: Actualizando UI...');
            
            // 1. Actualizar indicador de estado
            statusElement.textContent = 'Desconectado';
            statusElement.className = 'status-disconnected';
            
            // 2. Mostrar QR y ocultar mensaje de autenticación
            if (qrContainer) qrContainer.style.display = 'block';
            if (authenticatedMessage) authenticatedMessage.style.display = 'none';
            
            // 3. Actualizar botón
            if (button) {
                button.textContent = 'Habilitar';
                button.className = 'btn btn-success';
            }
        }
    } catch (error) {
        console.error('Error al actualizar el estado:', error);
    }
}
