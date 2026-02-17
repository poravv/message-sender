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
    
    for (let i = 1; i <= count; i++) {
      const template = document.createElement('div');
      template.className = 'template-item';
      template.innerHTML = `
        <div class="template-header">
          <span class="template-number">Template ${i}</span>
          <div class="template-tools">
            <button type="button" class="btn-emoji" data-template="${i}" title="Emojis">
              <i class="bi bi-emoji-smile"></i>
            </button>
            <button type="button" class="btn-variables" data-template="${i}" title="Variables">
              <i class="bi bi-braces"></i>
            </button>
          </div>
        </div>
        <textarea 
          class="form-control message-textarea" 
          id="message${i}" 
          name="message${i}" 
          rows="4" 
          placeholder="Escribe tu mensaje aquí..."
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
    
    // Show variables helper
    const helper = document.getElementById('variablesHelper');
    if (helper) helper.classList.remove('d-none');
  }
  
  renderTemplates(1);
  countSelect.addEventListener('change', () => renderTemplates(parseInt(countSelect.value)));
}

// Setup emoji picker
function setupEmojiPicker() {
  const picker = document.getElementById('emojiPicker');
  const grid = document.getElementById('emojiGrid');
  if (!picker || !grid) return;
  
  let currentTextarea = null;
  
  // Track last focused textarea
  document.addEventListener('focusin', (e) => {
    if (e.target.classList.contains('message-textarea')) {
      currentTextarea = e.target;
    }
  });
  
  function renderEmojis(category) {
    grid.innerHTML = '';
    const emojis = emojiCategories[category] || emojiCategories.smileys;
    emojis.forEach(emoji => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'emoji-btn';
      btn.textContent = emoji;
      btn.addEventListener('click', () => {
        if (currentTextarea) {
          const pos = currentTextarea.selectionStart;
          const text = currentTextarea.value;
          currentTextarea.value = text.slice(0, pos) + emoji + text.slice(pos);
          currentTextarea.focus();
          currentTextarea.selectionStart = currentTextarea.selectionEnd = pos + emoji.length;
          currentTextarea.dispatchEvent(new Event('input'));
        }
      });
      grid.appendChild(btn);
    });
  }
  
  // Category buttons
  picker.querySelectorAll('.emoji-category').forEach(btn => {
    btn.addEventListener('click', () => {
      picker.querySelectorAll('.emoji-category').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      renderEmojis(btn.dataset.category);
    });
  });
  
  // Open picker
  document.addEventListener('click', (e) => {
    const emojiBtn = e.target.closest('.btn-emoji');
    if (emojiBtn) {
      const templateNum = emojiBtn.dataset.template;
      const textarea = document.getElementById(`message${templateNum}`);
      if (textarea) currentTextarea = textarea;
      picker.classList.toggle('d-none');
      if (!picker.classList.contains('d-none')) {
        renderEmojis('smileys');
        picker.querySelector('.emoji-category').classList.add('active');
      }
      e.stopPropagation();
    }
  });
  
  // Close picker on outside click
  document.addEventListener('click', (e) => {
    if (!picker.contains(e.target) && !e.target.closest('.btn-emoji')) {
      picker.classList.add('d-none');
    }
  });
}

// Track last active textarea for variables
let lastActiveTextarea = null;

// Setup variables helper
function setupVariables() {
  const helper = document.getElementById('variablesHelper');
  if (!helper) return;
  
  // Track focus on message textareas
  document.addEventListener('focusin', (e) => {
    if (e.target.classList.contains('message-textarea')) {
      lastActiveTextarea = e.target;
    }
  });
  
  helper.querySelectorAll('.variable-btn').forEach(btn => {
    btn.addEventListener('mousedown', (e) => {
      // Prevent losing focus from textarea
      e.preventDefault();
    });
    
    btn.addEventListener('click', () => {
      const variable = btn.dataset.variable;
      if (lastActiveTextarea) {
        const pos = lastActiveTextarea.selectionStart;
        const text = lastActiveTextarea.value;
        lastActiveTextarea.value = text.slice(0, pos) + variable + text.slice(pos);
        lastActiveTextarea.focus();
        lastActiveTextarea.selectionStart = lastActiveTextarea.selectionEnd = pos + variable.length;
        lastActiveTextarea.dispatchEvent(new Event('input'));
      } else {
        // If no textarea was focused, use the first one
        const firstTextarea = document.querySelector('.message-textarea');
        if (firstTextarea) {
          firstTextarea.value += variable;
          firstTextarea.focus();
          firstTextarea.dispatchEvent(new Event('input'));
        }
      }
    });
  });
}

// Send messages
async function sendMessages() {
  const form = document.getElementById('messageForm');
  const submitBtn = document.getElementById('sendMessageBtn');
  const progressSection = document.getElementById('messageStatus');
  
  if (!form || !submitBtn) return;
  
  // Collect form data
  const formData = new FormData(form);
  
  // Add all message templates
  const templateCount = parseInt(document.getElementById('templateCount')?.value || 1);
  for (let i = 1; i <= templateCount; i++) {
    const msg = document.getElementById(`message${i}`)?.value || '';
    formData.set(`message${i}`, msg);
  }
  
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

// Initialize Messages module
function initMessages() {
  setupMessageForm();
  setupMessageTypeHandlers();
  setupFileInputs();
  setupTemplates();
  setupEmojiPicker();
  setupVariables();
  
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
