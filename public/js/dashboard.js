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
    
  } catch (error) {
    console.error('Error loading dashboard:', error);
  }
}

// Update summary cards
function updateSummaryCards(summary, currentMonth) {
  const totalSent = Number(summary.totalSent || 0);
  const totalSuccess = Number(summary.totalSuccess || 0);
  const totalErrors = Number(summary.totalErrors || 0);
  const monthSent = Number(currentMonth.sent || 0);
  const monthErrors = Number(currentMonth.errors || 0);
  const monthRate = Number(currentMonth.successRate || 0);
  const delta = Number(currentMonth.deltaPercent || 0);
  
  // Summary values
  const els = {
    totalSent: document.getElementById('statTotalSent'),
    successRate: document.getElementById('statSuccessRate'),
    totalErrors: document.getElementById('statTotalErrors'),
    monthSent: document.getElementById('statMonthSent'),
    monthRate: document.getElementById('statMonthRate'),
    monthDelta: document.getElementById('statMonthDelta')
  };
  
  if (els.totalSent) els.totalSent.textContent = totalSent.toLocaleString();
  if (els.totalErrors) els.totalErrors.textContent = totalErrors.toLocaleString();
  if (els.monthSent) els.monthSent.textContent = monthSent.toLocaleString();
  
  if (els.successRate) {
    const rate = totalSent > 0 ? ((totalSuccess / totalSent) * 100).toFixed(1) : 0;
    els.successRate.textContent = `${rate}%`;
  }
  
  if (els.monthRate) {
    els.monthRate.textContent = `${monthRate.toFixed(1)}%`;
  }
  
  if (els.monthDelta) {
    const sign = delta >= 0 ? '+' : '';
    els.monthDelta.textContent = `${sign}${delta.toFixed(1)}% vs mes anterior`;
    els.monthDelta.className = delta >= 0 ? 'stat-delta positive' : 'stat-delta negative';
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
    const d = new Date(r.date);
    return d.toLocaleDateString('es-ES', { day: '2-digit', month: 'short' });
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
  
  const totalSuccess = Number(summary.totalSuccess || 0);
  const totalErrors = Number(summary.totalErrors || 0);
  
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

// Load quick stats (for header/nav)
async function loadQuickStats() {
  try {
    const now = new Date();
    const from = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString().slice(0, 10);
    const to = now.toISOString().slice(0, 10);
    
    const res = await authFetch(`/dashboard/summary${buildQuery({ from, to })}`);
    if (!res.ok) return;
    
    const summary = await res.json();
    const totalSent = Number(summary.totalSent || 0);
    const totalSuccess = Number(summary.totalSuccess || 0);
    
    // Quick stat elements
    const todayEl = document.getElementById('quickStatToday');
    const rateEl = document.getElementById('quickStatRate');
    
    if (todayEl) todayEl.textContent = totalSent.toLocaleString();
    if (rateEl) {
      rateEl.textContent = totalSent > 0 
        ? `${((totalSuccess / totalSent) * 100).toFixed(1)}%`
        : '--%';
    }
  } catch (e) {
    console.warn('Error loading quick stats:', e);
  }
}

// Initialize Dashboard
function initDashboard() {
  setupDatePresets();
  loadDashboard();
  loadQuickStats();
  
  // Refresh quick stats periodically
  setInterval(loadQuickStats, 60000);
}

// Global exports
window.loadDashboard = loadDashboard;
window.initDashboard = initDashboard;
window.loadQuickStats = loadQuickStats;
