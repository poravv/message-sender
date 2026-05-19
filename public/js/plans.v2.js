(function () {
  // Map plan name → pricing card selector (by plan name text)
  function highlightActivePlan() {
    const pf = window.planFeatures || window.userProfile;
    const plan = (pf?.plan || '').toLowerCase().trim();
    if (!plan || plan === 'trial' || plan === 'expired') return;

    // Find pricing card whose .pricing-plan-name matches
    const cards = document.querySelectorAll('#plans .pricing-card');
    cards.forEach(card => {
      const nameEl = card.querySelector('.pricing-plan-name');
      if (!nameEl) return;
      const cardPlan = nameEl.textContent.trim().toLowerCase();
      if (cardPlan === plan) {
        card.classList.add('v2-plan-active');
        if (!card.querySelector('.v2-current-plan-badge')) {
          card.insertAdjacentHTML('afterbegin', '<span class="v2-current-plan-badge">Tu plan</span>');
        }
      }
    });
  }

  function init() {
    highlightActivePlan();
    if (!window.planFeatures) {
      const poll = setInterval(() => {
        if (window.planFeatures || window.userProfile) { highlightActivePlan(); clearInterval(poll); }
      }, 500);
      setTimeout(() => clearInterval(poll), 15000);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
