/**
 * Messages - Send Messages Functionality
 */

let currentJobId = null;
let progressPollingInterval = null;

// Emoji data
const emojiCategories = {
  smileys: ['😀', '😃', '😄', '😁', '😆', '😅', '🤣', '😂', '🙂', '😉', '😊', '😇', '🥰', '😍', '🤩', '😘', '😗', '😚', '😋', '😛', '😜', '🤪', '😝', '🤑', '🤗', '🤭', '🤫', '🤔', '🤐', '🤨', '😐', '😑', '😶', '😏', '😒', '🙄', '😬', '🤥', '😌', '😔', '😪', '🤤', '😴', '😷', '🤒', '🤕', '🤢', '🤮', '🤧', '🥵', '🥶', '🥴', '😵', '🤯', '🤠', '🥳', '😎', '🤓', '🧐'],
  people: ['👋', '🤚', '🖐️', '✋', '🖖', '👌', '🤌', '🤏', '✌️', '🤞', '🤟', '🤘', '🤙', '👈', '👉', '👆', '🖕', '👇', '☝️', '👍', '👎', '✊', '👊', '🤛', '🤜', '👏', '🙌', '👐', '🤲', '🤝', '🙏', '✍️', '💪', '🦾', '🦵', '🦶', '👂', '🦻', '👃', '🧠', '🦷', '🦴', '👀', '👁️', '👅', '👄'],
  nature: ['🌱', '🌲', '🌳', '🌴', '🌵', '🌾', '🌿', '☘️', '🍀', '🍁', '🍂', '🍃', '🍄', '🌺', '🌻', '🌼', '🌷', '🌹', '🥀', '💐', '🐶', '🐱', '🐭', '🐹', '🐰', '🦊', '🐻', '🐼', '🐨', '🐯', '🦁', '🐮', '🐷', '🐸', '🐵', '🐔', '🐧', '🐦', '🐤', '🦆', '🦅', '🦉', '🦇', '🐺', '🐗', '🐴'],
  food: ['🍎', '🍐', '🍊', '🍋', '🍌', '🍉', '🍇', '🍓', '🫐', '🍈', '🍒', '🍑', '🥭', '🍍', '🥥', '🥝', '🍅', '🍆', '🥑', '🥦', '🥬', '🥒', '🌶️', '🫑', '🌽', '🥕', '🧄', '🧅', '🥔', '🍠', '🥐', '🥯', '🍞', '🥖', '🥨', '🧀', '🥚', '🍳', '🧈', '🥞', '🧇', '🥓', '🥩', '🍗', '🍖', '🦴', '🌭', '🍔', '🍟', '🍕'],
  activities: ['⚽', '🏀', '🏈', '⚾', '🥎', '🎾', '🏐', '🏉', '🥏', '🎱', '🪀', '🏓', '🏸', '🏒', '🏑', '🥍', '🏏', '🪃', '🥅', '⛳', '🪁', '🏹', '🎣', '🤿', '🥊', '🥋', '🎽', '🛹', '🛼', '🛷', '⛸️', '🥌', '🎿', '⛷️', '🏂', '🪂', '🏋️', '🤼', '🤸', '⛹️', '🤺', '🤾', '🏌️', '🏇', '⛳', '🧘'],
  travel: ['🚗', '🚕', '🚙', '🚌', '🚎', '🏎️', '🚓', '🚑', '🚒', '🚐', '🛻', '🚚', '🚛', '🚜', '🏍️', '🛵', '🚲', '🛴', '🚨', '🚔', '🚍', '🚘', '🚖', '🚡', '🚠', '🚟', '🚃', '🚋', '🚞', '🚝', '🚄', '🚅', '🚈', '🚂', '🚆', '🚇', '🚊', '🚉', '✈️', '🛫', '🛬', '💺', '🚀', '🛸', '🚁', '🛶', '⛵', '🚤', '🛥️', '🛳️', '⛴️', '🚢'],
  objects: ['💡', '🔦', '🏮', '🪔', '📱', '📲', '💻', '🖥️', '🖨️', '⌨️', '🖱️', '🖲️', '💽', '💾', '💿', '📀', '📼', '📷', '📸', '📹', '🎥', '📽️', '🎞️', '📞', '☎️', '📟', '📠', '📺', '📻', '🎙️', '🎚️', '🎛️', '🧭', '⏱️', '⏲️', '⏰', '🕰️', '⌛', '⏳', '📡', '🔋', '🔌', '💰', '🪙', '💵', '💴', '💶', '💷', '💸', '💳'],
  symbols: ['❤️', '🧡', '💛', '💚', '💙', '💜', '🖤', '🤍', '🤎', '💔', '❣️', '💕', '💞', '💓', '💗', '💖', '💘', '💝', '💟', '☮️', '✝️', '☪️', '🕉️', '☸️', '✡️', '🔯', '🕎', '☯️', '☦️', '🛐', '⛎', '♈', '♉', '♊', '♋', '♌', '♍', '♎', '♏', '♐', '♑', '♒', '♓', '🆔', '⚛️', '🉑', '☢️', '☣️', '📴', '📳'],
  flags: ['🏁', '🚩', '🎌', '🏴', '🏳️', '🏳️‍🌈', '🏳️‍⚧️', '🏴‍☠️', '🇦🇷', '🇧🇷', '🇨🇱', '🇨🇴', '🇪🇨', '🇪🇸', '🇲🇽', '🇵🇪', '🇵🇾', '🇺🇾', '🇻🇪', '🇺🇸', '🇬🇧', '🇫🇷', '🇩🇪', '🇮🇹', '🇯🇵', '🇰🇷', '🇨🇳']
};

// Setup message form
function setupMessageForm() {
  const form = document.getElementById('messageForm');
  if (!form) return;
  
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    
    if (!window.isWhatsAppConnected || !window.isWhatsAppConnected()) {
      showAlert('Primero debes conectar WhatsApp', 'warning');
      return;
    }
    
    await sendMessages();
  });
}

// Setup message type handlers
function setupMessageTypeHandlers() {
  const typeInputs = document.querySelectorAll('input[name="messageType"]');
  const sections = {
    single: document.getElementById('singleImageSection'),
    multiple: document.getElementById('multipleImagesSection'),
    audio: document.getElementById('audioSection')
  };
  
  typeInputs.forEach(input => {
    input.addEventListener('change', () => {
      Object.values(sections).forEach(s => s?.classList.add('d-none'));
      
      const type = input.value;
      if (sections[type]) {
        sections[type].classList.remove('d-none');
      }
    });
  });
}

// Setup file inputs
function setupFileInputs() {
  const inputs = [
    { id: 'csvFile', infoId: 'csvFileInfo' },
    { id: 'singleImage', infoId: 'singleImageInfo' },
    { id: 'images', infoId: 'multipleImagesInfo' },
    { id: 'audioFile', infoId: 'audioFileInfo' }
  ];
  
  inputs.forEach(({ id, infoId }) => {
    const input = document.getElementById(id);
    const info = document.getElementById(infoId);
    if (!input || !info) return;
    
    input.addEventListener('change', () => {
      if (input.files.length > 0) {
        const files = Array.from(input.files);
        const names = files.map(f => f.name).join(', ');
        const totalSize = files.reduce((sum, f) => sum + f.size, 0);
        info.innerHTML = `<i class="bi bi-file-earmark-check"></i> ${names} (${formatFileSize(totalSize)})`;
        info.classList.add('has-file');
      } else {
        info.innerHTML = '';
        info.classList.remove('has-file');
      }
    });
  });
}

// Format file size
function formatFileSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / 1048576).toFixed(1) + ' MB';
}

// Setup templates
function setupTemplates() {
  const countSelect = document.getElementById('templateCount');
  const container = document.getElementById('templatesContainer');
  if (!countSelect || !container) return;

  function renderTemplates(count) {
    container.innerHTML = '';
    // Close any open emoji pickers
    document.querySelectorAll('.emoji-picker-float').forEach(el => el.remove());

    for (let i = 1; i <= count; i++) {
      const badgeClass = `template-badge-${i}`;
      const template = document.createElement('div');
      template.className = 'template-item';
      template.innerHTML = `
        <div class="template-header">
          <span class="template-badge ${badgeClass}">Parte ${i}</span>
          <div class="template-toolbar">
            <button type="button" class="variable-chip" data-template="${i}" data-variable="{nombre}" title="Insertar nombre">
              {nombre}
            </button>
            <button type="button" class="variable-chip" data-template="${i}" data-variable="{sustantivo}" title="Insertar tratamiento">
              {sustantivo}
            </button>
            <button type="button" class="variable-chip" data-template="${i}" data-variable="{grupo}" title="Insertar grupo">
              {grupo}
            </button>
            <button type="button" class="btn-emoji" data-template="${i}" title="Emojis">
              <i class="bi bi-emoji-smile"></i>
            </button>
          </div>
        </div>
        <textarea
          class="form-control message-textarea"
          id="message${i}"
          name="message${i}"
          rows="4"
          placeholder="Escribe tu mensaje aqui... Usa {nombre} para personalizar"
          ${i === 1 ? 'required' : ''}
        ></textarea>
        <div class="char-count"><span id="charCount${i}">0</span> caracteres</div>
      `;
      container.appendChild(template);

      // Char counter
      const textarea = template.querySelector(`#message${i}`);
      const counter = template.querySelector(`#charCount${i}`);
      textarea.addEventListener('input', () => {
        counter.textContent = textarea.value.length;
      });
    }
  }

  renderTemplates(1);
  countSelect.addEventListener('change', () => renderTemplates(parseInt(countSelect.value)));
}

// Setup emoji picker (floating per-template)
function setupEmojiPicker() {
  let activePickerTemplate = null;

  function createFloatingPicker(templateNum) {
    // Remove any existing floating picker
    document.querySelectorAll('.emoji-picker-float').forEach(el => el.remove());

    const header = document.querySelector(`.btn-emoji[data-template="${templateNum}"]`)?.closest('.template-header');
    if (!header) return;

    const picker = document.createElement('div');
    picker.className = 'emoji-picker-float';
    picker.innerHTML = `
      <div class="emoji-categories">
        ${Object.keys(emojiCategories).map((cat, idx) => {
          const icons = { smileys: '😀', people: '👤', nature: '🌱', food: '🍎', activities: '⚽', travel: '🚗', objects: '💡', symbols: '❤️', flags: '🏁' };
          return `<button type="button" class="emoji-category${idx === 0 ? ' active' : ''}" data-category="${cat}">${icons[cat] || '😀'}</button>`;
        }).join('')}
      </div>
      <div class="emoji-grid"></div>
    `;
    header.appendChild(picker);
    activePickerTemplate = templateNum;

    const grid = picker.querySelector('.emoji-grid');

    function renderEmojis(category) {
      grid.innerHTML = '';
      const emojis = emojiCategories[category] || emojiCategories.smileys;
      emojis.forEach(emoji => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'emoji-btn';
        btn.textContent = emoji;
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const textarea = document.getElementById(`message${templateNum}`);
          if (textarea) {
            const pos = textarea.selectionStart;
            const text = textarea.value;
            textarea.value = text.slice(0, pos) + emoji + text.slice(pos);
            textarea.focus();
            textarea.selectionStart = textarea.selectionEnd = pos + emoji.length;
            textarea.dispatchEvent(new Event('input'));
          }
        });
        grid.appendChild(btn);
      });
    }

    renderEmojis('smileys');

    picker.querySelectorAll('.emoji-category').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        picker.querySelectorAll('.emoji-category').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        renderEmojis(btn.dataset.category);
      });
    });

    // Prevent picker clicks from bubbling
    picker.addEventListener('click', (e) => e.stopPropagation());
  }

  // Toggle emoji picker on emoji button click
  document.addEventListener('click', (e) => {
    const emojiBtn = e.target.closest('.btn-emoji');
    if (emojiBtn) {
      e.stopPropagation();
      const templateNum = emojiBtn.dataset.template;
      if (activePickerTemplate === templateNum) {
        // Close if clicking same button
        document.querySelectorAll('.emoji-picker-float').forEach(el => el.remove());
        activePickerTemplate = null;
      } else {
        createFloatingPicker(templateNum);
      }
      return;
    }

    // Close picker on outside click
    if (!e.target.closest('.emoji-picker-float')) {
      document.querySelectorAll('.emoji-picker-float').forEach(el => el.remove());
      activePickerTemplate = null;
    }
  });
}

// Setup inline variable chips (per-template)
function setupVariables() {
  document.addEventListener('click', (e) => {
    const chip = e.target.closest('.variable-chip');
    if (!chip) return;

    const templateNum = chip.dataset.template;
    const variable = chip.dataset.variable;
    const textarea = document.getElementById(`message${templateNum}`);
    if (!textarea) return;

    const pos = textarea.selectionStart;
    const text = textarea.value;
    textarea.value = text.slice(0, pos) + variable + text.slice(pos);
    textarea.focus();
    textarea.selectionStart = textarea.selectionEnd = pos + variable.length;
    textarea.dispatchEvent(new Event('input'));
  });
}

// Send messages
async function sendMessages() {
  const form = document.getElementById('messageForm');
  const submitBtn = document.getElementById('sendMessageBtn');
  const progressSection = document.getElementById('messageStatus');
  
  if (!form || !submitBtn) return;
  
  // Get recipient source
  const recipientSource = document.getElementById('recipientSource')?.value || 'csv';
  
  // Validate based on source
  if (recipientSource === 'csv') {
    const csvFile = document.getElementById('csvFile');
    if (!csvFile?.files?.length) {
      showAlert('Debes seleccionar un archivo CSV', 'warning');
      return;
    }
  } else if (recipientSource === 'contacts') {
    if (selectedContactIds.size === 0) {
      showAlert('Debes seleccionar al menos un contacto', 'warning');
      return;
    }
  } else if (recipientSource === 'group') {
    const groupSelect = document.getElementById('groupSelect');
    if (!groupSelect?.value) {
      showAlert('Debes seleccionar un grupo', 'warning');
      return;
    }
  }
  
  // Collect form data
  const formData = new FormData(form);
  
  // Set recipient source
  formData.set('recipientSource', recipientSource);
  
  // Add source-specific data
  if (recipientSource === 'contacts') {
    formData.set('contactIds', JSON.stringify(Array.from(selectedContactIds)));
    // Remove CSV file if present
    formData.delete('csvFile');
  } else if (recipientSource === 'group') {
    formData.set('groupName', document.getElementById('groupSelect')?.value || '');
    // Remove CSV file if present
    formData.delete('csvFile');
  }
  
  // Add all message templates
  const templateCount = parseInt(document.getElementById('templateCount')?.value || 1);
  const templates = [];
  for (let i = 1; i <= templateCount; i++) {
    const msg = document.getElementById(`message${i}`)?.value || '';
    formData.set(`message${i}`, msg);
    if (msg.trim()) templates.push(msg.trim());
  }

  if (templates.length === 0) {
    showAlert('Debes escribir al menos un template de mensaje', 'warning');
    return;
  }

  // Keep compatibility with current and older backend variants
  formData.set('templates', JSON.stringify(templates));
  formData.set('message', templates[0]);
  
  submitBtn.classList.add('loading');
  submitBtn.disabled = true;
  
  try {
    const res = await authFetch('/send-messages', {
      method: 'POST',
      body: formData
    });
    
    const data = await res.json();
    
    if (!res.ok) {
      throw new Error(data.error || 'Error al enviar');
    }
    
    currentJobId = data.jobId;
    
    if (progressSection) {
      progressSection.classList.remove('d-none');
    }
    
    startProgressPolling();
    showAlert('Envío iniciado correctamente', 'success');
    
  } catch (error) {
    showAlert(error.message, 'danger', 'Error');
  } finally {
    submitBtn.classList.remove('loading');
    submitBtn.disabled = false;
  }
}

// Poll progress
function startProgressPolling() {
  if (progressPollingInterval) {
    clearInterval(progressPollingInterval);
  }
  
  progressPollingInterval = setInterval(async () => {
    try {
      const res = await authFetch('/message-status');
      if (!res.ok) return;
      
      const data = await res.json();
      updateProgress(data);
      
      if (data.state === 'completed' || data.state === 'failed' || data.completed) {
        clearInterval(progressPollingInterval);
        progressPollingInterval = null;
        
        if (data.state === 'completed' || data.completed) {
          showAlert('Envío completado', 'success');
        }
      }
    } catch (e) {
      console.error('Error polling progress:', e);
    }
  }, 1000);
}

// Update progress UI
function updateProgress(data) {
  const total = data.total || 0;
  const sent = data.sent || 0;
  const errors = data.errors || 0;
  const percentage = total > 0 ? Math.round((sent / total) * 100) : 0;
  
  const els = {
    total: document.getElementById('totalCount'),
    sent: document.getElementById('sentCount'),
    errors: document.getElementById('errorCount'),
    progress: document.querySelector('.progress-fill'),
    percentage: document.querySelector('.progress-percentage')
  };
  
  if (els.total) els.total.textContent = total;
  if (els.sent) els.sent.textContent = sent;
  if (els.errors) els.errors.textContent = errors;
  if (els.progress) els.progress.style.width = `${percentage}%`;
  if (els.percentage) els.percentage.textContent = `${percentage}%`;
  
  // Update table
  if (data.results && Array.isArray(data.results)) {
    updateResultsTable(data.results);
  }
}

// Update results table
function updateResultsTable(results) {
  const tbody = document.getElementById('statusTableBody');
  if (!tbody) return;
  
  tbody.innerHTML = '';
  results.slice(-50).reverse().forEach(r => {
    const tr = document.createElement('tr');
    const statusClass = r.success ? 'success' : 'danger';
    const statusIcon = r.success ? 'check-circle' : 'x-circle';
    tr.innerHTML = `
      <td><code>${r.phone || ''}</code></td>
      <td><span class="badge bg-${statusClass}"><i class="bi bi-${statusIcon}"></i> ${r.success ? 'Enviado' : 'Error'}</span></td>
      <td>${r.time || ''}</td>
      <td class="small">${r.message || ''}</td>
    `;
    tbody.appendChild(tr);
  });
}

// Cancel sending
async function cancelSending() {
  try {
    await authFetch('/cancel-campaign', { method: 'POST' });
    showAlert('Envío cancelado', 'warning');
    
    if (progressPollingInterval) {
      clearInterval(progressPollingInterval);
    }
  } catch (e) {
    showAlert('Error al cancelar', 'danger');
  }
}

// Export results
function exportResults() {
  const tbody = document.getElementById('statusTableBody');
  if (!tbody || tbody.children.length === 0) {
    showAlert('No hay datos para exportar', 'warning');
    return;
  }
  
  const rows = Array.from(tbody.children);
  const csv = [
    'Número,Estado,Hora,Respuesta',
    ...rows.map(row => {
      const cells = Array.from(row.children);
      return cells.map(c => `"${c.textContent.trim()}"`).join(',');
    })
  ].join('\n');
  
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = `resultados-${new Date().toISOString().slice(0, 10)}.csv`;
  link.click();
  
  showAlert('Resultados exportados', 'success');
}

// ========== Recipient Source Selection ==========
let allContactsForSend = [];
let selectedContactIds = new Set();
const contactSelectorState = {
  page: 1,
  pageSize: 50,
  total: 0,
  totalPages: 1,
  search: ''
};
let contactSelectorSearchTimer = null;

// Setup recipient source tabs
function setupRecipientSourceTabs() {
  const tabs = document.querySelectorAll('.source-tab');
  const sourceInput = document.getElementById('recipientSource');
  const sections = {
    csv: document.getElementById('csvSourceSection'),
    contacts: document.getElementById('contactsSourceSection'),
    group: document.getElementById('groupSourceSection')
  };
  
  if (!tabs.length || !sourceInput) return;
  
  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      const source = tab.dataset.source;
      
      // Update active tab
      tabs.forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      
      // Update hidden input
      sourceInput.value = source;
      
      // Show/hide sections
      Object.entries(sections).forEach(([key, section]) => {
        if (section) {
          section.classList.toggle('d-none', key !== source);
        }
      });
      
      // Load data if needed
      if (source === 'contacts') {
        loadContactsForSelector(1);
      } else if (source === 'group') {
        loadGroupsForSelector();
      }
    });
  });

  setupContactsSearch();
  setupContactsSelectAll();
  setupContactSelectorPagination();
}

// Load contacts for multi-select
async function loadContactsForSelector(page = 1) {
  const container = document.getElementById('contactsList');
  if (!container) return;

  container.innerHTML = `
    <div class="loading-contacts">
      <div class="spinner-small"></div>
      <span>Cargando contactos...</span>
    </div>
  `;

  try {
    const searchInput = document.getElementById('contactSelectorSearch');
    const search = searchInput?.value?.trim() || '';
    const targetPage = Math.max(1, Number(page) || 1);

    const res = await authFetch(`/contacts${buildQuery({
      search,
      page: targetPage,
      pageSize: contactSelectorState.pageSize
    })}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Error al cargar contactos');

    contactSelectorState.search = search;
    contactSelectorState.total = Number(data.total || 0);
    contactSelectorState.pageSize = Number(data.pageSize || contactSelectorState.pageSize);
    contactSelectorState.totalPages = Math.max(1, Math.ceil(contactSelectorState.total / contactSelectorState.pageSize));
    contactSelectorState.page = Math.min(Math.max(1, Number(data.page || targetPage)), contactSelectorState.totalPages);

    allContactsForSend = data.items || [];

    // If contact list changed after deletes/filters and page is now empty, move one page back
    if (allContactsForSend.length === 0 && contactSelectorState.total > 0 && contactSelectorState.page > 1) {
      return loadContactsForSelector(contactSelectorState.page - 1);
    }

    // Update totals and paging
    const totalEl = document.getElementById('totalContactsCount');
    if (totalEl) totalEl.textContent = contactSelectorState.total;
    updateContactSelectorPagination();
    updateSelectedCount();

    if (contactSelectorState.total === 0) {
      container.innerHTML = `
        <div class="no-contacts-message">
          <i class="bi bi-person-x"></i>
          <p>No tienes contactos guardados</p>
          <small>Ve a la sección Contactos para agregar o importar</small>
        </div>
      `;
      return;
    }

    renderContactsCheckList(allContactsForSend);
  } catch (error) {
    container.innerHTML = `<div class="no-contacts-message"><i class="bi bi-exclamation-triangle"></i><p>Error al cargar contactos</p></div>`;
    console.error('Error loading contacts:', error);
  }
}

// Render contacts checklist
function renderContactsCheckList(contacts) {
  const container = document.getElementById('contactsList');
  if (!container) return;
  
  container.innerHTML = '';
  
  contacts.forEach(contact => {
    const item = document.createElement('label');
    item.className = 'contact-checkbox-item';
    item.innerHTML = `
      <input type="checkbox" value="${contact.id}" ${selectedContactIds.has(contact.id) ? 'checked' : ''}>
      <div class="contact-info">
        <span class="contact-name">${contact.nombre || contact.phone}</span>
        <span class="contact-number">${contact.phone}</span>
      </div>
      ${contact.grupo ? `<span class="contact-group-badge">${contact.grupo}</span>` : ''}
    `;
    
    const checkbox = item.querySelector('input');
    checkbox.addEventListener('change', () => {
      if (checkbox.checked) {
        selectedContactIds.add(contact.id);
      } else {
        selectedContactIds.delete(contact.id);
      }
      updateSelectedCount();
    });
    
    container.appendChild(item);
  });
}

// Update selected count
function updateSelectedCount() {
  const countEl = document.getElementById('selectedContactsCount');
  if (countEl) {
    countEl.textContent = selectedContactIds.size;
  }
}

// Setup contacts search
function setupContactsSearch() {
  const searchInput = document.getElementById('contactSelectorSearch');
  if (!searchInput) return;

  if (searchInput.dataset.bound === '1') return;
  searchInput.dataset.bound = '1';

  searchInput.addEventListener('input', () => {
    if (contactSelectorSearchTimer) clearTimeout(contactSelectorSearchTimer);
    contactSelectorSearchTimer = setTimeout(() => {
      loadContactsForSelector(1);
    }, 250);
  });
}

// Setup select all/clear buttons
function setupContactsSelectAll() {
  const selectAllBtn = document.getElementById('selectAllContactsBtn');
  const clearBtn = document.getElementById('clearSelectedContactsBtn');

  if (selectAllBtn && selectAllBtn.dataset.bound !== '1') {
    selectAllBtn.dataset.bound = '1';
    selectAllBtn.addEventListener('click', () => {
      allContactsForSend.forEach(c => selectedContactIds.add(c.id));
      renderContactsCheckList(allContactsForSend);
      updateSelectedCount();
    });
  }

  if (clearBtn && clearBtn.dataset.bound !== '1') {
    clearBtn.dataset.bound = '1';
    clearBtn.addEventListener('click', () => {
      selectedContactIds.clear();
      renderContactsCheckList(allContactsForSend);
      updateSelectedCount();
    });
  }
}

function setupContactSelectorPagination() {
  const prevBtn = document.getElementById('contactSelectorPrevBtn');
  const nextBtn = document.getElementById('contactSelectorNextBtn');

  if (prevBtn && prevBtn.dataset.bound !== '1') {
    prevBtn.dataset.bound = '1';
    prevBtn.addEventListener('click', () => {
      if (contactSelectorState.page > 1) {
        loadContactsForSelector(contactSelectorState.page - 1);
      }
    });
  }

  if (nextBtn && nextBtn.dataset.bound !== '1') {
    nextBtn.dataset.bound = '1';
    nextBtn.addEventListener('click', () => {
      if (contactSelectorState.page < contactSelectorState.totalPages) {
        loadContactsForSelector(contactSelectorState.page + 1);
      }
    });
  }
}

function updateContactSelectorPagination() {
  const pageInfo = document.getElementById('contactSelectorPageInfo');
  const prevBtn = document.getElementById('contactSelectorPrevBtn');
  const nextBtn = document.getElementById('contactSelectorNextBtn');

  if (pageInfo) {
    pageInfo.textContent = `Página ${contactSelectorState.page} de ${contactSelectorState.totalPages}`;
  }
  if (prevBtn) prevBtn.disabled = contactSelectorState.page <= 1;
  if (nextBtn) nextBtn.disabled = contactSelectorState.page >= contactSelectorState.totalPages;
}

// Load groups for dropdown
async function loadGroupsForSelector() {
  const select = document.getElementById('groupSelect');
  if (!select) return;
  
  select.innerHTML = '<option value="">-- Cargando grupos --</option>';
  
  try {
    const res = await authFetch('/contacts/groups');
    if (!res.ok) throw new Error('Error al cargar grupos');
    
    const data = await res.json();
    const groups = data.groups || [];
    
    if (groups.length === 0) {
      select.innerHTML = '<option value="">-- No hay grupos --</option>';
      return;
    }
    
    select.innerHTML = '<option value="">-- Selecciona un grupo --</option>';
    groups.forEach(g => {
      const option = document.createElement('option');
      option.value = g;
      option.textContent = g;
      select.appendChild(option);
    });
    
    // Setup change handler to show count
    select.addEventListener('change', loadGroupContactsCount);
    
  } catch (error) {
    select.innerHTML = '<option value="">-- Error al cargar --</option>';
    console.error('Error loading groups:', error);
  }
}

// Load group contacts count
async function loadGroupContactsCount() {
  const select = document.getElementById('groupSelect');
  const countEl = document.getElementById('groupContactsCount');
  const countText = document.getElementById('groupContactsCountText');
  
  if (!select || !countEl || !countText) return;
  
  const groupName = select.value;
  
  if (!groupName) {
    countEl.classList.add('d-none');
    return;
  }
  
  try {
    const res = await authFetch(`/contacts${buildQuery({ group: groupName, page: 1, pageSize: 1 })}`);
    if (!res.ok) throw new Error('Error');
    
    const data = await res.json();
    const total = Number(data.total || 0);
    
    countText.textContent = `${total} contactos`;
    countEl.classList.remove('d-none');
    
  } catch (error) {
    countEl.classList.add('d-none');
  }
}

// Initialize Messages module
function initMessages() {
  setupMessageForm();
  setupMessageTypeHandlers();
  setupFileInputs();
  setupTemplates();
  setupEmojiPicker();
  setupVariables();
  setupRecipientSourceTabs();
  
  // Cancel button
  const cancelBtn = document.getElementById('cancelBtn');
  if (cancelBtn) {
    cancelBtn.addEventListener('click', cancelSending);
  }
  
  // Export button
  const exportBtn = document.getElementById('exportBtn');
  if (exportBtn) {
    exportBtn.addEventListener('click', exportResults);
  }
}

// Global exports
window.initMessages = initMessages;
window.cancelSending = cancelSending;
window.exportResults = exportResults;
