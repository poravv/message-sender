/**
 * Plans - Pricing page logic
 */

function initPlans() {
  // Nothing to initialize on load
}

function loadPlans() {
  var statusEl = document.getElementById('plans-current-status');
  if (!statusEl) return;

  var profile = window.userProfile;
  if (!profile) {
    // Try loading profile
    if (typeof loadUserProfile === 'function') {
      loadUserProfile().then(function() {
        renderPlanStatus(window.userProfile);
      });
    }
    return;
  }

  renderPlanStatus(profile);
}

function renderPlanStatus(profile) {
  var statusEl = document.getElementById('plans-current-status');
  if (!statusEl || !profile) {
    if (statusEl) statusEl.classList.add('d-none');
    return;
  }

  var html = '';

  if (profile.role === 'admin') {
    html = '<i class="bi bi-shield-check"></i> Tu plan actual: <strong>Administrador</strong>';
    statusEl.className = 'plans-current-status plans-status-active';
  } else if (profile.plan === 'active') {
    html = '<i class="bi bi-check-circle"></i> Tu plan actual: <strong>Plan Activo</strong>';
    statusEl.className = 'plans-current-status plans-status-active';
  } else if (profile.plan === 'trial' && profile.trialDaysLeft > 0) {
    html = '<i class="bi bi-clock"></i> Tu plan actual: <strong>Trial gratuito</strong> (' + profile.trialDaysLeft + ' dias restantes)';
    statusEl.className = 'plans-current-status plans-status-trial';
  } else {
    html = '<i class="bi bi-exclamation-triangle"></i> Tu plan actual: <strong>Expirado</strong>';
    statusEl.className = 'plans-current-status plans-status-expired';
  }

  statusEl.innerHTML = html;
  statusEl.classList.remove('d-none');
}

window.initPlans = initPlans;
window.loadPlans = loadPlans;
