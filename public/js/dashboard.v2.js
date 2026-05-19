(function () {
  const ACTIVE = document.body.classList.contains('shell-v2-active') ||
    localStorage.getItem('shellV2') === '1' ||
    new URLSearchParams(location.search).get('shell') === 'v2';
  if (!ACTIVE) return;

  function quotaWidgetHtml() {
    return `
      <div id="v2-plan-quota-widget" class="v2-plan-quota">
        <div class="v2-plan-quota-header">
          <div>
            <span class="v2-plan-quota-title">Cuota mensual de envíos</span>
            <span class="v2-plan-quota-plan" id="v2-quota-plan">—</span>
          </div>
          <div class="v2-plan-quota-counts">
            <span id="v2-quota-used">0</span>
            <span class="v2-plan-quota-sep">/</span>
            <span id="v2-quota-limit">∞</span>
            <span class="v2-plan-quota-unit">mensajes</span>
          </div>
        </div>
        <div class="v2-plan-quota-bar-bg">
          <div class="v2-plan-quota-bar" id="v2-quota-bar" style="width:0%"></div>
        </div>
        <div class="v2-plan-quota-footer">
          <span><span id="v2-quota-remaining">—</span> restantes este mes</span>
          <span id="v2-quota-pct" class="v2-plan-quota-pct"></span>
        </div>
      </div>`;
  }

  function renderQuota() {
    const pf = window.planFeatures;
    if (!pf) return;

    const plan  = pf.plan  || '—';
    const limit = pf.features?.send ?? -1;
    const used  = pf.usage?.sendThisMonth ?? 0;

    const planEl = document.getElementById('v2-quota-plan');
    if (planEl) planEl.textContent = plan.charAt(0).toUpperCase() + plan.slice(1);

    const usedEl = document.getElementById('v2-quota-used');
    if (usedEl) usedEl.textContent = used.toLocaleString('es-PY');

    const limitEl     = document.getElementById('v2-quota-limit');
    const remainingEl = document.getElementById('v2-quota-remaining');
    const pctEl       = document.getElementById('v2-quota-pct');
    const barEl       = document.getElementById('v2-quota-bar');
    if (!limitEl || !barEl) return;

    if (limit === -1) {
      limitEl.textContent     = '∞';
      remainingEl.textContent = '∞';
      pctEl.textContent       = '';
      barEl.style.width       = '0%';
      barEl.className         = 'v2-plan-quota-bar';
      return;
    }

    const pct       = Math.min((used / limit) * 100, 100);
    const remaining = Math.max(0, limit - used);

    limitEl.textContent     = limit.toLocaleString('es-PY');
    remainingEl.textContent = remaining.toLocaleString('es-PY');
    pctEl.textContent       = `${pct.toFixed(1)}%`;
    barEl.style.width       = `${pct}%`;
    barEl.className = 'v2-plan-quota-bar' + (pct >= 90 ? ' danger' : pct >= 70 ? ' warn' : '');
  }

  function init() {
    const dash = document.getElementById('dashboard');
    if (!dash) return;

    // Inject once before the stats grid
    if (!document.getElementById('v2-plan-quota-widget')) {
      const statsGrid = dash.querySelector('.dash-stats-grid');
      if (statsGrid) statsGrid.insertAdjacentHTML('beforebegin', quotaWidgetHtml());
    }

    renderQuota();

    // planFeatures loads async — poll until available
    if (!window.planFeatures) {
      const poll = setInterval(() => {
        if (window.planFeatures) { renderQuota(); clearInterval(poll); }
      }, 400);
      setTimeout(() => clearInterval(poll), 20000);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
