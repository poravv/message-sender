/**
 * Campaigns - Campaign history and analytics
 */

var campaignsState = {
  items: [],
  total: 0,
  page: 1,
  pageSize: 20,
  search: '',
  dateFrom: '',
  dateTo: ''
};

function initCampaigns() {
  // Event listeners are set up via inline handlers in HTML
}

function loadCampaigns() {
  fetchCampaigns();
}

async function fetchCampaigns(page) {
  campaignsState.page = page || 1;

  var params = buildQuery({
    page: campaignsState.page,
    pageSize: campaignsState.pageSize,
    search: campaignsState.search,
    dateFrom: campaignsState.dateFrom,
    dateTo: campaignsState.dateTo
  });

  try {
    var res = await authFetch('/campaigns' + params);
    if (!res || !res.ok) {
      showAlert('Error al cargar campanas', 'danger');
      return;
    }
    var data = await res.json();
    campaignsState.items = data.items || [];
    campaignsState.total = data.total || 0;
    campaignsState.page = data.page || 1;
    campaignsState.pageSize = data.pageSize || 20;
    renderCampaignList();
  } catch (e) {
    showAlert('Error al cargar campanas', 'danger');
  }
}

function renderCampaignList() {
  var container = document.getElementById('campaigns-list');
  if (!container) return;

  if (campaignsState.items.length === 0) {
    container.innerHTML =
      '<div class="campaigns-empty">' +
        '<div class="campaigns-empty-icon"><i class="bi bi-megaphone"></i></div>' +
        '<p>No hay campanas registradas</p>' +
        '<p class="text-muted">Las campanas que envies apareceran aqui</p>' +
      '</div>';
    return;
  }

  var html = '';
  campaignsState.items.forEach(function(c) {
    var total = c.totalRecipients || c.total_recipients || 0;
    var sent = c.sentCount || c.sent_count || 0;
    var errors = c.errorCount || c.error_count || 0;
    var successRate = total > 0 ? ((sent / total) * 100).toFixed(1) : '0';
    var status = c.status || 'unknown';
    var createdAt = c.createdAt || c.created_at;
    var dateStr = createdAt ? new Date(createdAt).toLocaleDateString('es', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';

    var statusBadge = '';
    switch (status) {
      case 'completed':
        statusBadge = '<span class="camp-status camp-status-done"><i class="bi bi-check-circle"></i> Completada</span>';
        break;
      case 'in_progress':
      case 'sending':
        statusBadge = '<span class="camp-status camp-status-progress"><i class="bi bi-arrow-repeat"></i> En progreso</span>';
        break;
      case 'queued':
        statusBadge = '<span class="camp-status camp-status-queued"><i class="bi bi-clock"></i> En cola</span>';
        break;
      case 'cancelled':
        statusBadge = '<span class="camp-status camp-status-cancelled"><i class="bi bi-x-circle"></i> Cancelada</span>';
        break;
      default:
        statusBadge = '<span class="camp-status camp-status-unknown"><i class="bi bi-question-circle"></i> ' + escapeHtmlCamp(status) + '</span>';
    }

    // Progress bar
    var progressPct = total > 0 ? Math.round(((sent + errors) / total) * 100) : 0;

    html +=
      '<div class="camp-card">' +
        '<div class="camp-card-header">' +
          '<div class="camp-card-title">' +
            '<i class="bi bi-megaphone camp-icon"></i>' +
            '<div>' +
              '<h3>' + escapeHtmlCamp(c.name || 'Sin nombre') + '</h3>' +
              '<span class="camp-date">' + dateStr + '</span>' +
            '</div>' +
          '</div>' +
          statusBadge +
        '</div>' +
        '<div class="camp-card-stats">' +
          '<div class="camp-stat">' +
            '<span class="camp-stat-value">' + total + '</span>' +
            '<span class="camp-stat-label">Destinatarios</span>' +
          '</div>' +
          '<div class="camp-stat camp-stat-success">' +
            '<span class="camp-stat-value">' + sent + '</span>' +
            '<span class="camp-stat-label">Enviados</span>' +
          '</div>' +
          '<div class="camp-stat camp-stat-error">' +
            '<span class="camp-stat-value">' + errors + '</span>' +
            '<span class="camp-stat-label">Errores</span>' +
          '</div>' +
          '<div class="camp-stat">' +
            '<span class="camp-stat-value">' + successRate + '%</span>' +
            '<span class="camp-stat-label">Exito</span>' +
          '</div>' +
        '</div>' +
        '<div class="camp-progress-bar">' +
          '<div class="camp-progress-fill" style="width: ' + progressPct + '%"></div>' +
        '</div>' +
        '<div class="camp-card-actions">' +
          '<button class="btn-secondary btn-sm" onclick="viewCampaignDetail(\'' + c.id + '\')">' +
            '<i class="bi bi-eye"></i> Ver detalle' +
          '</button>' +
        '</div>' +
      '</div>';
  });

  container.innerHTML = html;

  // Render pagination
  renderCampaignPagination();
}

function renderCampaignPagination() {
  var container = document.getElementById('campaigns-pagination');
  if (!container) return;

  var totalPages = Math.ceil(campaignsState.total / campaignsState.pageSize);
  if (totalPages <= 1) {
    container.innerHTML = '';
    return;
  }

  var html = '<div class="camp-pagination">';
  html += '<button class="btn-icon" ' + (campaignsState.page <= 1 ? 'disabled' : '') + ' onclick="fetchCampaigns(' + (campaignsState.page - 1) + ')"><i class="bi bi-chevron-left"></i></button>';
  html += '<span class="camp-page-info">Pagina ' + campaignsState.page + ' de ' + totalPages + '</span>';
  html += '<button class="btn-icon" ' + (campaignsState.page >= totalPages ? 'disabled' : '') + ' onclick="fetchCampaigns(' + (campaignsState.page + 1) + ')"><i class="bi bi-chevron-right"></i></button>';
  html += '</div>';

  container.innerHTML = html;
}

async function viewCampaignDetail(campaignId) {
  // Show modal with loading
  var modal = document.getElementById('campaignDetailModal');
  var body = document.getElementById('campaign-detail-body');
  if (!modal || !body) return;

  modal.classList.remove('d-none');
  body.innerHTML = '<div class="campaigns-empty"><div class="spinner"></div><p>Cargando...</p></div>';

  try {
    // Fetch campaign detail and responses in parallel
    var detailRes = await authFetch('/campaigns/' + campaignId);
    if (!detailRes || !detailRes.ok) {
      body.innerHTML = '<div class="campaigns-empty"><p>Error al cargar detalle</p></div>';
      return;
    }
    var detail = await detailRes.json();

    var responsesRes = await authFetch('/campaigns/' + campaignId + '/responses');
    var responsesData = responsesRes && responsesRes.ok ? await responsesRes.json() : { responses: [], count: 0 };

    renderCampaignDetail(detail, responsesData, campaignId);
  } catch (e) {
    body.innerHTML = '<div class="campaigns-empty"><p>Error al cargar detalle</p></div>';
  }
}

function renderCampaignDetail(detail, responsesData, campaignId) {
  var body = document.getElementById('campaign-detail-body');
  if (!body) return;

  var c = detail.campaign || {};
  var recipients = detail.recipients || [];
  var total = c.totalRecipients || c.total_recipients || recipients.length;
  var sent = c.sentCount || c.sent_count || 0;
  var errors = c.errorCount || c.error_count || 0;
  var successRate = total > 0 ? ((sent / total) * 100).toFixed(1) : '0';
  var createdAt = c.createdAt || c.created_at;
  var dateStr = createdAt ? new Date(createdAt).toLocaleDateString('es', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
  var responseCount = responsesData.count || 0;

  var html =
    '<div class="camp-detail-summary">' +
      '<h3>' + escapeHtmlCamp(c.name || 'Sin nombre') + '</h3>' +
      '<p class="camp-date">' + dateStr + '</p>' +
      '<div class="camp-card-stats camp-detail-stats">' +
        '<div class="camp-stat">' +
          '<span class="camp-stat-value">' + total + '</span>' +
          '<span class="camp-stat-label">Destinatarios</span>' +
        '</div>' +
        '<div class="camp-stat camp-stat-success">' +
          '<span class="camp-stat-value">' + sent + '</span>' +
          '<span class="camp-stat-label">Enviados</span>' +
        '</div>' +
        '<div class="camp-stat camp-stat-error">' +
          '<span class="camp-stat-value">' + errors + '</span>' +
          '<span class="camp-stat-label">Errores</span>' +
        '</div>' +
        '<div class="camp-stat">' +
          '<span class="camp-stat-value">' + successRate + '%</span>' +
          '<span class="camp-stat-label">Exito</span>' +
        '</div>' +
        '<div class="camp-stat camp-stat-replies">' +
          '<span class="camp-stat-value">' + responseCount + '</span>' +
          '<span class="camp-stat-label">Respuestas</span>' +
        '</div>' +
      '</div>' +
    '</div>';

  // Export button
  html += '<div class="camp-detail-actions">' +
    '<button class="btn-primary btn-sm" onclick="exportCampaign(\'' + campaignId + '\')">' +
      '<i class="bi bi-download"></i> Exportar CSV' +
    '</button>' +
  '</div>';

  // Recipients table
  if (recipients.length > 0) {
    html += '<div class="camp-recipients-section">' +
      '<h4>Destinatarios</h4>' +
      '<div class="camp-table-wrap">' +
        '<table class="data-table">' +
          '<thead><tr>' +
            '<th>Telefono</th>' +
            '<th>Nombre</th>' +
            '<th>Estado</th>' +
            '<th>Error</th>' +
          '</tr></thead><tbody>';

    recipients.forEach(function(r) {
      var phone = r.phone || '';
      var nombre = r.nombre || r.name || '-';
      var status = r.status || 'queued';
      var error = r.errorMessage || r.error_message || '';

      var statusHtml = '';
      switch (status) {
        case 'sent':
          statusHtml = '<span class="camp-recip-sent"><i class="bi bi-check-circle"></i> Enviado</span>';
          break;
        case 'error':
        case 'failed':
          statusHtml = '<span class="camp-recip-error"><i class="bi bi-x-circle"></i> Error</span>';
          break;
        case 'queued':
          statusHtml = '<span class="camp-recip-queued"><i class="bi bi-clock"></i> En cola</span>';
          break;
        default:
          statusHtml = '<span>' + escapeHtmlCamp(status) + '</span>';
      }

      html += '<tr>' +
        '<td>' + escapeHtmlCamp(phone) + '</td>' +
        '<td>' + escapeHtmlCamp(nombre) + '</td>' +
        '<td>' + statusHtml + '</td>' +
        '<td class="camp-error-cell">' + escapeHtmlCamp(error) + '</td>' +
      '</tr>';
    });

    html += '</tbody></table></div></div>';
  }

  body.innerHTML = html;
}

function closeCampaignModal() {
  var modal = document.getElementById('campaignDetailModal');
  if (modal) modal.classList.add('d-none');
}

function exportCampaign(campaignId) {
  // Re-fetch and build CSV
  authFetch('/campaigns/' + campaignId).then(function(res) {
    if (!res || !res.ok) {
      showAlert('Error al exportar', 'danger');
      return;
    }
    return res.json();
  }).then(function(detail) {
    if (!detail) return;
    var c = detail.campaign || {};
    var recipients = detail.recipients || [];

    var csv = 'Telefono,Nombre,Grupo,Estado,Error,Enviado\n';
    recipients.forEach(function(r) {
      csv += '"' + (r.phone || '') + '",';
      csv += '"' + (r.nombre || r.name || '') + '",';
      csv += '"' + (r.grupo || r.group || '') + '",';
      csv += '"' + (r.status || '') + '",';
      csv += '"' + (r.errorMessage || r.error_message || '') + '",';
      csv += '"' + (r.sentAt || r.sent_at || '') + '"\n';
    });

    var blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8;' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = 'campana-' + (c.name || campaignId) + '.csv';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }).catch(function() {
    showAlert('Error al exportar', 'danger');
  });
}

function handleCampaignSearch() {
  var searchEl = document.getElementById('campaign-search');
  var dateFromEl = document.getElementById('campaign-date-from');
  var dateToEl = document.getElementById('campaign-date-to');

  campaignsState.search = searchEl ? searchEl.value : '';
  campaignsState.dateFrom = dateFromEl ? dateFromEl.value : '';
  campaignsState.dateTo = dateToEl ? dateToEl.value : '';

  fetchCampaigns(1);
}

function escapeHtmlCamp(str) {
  if (!str) return '';
  var div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// Exports
window.initCampaigns = initCampaigns;
window.loadCampaigns = loadCampaigns;
window.fetchCampaigns = fetchCampaigns;
window.viewCampaignDetail = viewCampaignDetail;
window.closeCampaignModal = closeCampaignModal;
window.exportCampaign = exportCampaign;
window.handleCampaignSearch = handleCampaignSearch;
