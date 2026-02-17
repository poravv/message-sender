/**
 * Main - Application Entry Point
 */

document.addEventListener('DOMContentLoaded', async () => {
  console.log('🚀 Iniciando WhatsApp Sender Pro...');
  
  // Initialize authentication
  const authSuccess = await initKeycloak();
  
  if (!authSuccess) {
    console.error('❌ Falló la autenticación');
    return;
  }
  
  console.log('✅ Autenticación correcta');
  
  // Setup theme
  setupThemeToggle();
  
  // Setup tab navigation
  setupTabNavigation();
  
  // Initialize modules
  initDashboard();
  initWhatsApp();
  initMessages();
  initContacts();
  
  // Setup logout
  const logoutBtn = document.getElementById('logout-btn');
  if (logoutBtn) {
    logoutBtn.addEventListener('click', logout);
  }
  
  // Initial tab from hash or default to dashboard
  const hash = window.location.hash.substring(1);
  const validTabs = ['dashboard', 'whatsapp', 'send', 'contacts'];
  const initialTab = validTabs.includes(hash) ? hash : 'dashboard';
  showTab(initialTab);
  
  console.log('🎉 Aplicación iniciada correctamente');
});

// Setup tab navigation
function setupTabNavigation() {
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const tab = btn.dataset.tab;
      
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
