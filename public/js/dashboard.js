/**
 * Dashboard - Analytics and Statistics
 */

let timelineChartInstance = null;
let pieChartInstance = null;

// Date Range Helpers
function getDateRangePreset(preset) {
  const now = new Date();
  const to = now.toISOString().slice(0, 10);
  let from;

  switch (preset) {
    case '7d':
      from = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      break;
    case '30d':
      from = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      break;
    case 'month':
      from = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0, 10);
      break;
    case '90d':
      from = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      break;
    default:
      from = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  }

  return { from, to };
}

function ensureDateDefaults() {
  const fromInput = document.getElementById('dashboardFrom');
  const toInput = document.getElementById('dashboardTo');
  if (!fromInput || !toInput) return null;

  const range = getDateRangePreset('30d');
  if (!fromInput.value) fromInput.value = range.from;
  if (!toInput.value) toInput.value = range.to;

  return { from: fromInput.value, to: toInput.value };
}

// Setup date preset buttons
function setupDatePresets() {
  const presets = ['7d', '30d', 'month', '90d'];

  presets.forEach(preset => {
    const btnId = preset === 'month' ? 'presetMonth' : `preset${preset.toUpperCase()}`;
    const btn = document.getElementById(btnId);
    if (!btn) return;

    btn.addEventListener('click', () => {
      // Remove active from all
      presets.forEach(p => {
        const id = p === 'month' ? 'presetMonth' : `preset${p.toUpperCase()}`;
        const b = document.getElementById(id);
        if (b) b.classList.remove('active');
      });
      btn.classList.add('active');

      // Set date range
      const range = getDateRangePreset(preset);
      const fromInput = document.getElementById('dashboardFrom');
      const toInput = document.getElementById('dashboardTo');
      if (fromInput) fromInput.value = range.from;
      if (toInput) toInput.value = range.to;

      loadDashboard();
    });
  });

  // Refresh button
  const refreshBtn = document.getElementById('refreshDashboardBtn');
  if (refreshBtn) {
    refreshBtn.addEventListener('click', loadDashboard);
  }
}

// Load Dashboard Data
async function loadDashboard() {
  try {
    const dates = ensureDateDefaults();
    if (!dates) return;

    const { from, to } = dates;

    const [summaryRes, timelineRes, groupRes, currentMonthRes] = await Promise.all([
      authFetch(`/dashboard/summary${buildQuery({ from, to })}`),
      authFetch(`/dashboard/timeline${buildQuery({ from, to, bucket: 'day' })}`),
      authFetch(`/dashboard/by-group${buildQuery({ from, to })}`),
      authFetch('/dashboard/current-month')
    ]);

    const summary = await summaryRes.json();
    const timeline = await timelineRes.json();
    const byGroup = await groupRes.json();
    const currentMonth = await currentMonthRes.json();

    updateSummaryCards(summary, currentMonth);
    renderTimelineChart(timeline.rows || []);
    renderPieChart(byGroup.rows || [], summary);
    renderActivityBars(timeline.rows || []);

    // Load extra data for new dashboard sections
    loadContactsCount();
    loadRecentCampaigns();
    updateDashConnectionStatus();

  } catch (error) {
    console.error('Error loading dashboard:', error);
  }
}

// Update summary cards
function updateSummaryCards(summary, currentMonth) {
  const totalSent = Number(summary.sent ?? summary.totalSent ?? 0);
  const totalErrors = Number(summary.errors ?? summary.totalErrors ?? 0);
  const delivered = Number(summary.delivered ?? (totalSent + totalErrors));
  const totalSuccess = Number(summary.totalSuccess ?? totalSent);
  const campaigns = Number(summary.campaigns ?? 0);
  const monthSent = Number(currentMonth.sent || 0);
  const monthRate = Number(currentMonth.successRate || 0);
  const delta = Number(currentMonth.deltaPercent || 0);

  // Summary values
  const els = {
    totalSent: document.getElementById('statTotalSent'),
    totalSuccess: document.getElementById('statTotalSuccess'),
    successRate: document.getElementById('statSuccessRate'),
    totalErrors: document.getElementById('statTotalErrors'),
    campaigns: document.getElementById('statCampaigns'),
    monthSent: document.getElementById('statMonthSent'),
    monthRate: document.getElementById('statMonthRate'),
    monthDelta: document.getElementById('statMonthDelta')
  };

  if (els.totalSent) els.totalSent.textContent = delivered.toLocaleString();
  if (els.totalSuccess) els.totalSuccess.textContent = totalSent.toLocaleString();
  if (els.totalErrors) els.totalErrors.textContent = totalErrors.toLocaleString();
  if (els.campaigns) els.campaigns.textContent = campaigns.toLocaleString();
  if (els.monthSent) els.monthSent.textContent = monthSent.toLocaleString();

  if (els.successRate) {
    const rate = delivered > 0
      ? Number(summary.successRate ?? ((totalSuccess / delivered) * 100)).toFixed(1)
      : 0;
    els.successRate.textContent = `${rate}%`;
  }

  if (els.monthRate) {
    els.monthRate.textContent = `${monthRate.toFixed(1)}%`;
  }

  if (els.monthDelta) {
    const sign = delta >= 0 ? '+' : '';
    els.monthDelta.textContent = `${sign}${delta.toFixed(1)}% vs mes anterior`;
    els.monthDelta.className = delta >= 0 ? 'dash-month-delta positive' : 'dash-month-delta negative';
  }
}

// Render Timeline Chart
function renderTimelineChart(rows) {
  const ctx = document.getElementById('timelineChart');
  if (!ctx) return;

  if (timelineChartInstance) {
    timelineChartInstance.destroy();
  }

  const labels = rows.map(r => {
    const bucket = String(r.bucket || r.date || '').trim();
    if (!bucket) return '';

    if (/^\d{4}-\d{2}-\d{2}$/.test(bucket)) {
      const [y, m, d] = bucket.split('-').map(Number);
      const dt = new Date(y, m - 1, d);
      return dt.toLocaleDateString('es-ES', { day: '2-digit', month: 'short' });
    }

    if (/^\d{4}-\d{2}$/.test(bucket)) {
      const [y, m] = bucket.split('-').map(Number);
      const dt = new Date(y, m - 1, 1);
      return dt.toLocaleDateString('es-ES', { month: 'short', year: '2-digit' });
    }

    const parsed = new Date(bucket);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed.toLocaleDateString('es-ES', { day: '2-digit', month: 'short' });
    }

    return bucket;
  });
  const sentData = rows.map(r => Number(r.sent || 0));
  const errorData = rows.map(r => Number(r.errors || 0));

  const textColor = getChartTextColor();

  timelineChartInstance = new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [
        {
          label: 'Enviados',
          data: sentData,
          borderColor: '#4ade80',
          backgroundColor: 'rgba(74, 222, 128, 0.1)',
          fill: true,
          tension: 0.4,
          pointRadius: 4,
          pointHoverRadius: 6
        },
        {
          label: 'Errores',
          data: errorData,
          borderColor: '#f87171',
          backgroundColor: 'rgba(248, 113, 113, 0.1)',
          fill: true,
          tension: 0.4,
          pointRadius: 4,
          pointHoverRadius: 6
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: {
        intersect: false,
        mode: 'index'
      },
      plugins: {
        legend: {
          display: false
        },
        tooltip: {
          backgroundColor: 'rgba(0, 0, 0, 0.8)',
          titleColor: '#fff',
          bodyColor: '#fff',
          padding: 12,
          cornerRadius: 8
        }
      },
      scales: {
        x: {
          grid: { display: false },
          ticks: { color: textColor }
        },
        y: {
          beginAtZero: true,
          grid: { color: 'rgba(255, 255, 255, 0.05)' },
          ticks: { color: textColor }
        }
      }
    }
  });
}

// Render Pie Chart (Success vs Errors)
function renderPieChart(groupRows, summary) {
  const ctx = document.getElementById('pieChart');
  if (!ctx) return;

  if (pieChartInstance) {
    pieChartInstance.destroy();
  }

  const totalSuccess = Number(summary.sent ?? summary.totalSuccess ?? 0);
  const totalErrors = Number(summary.errors ?? summary.totalErrors ?? 0);

  pieChartInstance = new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels: ['Exitosos', 'Fallidos'],
      datasets: [{
        data: [totalSuccess, totalErrors],
        backgroundColor: ['#4ade80', '#f87171'],
        borderWidth: 0,
        hoverOffset: 8
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      cutout: '65%',
      plugins: {
        legend: {
          position: 'bottom',
          labels: {
            color: getChartTextColor(),
            padding: 20,
            usePointStyle: true,
            pointStyle: 'circle'
          }
        },
        tooltip: {
          backgroundColor: 'rgba(0, 0, 0, 0.8)',
          padding: 12,
          cornerRadius: 8,
          callbacks: {
            label: function(context) {
              const total = context.dataset.data.reduce((a, b) => a + b, 0);
              const percentage = total > 0 ? ((context.raw / total) * 100).toFixed(1) : 0;
              return `${context.label}: ${context.raw.toLocaleString()} (${percentage}%)`;
            }
          }
        }
      }
    }
  });
}

// Render Activity Bars (last 7 days from timeline data)
function renderActivityBars(rows) {
  const container = document.getElementById('dashActivityBars');
  if (!container) return;

  // Get last 7 entries
  const recent = rows.slice(-7);

  if (recent.length === 0) {
    container.innerHTML = '<div class="dash-activity-empty">Sin datos de actividad</div>';
    return;
  }

  // Find max for scaling
  const maxVal = Math.max(1, ...recent.map(r => Number(r.sent || 0) + Number(r.errors || 0)));

  const dayNames = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];

  container.innerHTML = recent.map(r => {
    const bucket = String(r.bucket || r.date || '').trim();
    const sent = Number(r.sent || 0);
    const errors = Number(r.errors || 0);
    const total = sent + errors;
    const sentPct = maxVal > 0 ? (sent / maxVal) * 100 : 0;
    const errorPct = maxVal > 0 ? (errors / maxVal) * 100 : 0;

    let dayLabel = bucket.slice(-2);
    if (/^\d{4}-\d{2}-\d{2}$/.test(bucket)) {
      const [y, m, d] = bucket.split('-').map(Number);
      const dt = new Date(y, m - 1, d);
      dayLabel = dayNames[dt.getDay()];
    }

    return `
      <div class="dash-activity-row">
        <span class="dash-activity-day">${dayLabel}</span>
        <div class="dash-activity-bar-wrap">
          <div class="dash-activity-bar-sent" style="width:${sentPct}%"></div>
          <div class="dash-activity-bar-error" style="width:${errorPct}%"></div>
        </div>
        <span class="dash-activity-count">${total}</span>
      </div>
    `;
  }).join('');
}

// Load contacts count
async function loadContactsCount() {
  try {
    const res = await authFetch('/contacts?pageSize=1&page=1');
    if (!res.ok) return;
    const data = await res.json();
    const el = document.getElementById('statContacts');
    if (el) el.textContent = Number(data.total || 0).toLocaleString();
  } catch (e) {
    console.warn('Error loading contacts count:', e);
  }
}

// Load recent campaigns
async function loadRecentCampaigns() {
  const tbody = document.getElementById('dashCampaignsBody');
  if (!tbody) return;

  try {
    const dates = ensureDateDefaults();
    if (!dates) return;

    // Use the timeline endpoint with monthly bucket to get campaign data
    // Since there's no direct campaigns list endpoint, we'll use the by-group endpoint
    // Actually let's try fetching from dashboard summary which includes campaigns count
    const res = await authFetch(`/dashboard/by-group${buildQuery({ from: dates.from, to: dates.to })}`);
    if (!res.ok) {
      tbody.innerHTML = '<tr><td colspan="5" class="dash-campaigns-empty">No se pudieron cargar las campañas</td></tr>';
      return;
    }

    const data = await res.json();
    const groups = data.rows || [];

    if (groups.length === 0) {
      tbody.innerHTML = '<tr><td colspan="5" class="dash-campaigns-empty">No hay campañas en este período</td></tr>';
      return;
    }

    // Show group data as campaign-like rows
    tbody.innerHTML = groups.slice(0, 5).map(g => {
      const sent = Number(g.sent || 0);
      const errors = Number(g.errors || 0);
      const total = sent + errors;
      const rate = total > 0 ? ((sent / total) * 100).toFixed(1) : 0;
      const name = g.grupo || g.group || 'Sin grupo';

      let badgeClass = 'dash-badge-success';
      let badgeText = 'Completado';
      if (rate < 50) {
        badgeClass = 'dash-badge-danger';
        badgeText = 'Con errores';
      } else if (rate < 90) {
        badgeClass = 'dash-badge-warning';
        badgeText = 'Parcial';
      }

      return `
        <tr>
          <td class="dash-campaign-name">${escapeHtml(name)}</td>
          <td class="dash-campaign-date">${dates.from} - ${dates.to}</td>
          <td>${total.toLocaleString()}</td>
          <td>${rate}%</td>
          <td><span class="dash-badge ${badgeClass}">${badgeText}</span></td>
        </tr>
      `;
    }).join('');

  } catch (e) {
    console.warn('Error loading recent campaigns:', e);
    tbody.innerHTML = '<tr><td colspan="5" class="dash-campaigns-empty">Error al cargar campañas</td></tr>';
  }
}

// Escape HTML helper
function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// Update dashboard connection status widget
async function updateDashConnectionStatus() {
  const widget = document.getElementById('dashConnectionWidget');
  const statusEl = document.getElementById('dashConnStatus');
  const actionBtn = document.getElementById('dashConnAction');
  const quickConnBtn = document.getElementById('dashQuickConnectBtn');

  if (!widget) return;

  try {
    const res = await authFetch('/connection-status');
    if (!res.ok) throw new Error('Failed');
    const data = await res.json();

    const status = data?.status || 'disconnected';
    const connected = status === 'connected' || status === 'authenticated';

    widget.classList.remove('connected', 'disconnected');
    widget.classList.add(connected ? 'connected' : 'disconnected');

    if (statusEl) {
      statusEl.textContent = connected ? 'Conectado y listo para enviar' : 'Desconectado';
    }

    if (actionBtn) {
      actionBtn.style.display = connected ? 'none' : 'flex';
    }

    // Hide quick connect button if already connected
    if (quickConnBtn) {
      quickConnBtn.style.display = connected ? 'none' : '';
    }

  } catch (e) {
    widget.classList.remove('connected', 'disconnected');
    widget.classList.add('disconnected');
    if (statusEl) statusEl.textContent = 'No disponible';
    if (actionBtn) actionBtn.style.display = 'flex';
  }
}

// Load quick stats (for header/nav)
async function loadQuickStats() {
  try {
    const now = new Date();
    const from = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString().slice(0, 10);
    const to = now.toISOString().slice(0, 10);

    const res = await authFetch(`/dashboard/summary${buildQuery({ from, to })}`);
    if (!res.ok) return;

    const summary = await res.json();
    const totalSent = Number(summary.sent ?? summary.totalSent ?? 0);
    const totalErrors = Number(summary.errors ?? summary.totalErrors ?? 0);
    const delivered = Number(summary.delivered ?? (totalSent + totalErrors));
    const totalSuccess = Number(summary.totalSuccess ?? totalSent);

    // Quick stat elements
    const todayEl = document.getElementById('quickStatToday');
    const rateEl = document.getElementById('quickStatRate');

    if (todayEl) todayEl.textContent = totalSent.toLocaleString();
    if (rateEl) {
      rateEl.textContent = delivered > 0
        ? `${Number(summary.successRate ?? ((totalSuccess / delivered) * 100)).toFixed(1)}%`
        : '--%';
    }
  } catch (e) {
    console.warn('Error loading quick stats:', e);
  }
}

// Clear user cache
async function clearUserCache() {
  var btn = document.getElementById('clearCacheBtn');
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '<i class="bi bi-hourglass-split"></i>';
  }

  try {
    var res = await authFetch('/cache/user', { method: 'DELETE' });
    if (!res || !res.ok) {
      showAlert('Error al limpiar cache', 'danger');
      return;
    }
    showAlert('Cache limpiado correctamente', 'success');
    loadDashboard();
  } catch (e) {
    console.error('Error clearing cache:', e);
    showAlert('Error al limpiar cache', 'danger');
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = '<i class="bi bi-trash3"></i>';
    }
  }
}

// Initialize Dashboard
function initDashboard() {
  setupDatePresets();
  loadDashboard();
  loadQuickStats();

  // Clear cache button
  var clearBtn = document.getElementById('clearCacheBtn');
  if (clearBtn) {
    clearBtn.addEventListener('click', clearUserCache);
  }

  // Refresh quick stats periodically
  setInterval(loadQuickStats, 60000);

  // Refresh connection status periodically
  setInterval(updateDashConnectionStatus, 30000);
}

// Global exports
window.loadDashboard = loadDashboard;
window.initDashboard = initDashboard;
window.loadQuickStats = loadQuickStats;
