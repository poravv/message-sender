// Función para cerrar sesión de Keycloak con logout robusto de WhatsApp
async function logoutKeycloak() {
  try {
    console.log('🚪 Iniciando proceso de logout robusto...');
    
    // Verificar que Keycloak esté disponible
    if (!keycloak) {
      console.error('❌ Keycloak no está disponible para logout');
      showAlert('Error: Sistema de autenticación no disponible', 'error');
      return;
    }
    
    // Mostrar confirmación mejorada
    const confirmLogout = confirm('¿Estás seguro de que deseas cerrar sesión?\n\n✅ Se cerrará tu sesión de Keycloak\n✅ Se desvinculará WhatsApp de este dispositivo (proceso robusto)\n✅ Tendrás que volver a escanear el código QR\n\n⏱️ Este proceso puede tomar unos segundos...');
    if (!confirmLogout) {
      console.log('🚫 Logout cancelado por el usuario');
      return;
    }
    
    console.log('✅ Confirmación de logout recibida, procediendo con proceso robusto...');
    
    // Crear indicador de progreso mejorado
    showLoadingScreen('Iniciando logout robusto...');
    
    // Crear div de progreso detallado
    const progressDiv = document.createElement('div');
    progressDiv.id = 'logout-progress-detail';
    progressDiv.innerHTML = `
      <div style="position: fixed; top: 20px; right: 20px; 
                  background: white; padding: 15px; border-radius: 8px; 
                  box-shadow: 0 4px 6px rgba(0,0,0,0.1); z-index: 10001; 
                  min-width: 300px; border-left: 4px solid #007bff;">
        <h6 style="margin: 0 0 10px 0; color: #333;">🔄 Progreso del Logout</h6>
        <div id="logout-step" style="font-size: 14px; margin-bottom: 8px;">Iniciando...</div>
        <div style="height: 4px; background: #f0f0f0; border-radius: 2px; margin-bottom: 8px;">
          <div id="logout-progress-bar" style="height: 100%; background: #007bff; border-radius: 2px; width: 0%; transition: width 0.3s;"></div>
        </div>
        <div id="logout-details" style="font-size: 12px; color: #666;"></div>
      </div>
    `;
    document.body.appendChild(progressDiv);
    
    const updateProgress = (percent, step, details = '') => {
      const stepEl = document.getElementById('logout-step');
      const barEl = document.getElementById('logout-progress-bar');
      const detailsEl = document.getElementById('logout-details');
      
      if (stepEl) stepEl.textContent = step;
      if (barEl) barEl.style.width = percent + '%';
      if (detailsEl) detailsEl.textContent = details;
    };

    // PASO 1: Cerrar sesión de WhatsApp con proceso robusto
    try {
      updateProgress(20, '📱 Cerrando sesión de WhatsApp...', 'Iniciando logout robusto...');
      console.log('📱 Cerrando sesión de WhatsApp con proceso robusto...');
      
      const whatsappLogout = await authFetch('/logout-whatsapp', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        }
      });

      if (whatsappLogout.ok) {
        const result = await whatsappLogout.json();
        console.log('✅ WhatsApp logout resultado:', result);
        
        updateProgress(60, '✅ WhatsApp: ' + result.message, 
          `${result.attempts} intentos, ${result.finalState?.fullyDisconnected ? 'completamente desvinculado' : 'parcialmente desvinculado'}`);
        
        // Mostrar recomendación si está disponible
        if (result.recommendation) {
          console.log('💡 Recomendación:', result.recommendation);
          setTimeout(() => {
            updateProgress(65, result.recommendation, '');
          }, 1000);
        }
        
        // Verificación adicional del estado
        if (result.finalState && !result.finalState.fullyDisconnected) {
          updateProgress(70, '🔍 Verificando desvinculación...', 'Comprobando estado final...');
          
          try {
            // Esperar un momento antes de verificar
            await new Promise(resolve => setTimeout(resolve, 2000));
            
            const statusResponse = await authFetch('/logout-status');
            if (statusResponse.ok) {
              const status = await statusResponse.json();
              console.log('📊 Estado de verificación:', status);
              
              if (status.state === 'disconnected') {
                updateProgress(75, '✅ Verificación: dispositivo desvinculado', '');
              } else {
                updateProgress(75, '⚠️ Verificación: desvinculación parcial', 
                  'El dispositivo puede tardar unos minutos en desaparecer de WhatsApp');
              }
            }
          } catch (statusError) {
            console.log('⚠️ Error en verificación:', statusError.message);
            updateProgress(75, '⚠️ No se pudo verificar estado', 'Continuando con Keycloak...');
          }
        } else {
          updateProgress(75, '✅ WhatsApp completamente desvinculado', 'Verificación exitosa');
        }
        
      } else {
        updateProgress(40, '⚠️ Problema con logout de WhatsApp', 'Continuando con Keycloak...');
        console.warn('⚠️ Error al cerrar WhatsApp, continuando con logout de Keycloak');
      }
    } catch (whatsappError) {
      updateProgress(35, '❌ Error en WhatsApp logout', whatsappError.message);
      console.warn('⚠️ Error al cerrar WhatsApp:', whatsappError.message);
      console.log('Continuando con logout de Keycloak...');
    }
    
    // PASO 2: Limpiar datos locales
    updateProgress(80, '🧹 Limpiando datos locales...', 'Eliminando información de sesión');
    console.log('🧹 Limpiando datos locales...');
    sessionStorage.removeItem(CONFIG.authAttemptKey);
    sessionStorage.clear();
    localStorage.clear();
    
    // PASO 3: Reiniciar estado de la aplicación
    updateProgress(85, '🔄 Reiniciando estado de aplicación...', '');
    isAuthenticated = false;
    currentUser = { id: null, name: null, email: null };
    
    updateProgress(90, '🔐 Cerrando sesión en Keycloak...', 'Preparando redirección');
    console.log('🔄 Iniciando logout en Keycloak...');
    
    // Cerrar sesión en Keycloak con URL de redirección
    const logoutUrl = keycloak.createLogoutUrl({
      redirectUri: window.location.origin + window.location.pathname
    });
    
    updateProgress(100, '✅ Logout completado', 'Redirigiendo...');
    console.log('🌐 Redirigiendo a:', logoutUrl);
    
    // Dar tiempo para mostrar el progreso completo
    setTimeout(() => {
      // Limpiar progreso antes de redireccionar
      if (document.getElementById('logout-progress-detail')) {
        document.body.removeChild(progressDiv);
      }
      
      // Redireccionar manualmente para mayor control
      window.location.href = logoutUrl;
    }, 1500);
    
  } catch (error) {
    console.error('❌ Error durante el logout robusto:', error);
    hideLoadingScreen();
    
    // Limpiar progreso en caso de error
    const progressEl = document.getElementById('logout-progress-detail');
    if (progressEl) {
      document.body.removeChild(progressEl);
    }
    
    showAlert(
      'Error al cerrar sesión.\n\n' +
      'Por favor verifica manualmente:\n' +
      '• Tu sesión en WhatsApp (Dispositivos vinculados)\n' +
      '• Tu sesión en Keycloak\n\n' +
      'Si el problema persiste, contacta al administrador.', 
      'error', 
      'Error de logout robusto'
    );
    
    // Como fallback, recargar la página después de un momento
    setTimeout(() => {
      if (confirm('¿Deseas recargar la página para intentar nuevamente?')) {
        window.location.reload();
      }
    }, 3000);
  }
}