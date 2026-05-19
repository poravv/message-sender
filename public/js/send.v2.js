(function () {
  // Steps 3 (Multimedia) y 4 (Velocidad) se colapsan por defecto
  // Step 1 (Destinatarios) y Step 2 (Mensaje) quedan siempre abiertos

  const COLLAPSIBLE_TITLES = ['Multimedia', 'Velocidad de envio'];

  function initCollapsibleSteps() {
    const steps = document.querySelectorAll('#send .send-step');

    steps.forEach(step => {
      const header = step.querySelector('.send-step-header');
      const title  = header?.querySelector('.send-step-title')?.textContent.trim();
      if (!title || !COLLAPSIBLE_TITLES.includes(title)) return;

      // Mark as collapsible
      step.classList.add('v2-collapsible');

      // Add chevron to header
      const chevron = document.createElement('i');
      chevron.className = 'bi bi-chevron-down v2-step-chevron';
      header.appendChild(chevron);

      // Collapse by default
      step.classList.add('v2-collapsed');

      // Toggle on click
      header.addEventListener('click', () => {
        const isCollapsed = step.classList.contains('v2-collapsed');
        step.classList.toggle('v2-collapsed');
        if (isCollapsed) {
          // Expanding — animate body
          const body = step.querySelector('.send-step-body');
          if (body) {
            body.classList.add('v2-expanding');
            body.addEventListener('animationend', () => body.classList.remove('v2-expanding'), { once: true });
          }
        }
      });
    });
  }

  // Wrap steps 1+2 in a grid container on desktop
  function wrapStepsGrid() {
    const form = document.getElementById('messageForm');
    if (!form) return;
    const steps = form.querySelectorAll('.send-step');
    if (steps.length < 2) return;

    const wrapper = document.createElement('div');
    wrapper.className = 'send-steps-grid';

    // Move step 1 and step 2 into the grid
    const step1 = steps[0];
    const step2 = steps[1];
    step1.parentNode.insertBefore(wrapper, step1);
    wrapper.appendChild(step1);
    wrapper.appendChild(step2);
  }

  function init() {
    wrapStepsGrid();
    initCollapsibleSteps();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
