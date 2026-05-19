(function () {
  const PARAM = new URLSearchParams(location.search).get('shell') === 'v2';
  const FLAG  = localStorage.getItem('shellV2') === '1';
  if (!PARAM && !FLAG) return;

  if (PARAM) localStorage.setItem('shellV2', '1');

  const NAV_ITEMS = [
    { tab: 'dashboard', icon: 'bi-speedometer2',      label: 'Dashboard'  },
    { tab: 'whatsapp',  icon: 'bi-whatsapp',           label: 'WhatsApp'   },
    { tab: 'send',      icon: 'bi-send',               label: 'Enviar'     },
    { tab: 'contacts',  icon: 'bi-people',             label: 'Contactos'  },
    { tab: 'inbox',     icon: 'bi-chat-dots',          label: 'Bandeja',     inboxBadge: true },
    { tab: 'chatbot',   icon: 'bi-robot',              label: 'Chatbot'    },
    { label: null }, // group divider
    { tab: 'templates', icon: 'bi-chat-square-text',   label: 'Plantillas' },
    { tab: 'campaigns', icon: 'bi-megaphone',          label: 'Campañas'   },
    { tab: 'plans',     icon: 'bi-credit-card',        label: 'Planes'     },
    { tab: 'api',       icon: 'bi-code-slash',         label: 'API'        },
    { tab: 'admin',     icon: 'bi-shield-lock',        label: 'Admin',     adminOnly: true },
  ];

  function buildNavHtml() {
    let html = '';
    let groupStarted = false;
    NAV_ITEMS.forEach(item => {
      if (!item.tab) {
        html += '<div class="v2-nav-group-label">Más</div>';
        groupStarted = true;
        return;
      }
      const badge = item.inboxBadge ? '<span id="v2-inbox-badge" class="v2-nav-badge d-none">0</span>' : '';
      const adminAttr = item.adminOnly ? ' data-admin-only="true" style="display:none"' : '';
      html += `<button class="v2-nav-item" data-tab="${item.tab}"${adminAttr}>
        <i class="bi ${item.icon}"></i>
        <span>${item.label}</span>
        ${badge}
      </button>`;
    });
    return html;
  }

  const shellHtml = `
    <aside id="v2-sidebar">
      <div class="v2-sidebar-header">
        <i class="bi bi-whatsapp"></i>
        <span>WA Sender Pro</span>
      </div>
      <nav class="v2-sidebar-nav">${buildNavHtml()}</nav>
      <div class="v2-sidebar-footer">
        <i class="bi bi-person-circle" style="font-size:1.5rem;color:var(--text-muted);flex-shrink:0"></i>
        <div class="v2-sidebar-footer-info">
          <div class="v2-sidebar-footer-name" id="v2-footer-name">Usuario</div>
          <div class="v2-sidebar-footer-plan" id="v2-footer-plan">—</div>
        </div>
      </div>
    </aside>
    <header id="v2-topbar">
      <button id="v2-hamburger" title="Menú"><i class="bi bi-list"></i></button>
      <div class="v2-topbar-spacer"></div>
      <div class="v2-conn-badge disconnected" id="v2-conn-badge">
        <span class="v2-conn-dot"></span>
        <span id="v2-conn-text">Desconectado</span>
      </div>
      <button class="v2-theme-btn" id="v2-theme-btn" title="Cambiar tema">
        <i class="bi bi-moon-fill" id="v2-theme-icon"></i>
      </button>
      <button class="v2-user-chip" id="v2-user-chip" title="Perfil">
        <i class="bi bi-person-circle"></i>
        <span id="v2-chip-name">Usuario</span>
      </button>
    </header>
    <div id="v2-sidebar-overlay"></div>`;

  function init() {
    document.body.classList.add('shell-v2-active');
    document.body.insertAdjacentHTML('afterbegin', shellHtml);

    // Nav item clicks → delegate to existing hidden tab buttons
    document.querySelectorAll('#v2-sidebar .v2-nav-item').forEach(btn => {
      btn.addEventListener('click', () => {
        const tab = btn.dataset.tab;
        const target = document.querySelector(`.tab-btn[data-tab="${tab}"]`) ||
                       document.querySelector(`.tab-more-item[data-tab="${tab}"]`);
        if (target) target.click();
        document.body.classList.remove('shell-v2-mobile-open');
      });
    });

    // Hamburger toggle
    document.getElementById('v2-hamburger').addEventListener('click', () => {
      document.body.classList.toggle('shell-v2-mobile-open');
    });
    document.getElementById('v2-sidebar-overlay').addEventListener('click', () => {
      document.body.classList.remove('shell-v2-mobile-open');
    });

    // Theme toggle
    function syncThemeIcon() {
      const isDark = document.documentElement.getAttribute('data-theme') !== 'light';
      document.getElementById('v2-theme-icon').className = isDark ? 'bi bi-moon-fill' : 'bi bi-sun-fill';
    }
    document.getElementById('v2-theme-btn').addEventListener('click', () => {
      const sw = document.getElementById('themeSwitch');
      if (sw) sw.click(); else {
        const html = document.documentElement;
        html.setAttribute('data-theme', html.getAttribute('data-theme') === 'light' ? 'dark' : 'light');
      }
    });
    syncThemeIcon();
    new MutationObserver(syncThemeIcon).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

    // User chip → open existing profile dropdown
    document.getElementById('v2-user-chip').addEventListener('click', () => {
      const trigger = document.getElementById('profile-menu-trigger');
      if (trigger) trigger.click();
    });

    // Sync active tab in sidebar
    function syncActiveTab() {
      const activePane = document.querySelector('.tab-pane.active');
      const activeTab  = activePane?.id || document.querySelector('.tab-btn.active')?.dataset.tab;
      document.querySelectorAll('#v2-sidebar .v2-nav-item').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.tab === activeTab);
      });
    }
    const mainEl = document.querySelector('.main') || document.body;
    new MutationObserver(syncActiveTab).observe(mainEl, { subtree: true, attributes: true, attributeFilter: ['class'] });
    syncActiveTab();

    // Sync user info (name populated async by main.js)
    function syncUserInfo() {
      const name = document.getElementById('user-name')?.textContent.trim();
      const plan = document.getElementById('profile-plan-badge')?.textContent.trim();
      if (name) {
        document.getElementById('v2-footer-name').textContent = name;
        document.getElementById('v2-chip-name').textContent = name;
      }
      if (plan) document.getElementById('v2-footer-plan').textContent = plan;
    }
    const userInfoEl = document.getElementById('user-info');
    if (userInfoEl) new MutationObserver(syncUserInfo).observe(userInfoEl, { subtree: true, childList: true, characterData: true });
    syncUserInfo();
    // Retry after auth settles
    setTimeout(syncUserInfo, 2000);

    // Sync connection status badge
    function syncConn() {
      const src = document.getElementById('connection-status');
      if (!src) return;
      const v2  = document.getElementById('v2-conn-badge');
      const txt = document.getElementById('v2-conn-text');
      txt.textContent = src.querySelector('.status-text')?.textContent || '';
      v2.className = 'v2-conn-badge';
      if (src.classList.contains('connected'))    v2.classList.add('connected');
      else if (src.classList.contains('qr'))      v2.classList.add('qr');
      else                                         v2.classList.add('disconnected');
    }
    const connEl = document.getElementById('connection-status');
    if (connEl) new MutationObserver(syncConn).observe(connEl, { subtree: true, attributes: true, childList: true, characterData: true });
    syncConn();

    // Sync inbox unread badge
    function syncInbox() {
      const src = document.getElementById('inbox-unread-badge');
      const dst = document.getElementById('v2-inbox-badge');
      if (!src || !dst) return;
      dst.textContent = src.textContent.trim();
      dst.classList.toggle('d-none', src.classList.contains('d-none'));
    }
    const inboxBadge = document.getElementById('inbox-unread-badge');
    if (inboxBadge) new MutationObserver(syncInbox).observe(inboxBadge, { subtree: true, attributes: true, childList: true, characterData: true });
    syncInbox();

    // Sync admin tab visibility
    function syncAdmin() {
      const src = document.getElementById('admin-tab-btn');
      const dst = document.querySelector('#v2-sidebar .v2-nav-item[data-tab="admin"]');
      if (src && dst) dst.style.display = src.classList.contains('d-none') ? 'none' : '';
    }
    const adminBtn = document.getElementById('admin-tab-btn');
    if (adminBtn) new MutationObserver(syncAdmin).observe(adminBtn, { attributes: true, attributeFilter: ['class'] });
    syncAdmin();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
