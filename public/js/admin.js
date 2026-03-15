/**
 * Admin - User Management Panel
 */

var adminUsers = [];
var adminLoaded = false;

function initAdmin() {
  // Show admin tab button only for admin users
  var checkProfile = function() {
    var profile = window.userProfile;
    if (profile && profile.role === 'admin') {
      var tabBtn = document.getElementById('admin-tab-btn');
      if (tabBtn) tabBtn.classList.remove('d-none');
    }
  };

  // Check immediately and also after a short delay (profile may load async)
  checkProfile();
  setTimeout(checkProfile, 2000);

  // Setup event listeners
  var refreshBtn = document.getElementById('admin-refresh-btn');
  if (refreshBtn) {
    refreshBtn.addEventListener('click', function() {
      loadAdmin(true);
    });
  }

  var searchInput = document.getElementById('admin-search');
  if (searchInput) {
    searchInput.addEventListener('input', debounceAdmin(filterAndRenderUsers, 300));
  }

  var filterStatus = document.getElementById('admin-filter-status');
  if (filterStatus) {
    filterStatus.addEventListener('change', filterAndRenderUsers);
  }

  var filterPlan = document.getElementById('admin-filter-plan');
  if (filterPlan) {
    filterPlan.addEventListener('change', filterAndRenderUsers);
  }
}

function debounceAdmin(fn, delay) {
  var timer;
  return function() {
    clearTimeout(timer);
    timer = setTimeout(fn, delay);
  };
}

function loadAdmin(forceRefresh) {
  // Only load if admin
  var profile = window.userProfile;
  if (!profile || profile.role !== 'admin') return;

  if (adminLoaded && !forceRefresh) {
    filterAndRenderUsers();
    return;
  }

  var container = document.getElementById('admin-users-list');
  if (container) {
    container.innerHTML =
      '<div class="admin-empty-state">' +
        '<div class="admin-empty-icon">' +
          '<i class="bi bi-arrow-clockwise spin"></i>' +
        '</div>' +
        '<p class="admin-empty-text">Cargando usuarios...</p>' +
      '</div>';
  }

  authFetch('/admin/users')
    .then(function(res) {
      if (!res || !res.ok) throw new Error('Failed to load users');
      return res.json();
    })
    .then(function(data) {
      adminUsers = data.users || [];
      adminLoaded = true;
      updateAdminStats();
      filterAndRenderUsers();
    })
    .catch(function(err) {
      console.error('Error loading admin users:', err);
      if (container) {
        container.innerHTML =
          '<div class="admin-empty-state">' +
            '<div class="admin-empty-icon" style="background:rgba(248,113,113,0.12);">' +
              '<i class="bi bi-exclamation-triangle" style="color:var(--danger);"></i>' +
            '</div>' +
            '<p class="admin-empty-text" style="color:var(--danger);">Error al cargar usuarios</p>' +
            '<p class="admin-empty-subtext">Verifica la conexion e intenta de nuevo</p>' +
          '</div>';
      }
    });
}

function updateAdminStats() {
  var total = adminUsers.length;
  var active = 0;
  var suspended = 0;
  var trial = 0;
  var paid = 0;

  adminUsers.forEach(function(u) {
    var status = u.status || 'active';
    if (status === 'active') active++;
    if (status === 'suspended') suspended++;
    if (u.plan === 'trial') trial++;
    if (u.plan === 'active') paid++;
  });

  var el;
  el = document.getElementById('admin-stat-total');
  if (el) el.textContent = total;
  el = document.getElementById('admin-stat-active');
  if (el) el.textContent = active;
  el = document.getElementById('admin-stat-suspended');
  if (el) el.textContent = suspended;
  el = document.getElementById('admin-stat-trial');
  if (el) el.textContent = trial;
  el = document.getElementById('admin-stat-paid');
  if (el) el.textContent = paid;
}

function filterAndRenderUsers() {
  var searchInput = document.getElementById('admin-search');
  var filterStatus = document.getElementById('admin-filter-status');
  var filterPlan = document.getElementById('admin-filter-plan');

  var search = (searchInput ? searchInput.value : '').toLowerCase().trim();
  var statusFilter = filterStatus ? filterStatus.value : '';
  var planFilter = filterPlan ? filterPlan.value : '';

  var filtered = adminUsers.filter(function(u) {
    // Search filter
    if (search) {
      var matchEmail = (u.email || '').toLowerCase().indexOf(search) !== -1;
      var matchName = (u.displayName || '').toLowerCase().indexOf(search) !== -1;
      if (!matchEmail && !matchName) return false;
    }

    // Status filter
    if (statusFilter) {
      var userStatus = u.status || 'active';
      if (userStatus !== statusFilter) return false;
    }

    // Plan filter
    if (planFilter && u.plan !== planFilter) return false;

    return true;
  });

  renderUsersCards(filtered);
}

function renderUsersCards(users) {
  var container = document.getElementById('admin-users-list');
  if (!container) return;

  if (users.length === 0) {
    container.innerHTML =
      '<div class="admin-empty-state">' +
        '<div class="admin-empty-icon">' +
          '<i class="bi bi-person-slash"></i>' +
        '</div>' +
        '<p class="admin-empty-text">No se encontraron usuarios</p>' +
        '<p class="admin-empty-subtext">Intenta ajustar los filtros de busqueda</p>' +
      '</div>';
    return;
  }

  var html = '';
  users.forEach(function(user) {
    var status = user.status || 'active';
    var isCurrentUser = window.userProfile && user.uid === window.userProfile.uid;
    var countryFlag = getCountryFlag(user.country);
    var lastLoginText = timeAgo(user.lastLoginAt);

    html += '<div class="admin-user-card" data-uid="' + user.uid + '">';

    // Header: email + name
    html += '<div class="admin-user-header">';
    html += '<div class="admin-user-identity">';
    html += '<i class="bi bi-person-circle admin-user-avatar"></i>';
    html += '<div>';
    html += '<div class="admin-user-email">' + escapeHtml(user.email || '-') + '</div>';
    html += '<div class="admin-user-name">' + escapeHtml(user.displayName || '-') + '</div>';
    html += '</div>';
    html += '</div>';
    if (isCurrentUser) {
      html += '<span class="admin-badge-you">Tu cuenta</span>';
    }
    html += '</div>';

    // Meta row: plan, status, country, phone, last login
    html += '<div class="admin-user-meta">';
    html += '<div class="admin-meta-item">';
    html += '<span class="admin-meta-label">Plan</span>';
    html += getPlanBadge(user.plan, user.role);
    html += '</div>';
    html += '<div class="admin-meta-item">';
    html += '<span class="admin-meta-label">Estado</span>';
    html += getStatusBadge(status);
    html += '</div>';
    html += '<div class="admin-meta-item">';
    html += '<span class="admin-meta-label">Pais</span>';
    html += '<span class="admin-meta-value">' + countryFlag + ' ' + escapeHtml(user.country || '-') + '</span>';
    html += '</div>';
    html += '<div class="admin-meta-item">';
    html += '<span class="admin-meta-label">Telefono</span>';
    html += '<span class="admin-meta-value">' + escapeHtml(user.whatsappPhone ? formatPhone(user.whatsappPhone) : '-') + '</span>';
    html += '</div>';
    html += '<div class="admin-meta-item">';
    html += '<span class="admin-meta-label">Ultimo login</span>';
    html += '<span class="admin-meta-value">' + lastLoginText + '</span>';
    html += '</div>';
    html += '</div>';

    // Actions
    if (!isCurrentUser) {
      html += '<div class="admin-user-actions">';
      html += '<div class="admin-actions-left">';

      // Status toggle buttons
      if (status === 'active') {
        html += '<button class="btn-admin btn-admin-warn" onclick="adminChangeStatus(\'' + user.uid + '\', \'suspended\')" title="Suspender">';
        html += '<i class="bi bi-pause-circle"></i> Suspender</button>';
        html += '<button class="btn-admin btn-admin-danger" onclick="adminChangeStatus(\'' + user.uid + '\', \'disabled\')" title="Deshabilitar">';
        html += '<i class="bi bi-x-circle"></i></button>';
      } else if (status === 'suspended') {
        html += '<button class="btn-admin btn-admin-success" onclick="adminChangeStatus(\'' + user.uid + '\', \'active\')" title="Activar">';
        html += '<i class="bi bi-check-circle"></i> Activar</button>';
        html += '<button class="btn-admin btn-admin-danger" onclick="adminChangeStatus(\'' + user.uid + '\', \'disabled\')" title="Deshabilitar">';
        html += '<i class="bi bi-x-circle"></i></button>';
      } else {
        html += '<button class="btn-admin btn-admin-success" onclick="adminChangeStatus(\'' + user.uid + '\', \'active\')" title="Activar">';
        html += '<i class="bi bi-check-circle"></i> Activar</button>';
      }

      // Plan dropdown
      html += '<select class="admin-plan-select" onchange="adminChangePlan(\'' + user.uid + '\', this.value)" title="Cambiar plan">';
      html += '<option value="">Plan...</option>';
      html += '<option value="trial"' + (user.plan === 'trial' ? ' selected' : '') + '>Trial</option>';
      html += '<option value="active"' + (user.plan === 'active' ? ' selected' : '') + '>Activo</option>';
      html += '<option value="expired"' + (user.plan === 'expired' ? ' selected' : '') + '>Expirado</option>';
      html += '</select>';

      html += '</div>';
      html += '<div class="admin-actions-right">';

      // Cleanup button
      html += '<button class="btn-admin btn-admin-outline" onclick="adminCleanupUser(\'' + user.uid + '\')" title="Limpiar datos">';
      html += '<i class="bi bi-trash3"></i> Limpiar</button>';

      // Delete button
      html += '<button class="btn-admin btn-admin-danger" onclick="adminDeleteUser(\'' + user.uid + '\', \'' + escapeHtml(user.email || '') + '\')" title="Eliminar usuario">';
      html += '<i class="bi bi-person-x"></i> Eliminar</button>';

      html += '</div>';
      html += '</div>';
    }

    html += '</div>';
  });

  container.innerHTML = html;
}

// ── Helper Functions ──

function timeAgo(dateVal) {
  if (!dateVal) return '-';
  try {
    var d;
    if (dateVal._seconds) {
      d = new Date(dateVal._seconds * 1000);
    } else if (dateVal.seconds) {
      d = new Date(dateVal.seconds * 1000);
    } else {
      d = new Date(dateVal);
    }
    if (isNaN(d.getTime())) return '-';

    var now = new Date();
    var diffMs = now - d;
    var diffSec = Math.floor(diffMs / 1000);
    var diffMin = Math.floor(diffSec / 60);
    var diffHour = Math.floor(diffMin / 60);
    var diffDay = Math.floor(diffHour / 24);
    var diffMonth = Math.floor(diffDay / 30);

    if (diffSec < 60) return 'hace un momento';
    if (diffMin === 1) return 'hace 1 minuto';
    if (diffMin < 60) return 'hace ' + diffMin + ' minutos';
    if (diffHour === 1) return 'hace 1 hora';
    if (diffHour < 24) return 'hace ' + diffHour + ' horas';
    if (diffDay === 1) return 'hace 1 dia';
    if (diffDay < 30) return 'hace ' + diffDay + ' dias';
    if (diffMonth === 1) return 'hace 1 mes';
    if (diffMonth < 12) return 'hace ' + diffMonth + ' meses';
    // Fallback to date for very old
    return d.toLocaleDateString('es-PY', { day: '2-digit', month: '2-digit', year: '2-digit' });
  } catch (e) {
    return '-';
  }
}

function getCountryFlag(country) {
  if (!country) return '';
  var flags = {
    'PY': '\uD83C\uDDF5\uD83C\uDDFE',
    'AR': '\uD83C\uDDE6\uD83C\uDDF7',
    'BR': '\uD83C\uDDE7\uD83C\uDDF7',
    'UY': '\uD83C\uDDFA\uD83C\uDDFE',
    'CL': '\uD83C\uDDE8\uD83C\uDDF1',
    'CO': '\uD83C\uDDE8\uD83C\uDDF4',
    'PE': '\uD83C\uDDF5\uD83C\uDDEA',
    'MX': '\uD83C\uDDF2\uD83C\uDDFD',
    'US': '\uD83C\uDDFA\uD83C\uDDF8',
    'ES': '\uD83C\uDDEA\uD83C\uDDF8'
  };
  var code = country.toUpperCase().trim();
  return flags[code] || '';
}

function formatPhone(phone) {
  if (!phone) return '-';
  // Format as +595 XXX XXX XXX
  var p = String(phone).replace(/\D/g, '');
  if (p.length === 12 && p.indexOf('595') === 0) {
    return '+' + p.substr(0, 3) + ' ' + p.substr(3, 3) + ' ' + p.substr(6, 3) + ' ' + p.substr(9);
  }
  return '+' + p;
}

function getStatusBadge(status) {
  var classes = {
    active: 'admin-status-active',
    suspended: 'admin-status-suspended',
    disabled: 'admin-status-disabled'
  };
  var icons = {
    active: 'bi-check-circle-fill',
    suspended: 'bi-pause-circle-fill',
    disabled: 'bi-x-circle-fill'
  };
  var labels = { active: 'Activo', suspended: 'Suspendido', disabled: 'Deshabilitado' };
  var cls = classes[status] || classes.active;
  var icon = icons[status] || icons.active;
  var label = labels[status] || status;
  return '<span class="admin-badge ' + cls + '"><i class="bi ' + icon + '"></i> ' + label + '</span>';
}

function getPlanBadge(plan, role) {
  if (role === 'admin') {
    return '<span class="admin-badge admin-plan-admin"><i class="bi bi-shield-fill"></i> Admin</span>';
  }
  var classes = {
    active: 'admin-plan-active',
    trial: 'admin-plan-trial',
    expired: 'admin-plan-expired'
  };
  var icons = {
    active: 'bi-check-circle-fill',
    trial: 'bi-clock-fill',
    expired: 'bi-x-circle-fill'
  };
  var labels = { active: 'Activo', trial: 'Trial', expired: 'Expirado' };
  var cls = classes[plan] || '';
  var icon = icons[plan] || 'bi-question-circle';
  var label = labels[plan] || plan || '-';
  return '<span class="admin-badge ' + cls + '"><i class="bi ' + icon + '"></i> ' + label + '</span>';
}

function formatAdminDate(dateVal) {
  if (!dateVal) return '-';
  try {
    var d;
    if (dateVal._seconds) {
      d = new Date(dateVal._seconds * 1000);
    } else if (dateVal.seconds) {
      d = new Date(dateVal.seconds * 1000);
    } else {
      d = new Date(dateVal);
    }
    if (isNaN(d.getTime())) return '-';
    return d.toLocaleDateString('es-PY', { day: '2-digit', month: '2-digit', year: '2-digit' }) +
      ' ' + d.toLocaleTimeString('es-PY', { hour: '2-digit', minute: '2-digit' });
  } catch (e) {
    return '-';
  }
}

function escapeHtml(text) {
  var div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// ── Admin Actions ──

function adminChangeStatus(userId, newStatus) {
  var actionLabels = {
    active: 'activar',
    suspended: 'suspender',
    disabled: 'deshabilitar'
  };
  var label = actionLabels[newStatus] || newStatus;

  if (!confirm('Estas seguro de que deseas ' + label + ' a este usuario?')) return;

  var reason = '';
  if (newStatus !== 'active') {
    reason = prompt('Motivo (opcional):') || '';
  }

  authFetch('/admin/users/' + userId + '/status', {
    method: 'PUT',
    body: JSON.stringify({ status: newStatus, reason: reason })
  })
    .then(function(res) {
      if (!res || !res.ok) return res.json().then(function(b) { throw new Error(b.error || 'Error'); });
      return res.json();
    })
    .then(function() {
      showAlert('Estado del usuario actualizado a: ' + label, 'success');
      loadAdmin(true);
    })
    .catch(function(err) {
      showAlert('Error: ' + err.message, 'danger');
    });
}

function adminChangePlan(userId, newPlan) {
  if (!newPlan) return;

  var trialEndsAt = null;
  if (newPlan === 'trial') {
    trialEndsAt = new Date(Date.now() + 15 * 24 * 60 * 60 * 1000).toISOString();
  }

  authFetch('/admin/users/' + userId + '/plan', {
    method: 'PUT',
    body: JSON.stringify({ plan: newPlan, trialEndsAt: trialEndsAt })
  })
    .then(function(res) {
      if (!res || !res.ok) return res.json().then(function(b) { throw new Error(b.error || 'Error'); });
      return res.json();
    })
    .then(function() {
      showAlert('Plan actualizado a: ' + newPlan, 'success');
      loadAdmin(true);
    })
    .catch(function(err) {
      showAlert('Error: ' + err.message, 'danger');
    });
}

function adminCleanupUser(userId) {
  if (!confirm('Esto limpiara los datos de Redis del usuario (sesiones, colas, etc). Continuar?')) return;

  authFetch('/admin/users/' + userId + '/cleanup', {
    method: 'POST',
    body: JSON.stringify({ keepAuth: false })
  })
    .then(function(res) {
      if (!res || !res.ok) return res.json().then(function(b) { throw new Error(b.error || 'Error'); });
      return res.json();
    })
    .then(function() {
      showAlert('Datos del usuario limpiados correctamente', 'success');
    })
    .catch(function(err) {
      showAlert('Error: ' + err.message, 'danger');
    });
}

function adminDeleteUser(userId, email) {
  if (!confirm('ATENCION: Esto eliminara permanentemente al usuario ' + email + ' y todos sus datos. Esta accion NO se puede deshacer. Continuar?')) return;
  if (!confirm('Confirmar eliminacion de ' + email + '?')) return;

  authFetch('/admin/users/' + userId, {
    method: 'DELETE'
  })
    .then(function(res) {
      if (!res || !res.ok) return res.json().then(function(b) { throw new Error(b.error || 'Error'); });
      return res.json();
    })
    .then(function() {
      showAlert('Usuario ' + email + ' eliminado', 'success');
      loadAdmin(true);
    })
    .catch(function(err) {
      showAlert('Error: ' + err.message, 'danger');
    });
}

// Global exports
window.initAdmin = initAdmin;
window.loadAdmin = loadAdmin;
window.adminChangeStatus = adminChangeStatus;
window.adminChangePlan = adminChangePlan;
window.adminCleanupUser = adminCleanupUser;
window.adminDeleteUser = adminDeleteUser;
