/**
 * Chatbot - Configuration, Flow Builder & Conversations
 */

// ── State ──
var chatbotConfig = null;
var chatbotNodes = [];
var chatbotConfigId = null;
var chatbotLoaded = false;

// ── Node type metadata ──
var NODE_TYPES = {
  message:  { label: 'Mensaje',    icon: 'bi-chat-dots',      color: '#3b82f6' },
  menu:     { label: 'Menu',       icon: 'bi-list-ul',        color: '#22c55e' },
  media:    { label: 'Media',      icon: 'bi-image',          color: '#a855f7' },
  redirect: { label: 'Redirigir',  icon: 'bi-arrow-right-circle', color: '#f97316' },
  ai:       { label: 'IA',         icon: 'bi-stars',          color: '#ec4899' },
  end:      { label: 'Fin',        icon: 'bi-x-circle',       color: '#ef4444' }
};

var VARIABLE_CHIPS = [
  { label: '{nombre}', value: '{nombre}' },
  { label: '{tratamiento}', value: '{tratamiento}' },
  { label: '{grupo}', value: '{grupo}' },
  { label: '{telefono}', value: '{telefono}' }
];

var DAY_LABELS = [
  { value: 1, short: 'L',  label: 'Lunes' },
  { value: 2, short: 'M',  label: 'Martes' },
  { value: 3, short: 'Mi', label: 'Miercoles' },
  { value: 4, short: 'J',  label: 'Jueves' },
  { value: 5, short: 'V',  label: 'Viernes' },
  { value: 6, short: 'S',  label: 'Sabado' },
  { value: 7, short: 'D',  label: 'Domingo' }
];

// ── Init ──
function initChatbot() {
  // Nothing to do on init — load happens on tab switch
}

// ── Load (called on tab switch) ──
async function loadChatbot() {
  if (chatbotLoaded) {
    loadConversations(); // refresh conversations
    return;
  }

  await loadChatbotConfig();
  await loadChatbotNodes();
  await loadConversations();
  chatbotLoaded = true;
}

// ── Config ──
async function loadChatbotConfig() {
  try {
    var res = await authFetch('/chatbot/config');
    if (!res || !res.ok) {
      if (res && res.status === 404) {
        chatbotConfig = null;
        renderConfigForm(null);
        return;
      }
      throw new Error('Error cargando configuracion');
    }
    var data = await res.json();
    chatbotConfig = data.config;
    renderConfigForm(chatbotConfig);
  } catch (err) {
    console.error('loadChatbotConfig error:', err);
    showAlert('Error cargando configuracion del chatbot', 'danger');
  }
}

function renderConfigForm(config) {
  var c = config || {};

  // Toggle
  var toggle = document.getElementById('cb-enabled-toggle');
  if (toggle) toggle.checked = !!c.enabled;

  // Fields
  setVal('cb-name', c.name || 'Mi Bot');
  setVal('cb-hours-start', c.active_hours_start || '08:00');
  setVal('cb-hours-end', c.active_hours_end || '22:00');
  setVal('cb-cooldown', c.cooldown_minutes != null ? c.cooldown_minutes : 30);
  setVal('cb-max-responses', c.max_responses_per_contact != null ? c.max_responses_per_contact : 5);
  setVal('cb-welcome', c.welcome_message || '');
  setVal('cb-fallback', c.fallback_message || 'No reconozco esa opción. Por favor elige un número del menú:');
  setVal('cb-exit-message', c.exit_message || 'Has salido del menú. Escribe *menu* cuando quieras volver a empezar.');
  setVal('cb-deactivation-message', c.deactivation_message || 'Un agente te atenderá pronto. Gracias por tu paciencia.');

  // Start node selector — populate after nodes are loaded
  chatbotConfig._pendingStartNode = c.start_node_id || '';

  // Keywords
  var defaultActivation = 'hola, hi, hello, hey, buenos dias, buenas tardes, buenas noches, buen dia, buenas, ola, hla, holaa, menu, menú, inicio, info, informacion, información, ayuda, help, start';
  var defaultDeactivation = 'agente, humano, operador, persona real, quiero hablar, no entiendo, basta, stop, parar, chau, adios, bye';
  setVal('cb-activation-keywords', (c.activation_keywords && c.activation_keywords.length > 0) ? c.activation_keywords.join(', ') : defaultActivation);
  setVal('cb-deactivation-keywords', (c.deactivation_keywords && c.deactivation_keywords.length > 0) ? c.deactivation_keywords.join(', ') : defaultDeactivation);

  var onlyKnown = document.getElementById('cb-only-known');
  if (onlyKnown) onlyKnown.checked = c.only_known_contacts !== false;

  // Days
  var activeDays = c.active_days || [1, 2, 3, 4, 5];
  DAY_LABELS.forEach(function(d) {
    var pill = document.getElementById('cb-day-' + d.value);
    if (pill) {
      pill.classList.toggle('active', activeDays.indexOf(d.value) !== -1);
    }
  });

  // AI
  setVal('cb-ai-provider', c.ai_provider || 'openai');
  setVal('cb-ai-key', ''); // never prefill key
  setVal('cb-ai-model', c.ai_model || 'gpt-4o-mini');
  setVal('cb-ai-prompt', c.ai_system_prompt || '');

  var aiToggle = document.getElementById('cb-ai-enabled');
  if (aiToggle) aiToggle.checked = !!c.ai_enabled;

  updateToggleStatus();
}

function setVal(id, val) {
  var el = document.getElementById(id);
  if (el) el.value = val;
}

function getVal(id) {
  var el = document.getElementById(id);
  return el ? el.value : '';
}

function updateToggleStatus() {
  var toggle = document.getElementById('cb-enabled-toggle');
  var label = document.getElementById('cb-enabled-label');
  if (toggle && label) {
    label.textContent = toggle.checked ? 'Habilitado' : 'Deshabilitado';
    label.style.color = toggle.checked ? 'var(--accent)' : 'var(--text-secondary)';
  }
}

async function toggleBot(enabled) {
  updateToggleStatus();
  if (!chatbotConfig) {
    // Create config first
    await saveChatbotConfig();
    return;
  }
  try {
    var res = await authFetch('/chatbot/config', {
      method: 'PUT',
      body: JSON.stringify({ enabled: enabled })
    });
    if (res && res.ok) {
      chatbotConfig.enabled = enabled;
      showAlert(enabled ? 'Bot habilitado' : 'Bot deshabilitado', 'success');
    }
  } catch (err) {
    console.error('toggleBot error:', err);
    showAlert('Error al cambiar estado del bot', 'danger');
  }
}

async function saveChatbotConfig() {
  var activeDays = [];
  DAY_LABELS.forEach(function(d) {
    var pill = document.getElementById('cb-day-' + d.value);
    if (pill && pill.classList.contains('active')) {
      activeDays.push(d.value);
    }
  });

  var payload = {
    name: getVal('cb-name'),
    enabled: document.getElementById('cb-enabled-toggle').checked,
    active_hours_start: getVal('cb-hours-start'),
    active_hours_end: getVal('cb-hours-end'),
    active_days: activeDays,
    cooldown_minutes: parseInt(getVal('cb-cooldown')) || 30,
    only_known_contacts: document.getElementById('cb-only-known').checked,
    max_responses_per_contact: parseInt(getVal('cb-max-responses')) || 5,
    welcome_message: getVal('cb-welcome'),
    fallback_message: getVal('cb-fallback'),
    exit_message: getVal('cb-exit-message'),
    deactivation_message: getVal('cb-deactivation-message'),
    start_node_id: getVal('cb-start-node') || null,
    activation_keywords: getVal('cb-activation-keywords') ? getVal('cb-activation-keywords').split(',').map(function(s) { return s.trim(); }).filter(Boolean) : null,
    deactivation_keywords: getVal('cb-deactivation-keywords') ? getVal('cb-deactivation-keywords').split(',').map(function(s) { return s.trim(); }).filter(Boolean) : null
  };

  try {
    var method = chatbotConfig ? 'PUT' : 'POST';
    var res = await authFetch('/chatbot/config', {
      method: method,
      body: JSON.stringify(payload)
    });
    if (!res || !res.ok) throw new Error('Error guardando');
    var data = await res.json();
    chatbotConfig = data.config;
    showAlert('Configuracion guardada', 'success');
  } catch (err) {
    console.error('saveChatbotConfig error:', err);
    showAlert('Error guardando configuracion', 'danger');
  }
}

async function saveAiConfig() {
  var payload = {
    ai_enabled: document.getElementById('cb-ai-enabled').checked,
    ai_provider: getVal('cb-ai-provider'),
    ai_model: getVal('cb-ai-model'),
    ai_system_prompt: getVal('cb-ai-prompt')
  };
  var key = getVal('cb-ai-key');
  if (key.trim()) {
    payload.ai_api_key = key;
  }

  try {
    var method = chatbotConfig ? 'PUT' : 'POST';
    var res = await authFetch('/chatbot/config', {
      method: method,
      body: JSON.stringify(payload)
    });
    if (!res || !res.ok) throw new Error('Error guardando IA');
    var data = await res.json();
    chatbotConfig = data.config;
    showAlert('Configuracion de IA guardada', 'success');
  } catch (err) {
    console.error('saveAiConfig error:', err);
    showAlert('Error guardando configuracion de IA', 'danger');
  }
}

// ── Nodes / Flow Builder ──
async function loadChatbotNodes() {
  try {
    var res = await authFetch('/chatbot/nodes');
    if (!res || !res.ok) {
      chatbotNodes = [];
      chatbotConfigId = null;
      renderFlowBuilder();
      return;
    }
    var data = await res.json();
    chatbotNodes = (data.nodes || []).map(function(n) {
      return {
        node_id: n.node_id,
        type: n.type,
        content: n.content || {}
      };
    });
    chatbotConfigId = data.config_id;
    renderFlowBuilder();
    renderFlowPreview();
    populateStartNodeSelector();
  } catch (err) {
    console.error('loadChatbotNodes error:', err);
    chatbotNodes = [];
    renderFlowBuilder();
  }
}

function populateStartNodeSelector() {
  var select = document.getElementById('cb-start-node');
  if (!select) return;
  var current = (chatbotConfig && chatbotConfig._pendingStartNode) || '';
  var html = '<option value="">Automático (primer menú encontrado)</option>';
  chatbotNodes.forEach(function(n) {
    var label = n.node_id + ' (' + n.type + ')';
    if (n.content && n.content.text) label += ' — ' + (n.content.text || '').substring(0, 40);
    html += '<option value="' + n.node_id + '"' + (n.node_id === current ? ' selected' : '') + '>' + label + '</option>';
  });
  select.innerHTML = html;
}

function getFlowOrder() {
  // Build adjacency: node_id -> [target_node_ids]
  var adj = {};
  var nodeMap = {};
  chatbotNodes.forEach(function(n, idx) {
    nodeMap[n.node_id] = idx;
    adj[n.node_id] = [];
    var c = n.content || {};
    if (n.type === 'menu' && c.options) {
      c.options.forEach(function(opt) {
        var t = opt.trigger || opt.next;
        if (t) adj[n.node_id].push(t);
      });
    } else if (c.next) {
      adj[n.node_id].push(c.next);
    }
  });

  // Find start node
  var startId = (chatbotConfig && chatbotConfig.start_node_id) || '';
  if (!startId || !nodeMap.hasOwnProperty(startId)) {
    // Default: first menu, or first node
    for (var i = 0; i < chatbotNodes.length; i++) {
      if (chatbotNodes[i].type === 'menu') { startId = chatbotNodes[i].node_id; break; }
    }
    if (!startId && chatbotNodes.length > 0) startId = chatbotNodes[0].node_id;
  }

  // BFS from start
  var visited = {};
  var ordered = [];
  var queue = [startId];
  visited[startId] = true;
  while (queue.length > 0) {
    var current = queue.shift();
    if (nodeMap.hasOwnProperty(current)) {
      ordered.push(nodeMap[current]);
      (adj[current] || []).forEach(function(t) {
        if (!visited[t] && nodeMap.hasOwnProperty(t)) {
          visited[t] = true;
          queue.push(t);
        }
      });
    }
  }

  // Append any unreachable nodes at the end
  chatbotNodes.forEach(function(n, idx) {
    if (!visited[n.node_id]) ordered.push(idx);
  });

  return { order: ordered, startId: startId };
}

function getNodeTargetLabel(node) {
  var c = node.content || {};
  if (node.type === 'menu' && c.options && c.options.length > 0) {
    return c.options.map(function(opt, i) {
      var target = opt.trigger || opt.next || '(sin destino)';
      return (i + 1) + '. ' + (opt.label || '?') + ' \u2192 ' + target;
    }).join('\n');
  }
  if (node.type === 'end') return null;
  if (c.next) return c.next;
  return null;
}

function renderFlowBuilder() {
  var container = document.getElementById('cb-nodes-list');
  if (!container) return;

  if (chatbotNodes.length === 0) {
    container.innerHTML =
      '<div class="cb-empty-flow">' +
        '<i class="bi bi-diagram-3"></i>' +
        '<p>No hay nodos en el flujo</p>' +
        '<p class="text-muted">Agrega nodos para construir el flujo de conversacion</p>' +
      '</div>';
    return;
  }

  var flowInfo = getFlowOrder();
  var orderedIndices = flowInfo.order;
  var startId = flowInfo.startId;

  var html = '';
  orderedIndices.forEach(function(idx, step) {
    var node = chatbotNodes[idx];
    var isStart = node.node_id === startId;
    var isEnd = node.type === 'end';

    // Step indicator + arrow between cards
    if (step > 0) {
      html += '<div class="cb-card-connector"><i class="bi bi-arrow-down"></i></div>';
    }

    // Step badge
    var stepBadge =
      '<div class="cb-step-badge' + (isStart ? ' cb-step-start' : '') + (isEnd ? ' cb-step-end' : '') + '">' +
        (isStart ? '<i class="bi bi-play-circle-fill"></i> ' : '') +
        (isEnd ? '<i class="bi bi-stop-circle-fill"></i> ' : '') +
        'Paso ' + (step + 1) +
      '</div>';

    // Flow target summary
    var targetLabel = getNodeTargetLabel(node);
    var targetHtml = '';
    if (targetLabel && node.type === 'menu') {
      var lines = targetLabel.split('\n');
      targetHtml = '<div class="cb-node-flow-targets">';
      targetHtml += '<span class="cb-flow-targets-title"><i class="bi bi-signpost-split"></i> Destinos:</span>';
      lines.forEach(function(line) {
        targetHtml += '<span class="cb-flow-target-line">' + escHtml(line) + '</span>';
      });
      targetHtml += '</div>';
    } else if (targetLabel) {
      targetHtml =
        '<div class="cb-node-flow-targets">' +
          '<span class="cb-flow-targets-title"><i class="bi bi-arrow-right-circle"></i> Va a:</span>' +
          '<span class="cb-flow-target-line">' + escHtml(targetLabel) + '</span>' +
        '</div>';
    } else if (isEnd) {
      targetHtml =
        '<div class="cb-node-flow-targets cb-flow-end-label">' +
          '<span class="cb-flow-targets-title"><i class="bi bi-stop-circle"></i> Fin del flujo</span>' +
        '</div>';
    }

    html += stepBadge + renderNodeCard(node, idx) + targetHtml;
  });
  container.innerHTML = html;

  // Attach events (use original indices)
  chatbotNodes.forEach(function(node, idx) {
    attachNodeEvents(idx);
  });
}

function renderNodeCard(node, idx) {
  var meta = NODE_TYPES[node.type] || NODE_TYPES.message;
  var content = node.content || {};

  var bodyHtml = '';
  switch (node.type) {
    case 'message':
      bodyHtml = renderMessageEditor(idx, content);
      break;
    case 'menu':
      bodyHtml = renderMenuEditor(idx, content);
      break;
    case 'media':
      bodyHtml = renderMediaEditor(idx, content);
      break;
    case 'redirect':
      bodyHtml = renderRedirectEditor(idx, content);
      break;
    case 'ai':
      bodyHtml = renderAiEditor(idx, content);
      break;
    case 'end':
      bodyHtml = renderEndEditor(idx, content);
      break;
  }

  // Next node selector (not for menu/end types)
  var nextHtml = '';
  if (node.type !== 'menu' && node.type !== 'end') {
    nextHtml =
      '<div class="cb-node-next">' +
        '<label>Siguiente nodo:</label>' +
        '<select class="form-control cb-node-next-select" data-idx="' + idx + '">' +
          '<option value="">-- Ninguno --</option>' +
          getNodeOptions(content.next, idx) +
        '</select>' +
      '</div>';
  }

  return (
    '<div class="cb-node-card" data-idx="' + idx + '" style="--node-color: ' + meta.color + '">' +
      '<div class="cb-node-header">' +
        '<div class="cb-node-header-left">' +
          '<span class="cb-node-type-badge" style="background: ' + meta.color + '">' +
            '<i class="bi ' + meta.icon + '"></i> ' + meta.label +
          '</span>' +
          '<input class="cb-node-id-input" type="text" value="' + escHtml(node.node_id) + '" ' +
            'data-idx="' + idx + '" placeholder="ID del nodo" title="ID unico del nodo">' +
        '</div>' +
        '<div class="cb-node-header-right">' +
          '<select class="cb-node-type-select" data-idx="' + idx + '">' +
            getTypeOptions(node.type) +
          '</select>' +
          '<button class="cb-node-move-btn" data-idx="' + idx + '" data-dir="up" title="Mover arriba"' +
            (idx === 0 ? ' disabled' : '') + '>' +
            '<i class="bi bi-chevron-up"></i>' +
          '</button>' +
          '<button class="cb-node-move-btn" data-idx="' + idx + '" data-dir="down" title="Mover abajo"' +
            (idx === chatbotNodes.length - 1 ? ' disabled' : '') + '>' +
            '<i class="bi bi-chevron-down"></i>' +
          '</button>' +
          '<button class="cb-node-delete-btn" data-idx="' + idx + '" title="Eliminar nodo">' +
            '<i class="bi bi-trash3"></i>' +
          '</button>' +
        '</div>' +
      '</div>' +
      '<div class="cb-node-body">' +
        bodyHtml +
      '</div>' +
      nextHtml +
    '</div>'
  );
}

function renderMessageEditor(idx, content) {
  return (
    '<div class="cb-editor">' +
      renderVariableChips(idx) +
      '<textarea class="form-control cb-content-field" data-idx="' + idx + '" data-field="text" ' +
        'rows="3" placeholder="Escribe el mensaje...">' + escHtml(content.text || '') + '</textarea>' +
    '</div>'
  );
}

function renderMenuEditor(idx, content) {
  var options = content.options || [];
  var optionsHtml = '';
  options.forEach(function(opt, oi) {
    optionsHtml +=
      '<div class="cb-menu-option" data-idx="' + idx + '" data-oi="' + oi + '">' +
        '<span class="cb-menu-option-num">' + (oi + 1) + '.</span>' +
        '<input class="form-control cb-menu-label" type="text" value="' + escHtml(opt.label || '') + '" ' +
          'placeholder="Etiqueta" data-idx="' + idx + '" data-oi="' + oi + '">' +
        '<select class="form-control cb-menu-target" data-idx="' + idx + '" data-oi="' + oi + '">' +
          '<option value="">-- Destino --</option>' +
          getNodeOptions(opt.trigger || opt.next, idx) +
        '</select>' +
        '<button class="cb-menu-remove-btn" data-idx="' + idx + '" data-oi="' + oi + '" title="Quitar opcion">' +
          '<i class="bi bi-x"></i>' +
        '</button>' +
      '</div>';
  });

  return (
    '<div class="cb-editor">' +
      renderVariableChips(idx) +
      '<textarea class="form-control cb-content-field" data-idx="' + idx + '" data-field="text" ' +
        'rows="2" placeholder="Texto del menu...">' + escHtml(content.text || '') + '</textarea>' +
      '<div class="cb-menu-options-list" id="cb-menu-options-' + idx + '">' +
        optionsHtml +
      '</div>' +
      '<button class="cb-add-option-btn" data-idx="' + idx + '">' +
        '<i class="bi bi-plus-circle"></i> Agregar opcion' +
      '</button>' +
    '</div>'
  );
}

function renderMediaEditor(idx, content) {
  return (
    '<div class="cb-editor">' +
      '<div class="cb-editor-row">' +
        '<label>Tipo:</label>' +
        '<select class="form-control cb-content-field" data-idx="' + idx + '" data-field="type">' +
          '<option value="image"' + (content.type === 'image' ? ' selected' : '') + '>Imagen</option>' +
          '<option value="video"' + (content.type === 'video' ? ' selected' : '') + '>Video</option>' +
          '<option value="document"' + (content.type === 'document' ? ' selected' : '') + '>Documento</option>' +
        '</select>' +
      '</div>' +
      '<div class="cb-editor-row">' +
        '<label>URL:</label>' +
        '<input class="form-control cb-content-field" type="url" data-idx="' + idx + '" data-field="url" ' +
          'value="' + escHtml(content.url || '') + '" placeholder="https://...">' +
      '</div>' +
      '<div class="cb-editor-row">' +
        '<label>Leyenda:</label>' +
        '<input class="form-control cb-content-field" type="text" data-idx="' + idx + '" data-field="caption" ' +
          'value="' + escHtml(content.caption || '') + '" placeholder="Leyenda opcional">' +
      '</div>' +
    '</div>'
  );
}

function renderRedirectEditor(idx, content) {
  return (
    '<div class="cb-editor">' +
      '<div class="cb-editor-row">' +
        '<label>Telefono de redireccion:</label>' +
        '<input class="form-control cb-content-field" type="text" data-idx="' + idx + '" data-field="phone" ' +
          'value="' + escHtml(content.phone || '') + '" placeholder="595981123456">' +
      '</div>' +
      renderVariableChips(idx) +
      '<textarea class="form-control cb-content-field" data-idx="' + idx + '" data-field="message" ' +
        'rows="2" placeholder="Mensaje de redireccion...">' + escHtml(content.message || 'Te redirijo con un agente.') + '</textarea>' +
    '</div>'
  );
}

function renderAiEditor(idx, content) {
  return (
    '<div class="cb-editor">' +
      '<textarea class="form-control cb-content-field" data-idx="' + idx + '" data-field="prompt" ' +
        'rows="3" placeholder="Prompt del sistema para este nodo IA...">' + escHtml(content.prompt || '') + '</textarea>' +
      '<div class="cb-editor-row">' +
        '<label>Max tokens:</label>' +
        '<input class="form-control cb-content-field" type="number" data-idx="' + idx + '" data-field="max_tokens" ' +
          'value="' + (content.max_tokens || 500) + '" min="50" max="4000">' +
      '</div>' +
    '</div>'
  );
}

function renderEndEditor(idx, content) {
  return (
    '<div class="cb-editor">' +
      renderVariableChips(idx) +
      '<textarea class="form-control cb-content-field" data-idx="' + idx + '" data-field="text" ' +
        'rows="2" placeholder="Mensaje de cierre...">' + escHtml(content.text || 'Gracias por contactarnos!') + '</textarea>' +
    '</div>'
  );
}

function renderVariableChips(idx) {
  var html = '<div class="cb-variable-chips">';
  VARIABLE_CHIPS.forEach(function(chip) {
    html += '<button class="cb-chip" data-idx="' + idx + '" data-var="' + chip.value + '">' + chip.label + '</button>';
  });
  html += '</div>';
  return html;
}

function getTypeOptions(selected) {
  var html = '';
  Object.keys(NODE_TYPES).forEach(function(key) {
    html += '<option value="' + key + '"' + (key === selected ? ' selected' : '') + '>' + NODE_TYPES[key].label + '</option>';
  });
  return html;
}

function getNodeOptions(selectedId, excludeIdx) {
  var html = '';
  chatbotNodes.forEach(function(n, i) {
    if (i === excludeIdx) return;
    html += '<option value="' + escHtml(n.node_id) + '"' +
      (n.node_id === selectedId ? ' selected' : '') + '>' +
      escHtml(n.node_id) + ' (' + NODE_TYPES[n.type].label + ')' +
      '</option>';
  });
  return html;
}

// ── Node Events ──
function attachNodeEvents(idx) {
  var card = document.querySelector('.cb-node-card[data-idx="' + idx + '"]');
  if (!card) return;

  // Node ID change
  var idInput = card.querySelector('.cb-node-id-input');
  if (idInput) {
    idInput.addEventListener('change', function() {
      chatbotNodes[idx].node_id = this.value.trim().replace(/\s+/g, '_').toLowerCase();
      this.value = chatbotNodes[idx].node_id;
      renderFlowBuilder();
      renderFlowPreview();
    });
  }

  // Type change
  var typeSelect = card.querySelector('.cb-node-type-select');
  if (typeSelect) {
    typeSelect.addEventListener('change', function() {
      chatbotNodes[idx].type = this.value;
      chatbotNodes[idx].content = {};
      renderFlowBuilder();
      renderFlowPreview();
    });
  }

  // Content fields
  card.querySelectorAll('.cb-content-field').forEach(function(field) {
    field.addEventListener('input', function() {
      var fieldName = this.dataset.field;
      var val = this.value;
      if (this.type === 'number') val = parseInt(val) || 0;
      chatbotNodes[idx].content[fieldName] = val;
    });
  });

  // Next node select
  var nextSelect = card.querySelector('.cb-node-next-select');
  if (nextSelect) {
    nextSelect.addEventListener('change', function() {
      chatbotNodes[idx].content.next = this.value || null;
      renderFlowPreview();
    });
  }

  // Variable chips
  card.querySelectorAll('.cb-chip').forEach(function(chip) {
    chip.addEventListener('click', function() {
      var varText = this.dataset.var;
      var textarea = card.querySelector('textarea.cb-content-field');
      if (textarea) {
        var start = textarea.selectionStart;
        var end = textarea.selectionEnd;
        var text = textarea.value;
        textarea.value = text.substring(0, start) + varText + text.substring(end);
        textarea.focus();
        textarea.selectionStart = textarea.selectionEnd = start + varText.length;
        // Trigger input event
        var field = textarea.dataset.field;
        chatbotNodes[idx].content[field] = textarea.value;
      }
    });
  });

  // Delete
  var deleteBtn = card.querySelector('.cb-node-delete-btn');
  if (deleteBtn) {
    deleteBtn.addEventListener('click', function() {
      removeNode(idx);
    });
  }

  // Move buttons
  card.querySelectorAll('.cb-node-move-btn').forEach(function(btn) {
    btn.addEventListener('click', function() {
      var dir = this.dataset.dir;
      moveNode(idx, dir);
    });
  });

  // Menu option events
  card.querySelectorAll('.cb-menu-label').forEach(function(input) {
    input.addEventListener('input', function() {
      var oi = parseInt(this.dataset.oi);
      if (!chatbotNodes[idx].content.options) chatbotNodes[idx].content.options = [];
      if (!chatbotNodes[idx].content.options[oi]) chatbotNodes[idx].content.options[oi] = {};
      chatbotNodes[idx].content.options[oi].label = this.value;
    });
  });

  card.querySelectorAll('.cb-menu-target').forEach(function(select) {
    select.addEventListener('change', function() {
      var oi = parseInt(this.dataset.oi);
      if (!chatbotNodes[idx].content.options) chatbotNodes[idx].content.options = [];
      if (!chatbotNodes[idx].content.options[oi]) chatbotNodes[idx].content.options[oi] = {};
      chatbotNodes[idx].content.options[oi].trigger = this.value || null;
      renderFlowPreview();
    });
  });

  card.querySelectorAll('.cb-menu-remove-btn').forEach(function(btn) {
    btn.addEventListener('click', function() {
      var oi = parseInt(this.dataset.oi);
      chatbotNodes[idx].content.options.splice(oi, 1);
      renderFlowBuilder();
      renderFlowPreview();
    });
  });

  // Add menu option
  var addOptionBtn = card.querySelector('.cb-add-option-btn');
  if (addOptionBtn) {
    addOptionBtn.addEventListener('click', function() {
      if (!chatbotNodes[idx].content.options) chatbotNodes[idx].content.options = [];
      chatbotNodes[idx].content.options.push({ label: '', trigger: null });
      renderFlowBuilder();
    });
  }
}

function addNode() {
  var count = chatbotNodes.length;
  var newId = 'nodo_' + (count + 1);
  chatbotNodes.push({
    node_id: newId,
    type: 'message',
    content: { text: '' }
  });
  renderFlowBuilder();
  renderFlowPreview();

  // Scroll to new node
  setTimeout(function() {
    var cards = document.querySelectorAll('.cb-node-card');
    if (cards.length) {
      cards[cards.length - 1].scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }, 100);
}

function removeNode(idx) {
  var node = chatbotNodes[idx];
  if (!confirm('Eliminar nodo "' + node.node_id + '"?')) return;
  chatbotNodes.splice(idx, 1);
  renderFlowBuilder();
  renderFlowPreview();
}

function moveNode(idx, dir) {
  var targetIdx = dir === 'up' ? idx - 1 : idx + 1;
  if (targetIdx < 0 || targetIdx >= chatbotNodes.length) return;
  var temp = chatbotNodes[idx];
  chatbotNodes[idx] = chatbotNodes[targetIdx];
  chatbotNodes[targetIdx] = temp;
  renderFlowBuilder();
  renderFlowPreview();
}

async function saveAllNodes() {
  // Validate node IDs
  var ids = {};
  for (var i = 0; i < chatbotNodes.length; i++) {
    var nid = chatbotNodes[i].node_id;
    if (!nid) {
      showAlert('El nodo #' + (i + 1) + ' no tiene ID', 'warning');
      return;
    }
    if (ids[nid]) {
      showAlert('ID duplicado: "' + nid + '"', 'warning');
      return;
    }
    ids[nid] = true;
  }

  try {
    var res = await authFetch('/chatbot/nodes', {
      method: 'POST',
      body: JSON.stringify({ nodes: chatbotNodes })
    });
    if (!res || !res.ok) throw new Error('Error guardando flujo');
    var data = await res.json();
    showAlert('Flujo guardado (' + chatbotNodes.length + ' nodos)', 'success');
    renderFlowPreview();
  } catch (err) {
    console.error('saveAllNodes error:', err);
    showAlert('Error guardando el flujo', 'danger');
  }
}

// ── Flow Preview (Vertical Diagram) ──
function renderFlowPreview() {
  var container = document.getElementById('cb-flow-preview');
  if (!container) return;

  if (chatbotNodes.length === 0) {
    container.innerHTML = '<div class="cb-preview-empty">Sin nodos</div>';
    return;
  }

  var nodeMap = {};
  chatbotNodes.forEach(function(n) { nodeMap[n.node_id] = n; });

  var flowInfo = getFlowOrder();
  var startId = flowInfo.startId;

  // Recursive render function that builds a vertical tree
  var rendered = {};

  function renderNodeBox(nodeId, depth) {
    if (!nodeId || !nodeMap[nodeId]) {
      return '<div class="cbfp-node cbfp-missing"><div class="cbfp-node-header cbfp-missing-header">' +
        '<i class="bi bi-exclamation-triangle"></i> ' + escHtml(nodeId || '?') + ' (no existe)</div></div>';
    }
    if (rendered[nodeId]) {
      // Already rendered — show reference
      var refMeta = NODE_TYPES[nodeMap[nodeId].type] || NODE_TYPES.message;
      return '<div class="cbfp-node cbfp-ref" style="--node-color: ' + refMeta.color + '">' +
        '<div class="cbfp-node-header" style="background: ' + refMeta.color + '">' +
        '<i class="bi bi-arrow-return-right"></i> ' + escHtml(nodeId) +
        '</div><div class="cbfp-ref-label">ver arriba</div></div>';
    }
    if (depth > 15) return ''; // safety
    rendered[nodeId] = true;

    var node = nodeMap[nodeId];
    var meta = NODE_TYPES[node.type] || NODE_TYPES.message;
    var content = node.content || {};
    var isStart = nodeId === startId;
    var isEnd = node.type === 'end';

    // Text preview
    var textPreview = content.text || content.message || content.prompt || '';
    if (textPreview.length > 60) textPreview = textPreview.substring(0, 57) + '...';

    var html = '<div class="cbfp-node' + (isStart ? ' cbfp-start' : '') + (isEnd ? ' cbfp-end' : '') + '" style="--node-color: ' + meta.color + '">';

    // Header
    html += '<div class="cbfp-node-header" style="background: ' + meta.color + '">';
    if (isStart) html += '<i class="bi bi-play-circle-fill"></i> ';
    else if (isEnd) html += '<i class="bi bi-stop-circle-fill"></i> ';
    else html += '<i class="bi ' + meta.icon + '"></i> ';
    html += escHtml(nodeId);
    html += '<span class="cbfp-type-label">' + meta.label + '</span>';
    html += '</div>';

    // Body with text preview
    if (textPreview) {
      html += '<div class="cbfp-node-body">"' + escHtml(textPreview) + '"</div>';
    }

    // Menu options inline
    if (node.type === 'menu' && content.options && content.options.length > 0) {
      html += '<div class="cbfp-menu-list">';
      content.options.forEach(function(opt, i) {
        var target = opt.trigger || opt.next || '';
        html += '<div class="cbfp-menu-item">' +
          '<span class="cbfp-menu-num">' + (i + 1) + '.</span> ' +
          escHtml(opt.label || '?') +
          (target ? ' <i class="bi bi-arrow-right"></i> <strong>' + escHtml(target) + '</strong>' : '') +
          '</div>';
      });
      html += '</div>';
    }

    html += '</div>'; // close cbfp-node

    // Render children
    var children = getNodeConnections(node);
    if (children.length === 1) {
      // Single child — vertical line down
      html += '<div class="cbfp-connector-down"><div class="cbfp-line"></div><i class="bi bi-arrow-down-short"></i></div>';
      html += renderNodeBox(children[0].target, depth + 1);
    } else if (children.length > 1) {
      // Multiple children — branch
      html += '<div class="cbfp-connector-down"><div class="cbfp-line"></div><i class="bi bi-arrow-down-short"></i></div>';
      html += '<div class="cbfp-branch">';
      children.forEach(function(child) {
        html += '<div class="cbfp-branch-col">';
        html += '<div class="cbfp-branch-label">' + escHtml(child.label) + '</div>';
        html += renderNodeBox(child.target, depth + 1);
        html += '</div>';
      });
      html += '</div>';
    }

    return html;
  }

  var html = '<div class="cbfp-diagram">';
  html += renderNodeBox(startId, 0);

  // Render any unreachable nodes
  var unreachable = [];
  chatbotNodes.forEach(function(n) {
    if (!rendered[n.node_id]) unreachable.push(n.node_id);
  });
  if (unreachable.length > 0) {
    html += '<div class="cbfp-unreachable-section">';
    html += '<div class="cbfp-unreachable-title"><i class="bi bi-exclamation-triangle"></i> Nodos no conectados al flujo</div>';
    unreachable.forEach(function(nid) {
      html += renderNodeBox(nid, 0);
    });
    html += '</div>';
  }

  html += '</div>';
  container.innerHTML = html;
}

function getNodeConnections(node) {
  var connections = [];
  var content = node.content || {};

  if (node.type === 'menu' && content.options) {
    content.options.forEach(function(opt) {
      if (opt.trigger || opt.next) {
        connections.push({
          label: opt.label || '?',
          target: opt.trigger || opt.next
        });
      }
    });
  } else if (content.next) {
    connections.push({ label: 'siguiente', target: content.next });
  }

  return connections;
}

// ── Conversations ──
async function loadConversations() {
  var container = document.getElementById('cb-conversations-list');
  if (!container) return;

  try {
    var res = await authFetch('/chatbot/conversations');
    if (!res || !res.ok) {
      container.innerHTML = '<div class="text-muted" style="padding: var(--space-md);">Sin conversaciones activas</div>';
      return;
    }
    var data = await res.json();
    var convs = data.conversations || [];

    if (convs.length === 0) {
      container.innerHTML = '<div class="text-muted" style="padding: var(--space-md);">Sin conversaciones activas</div>';
      return;
    }

    var html = '';
    convs.forEach(function(conv) {
      var statusClass = conv.is_active ? 'cb-conv-active' : 'cb-conv-inactive';
      var statusText = conv.is_active ? 'Activa' : 'Inactiva';
      var maxResp = chatbotConfig ? chatbotConfig.max_responses_per_contact : '?';

      html +=
        '<div class="cb-conv-item ' + statusClass + '">' +
          '<div class="cb-conv-info">' +
            '<span class="cb-conv-phone"><i class="bi bi-phone"></i> ' + escHtml(conv.contact_phone) + '</span>' +
            '<span class="cb-conv-node">Nodo: <strong>' + escHtml(conv.current_node_id || 'inicio') + '</strong></span>' +
            '<span class="cb-conv-responses">Resp: ' + (conv.responses_today || 0) + '/' + maxResp + '</span>' +
            '<span class="cb-conv-status ' + statusClass + '">' + statusText + '</span>' +
          '</div>' +
          '<div class="cb-conv-actions">' +
            '<button class="cb-conv-btn cb-conv-deactivate" data-phone="' + escHtml(conv.contact_phone) + '" title="Desactivar">' +
              '<i class="bi bi-pause-circle"></i>' +
            '</button>' +
            '<button class="cb-conv-btn cb-conv-reset" data-phone="' + escHtml(conv.contact_phone) + '" title="Resetear">' +
              '<i class="bi bi-arrow-counterclockwise"></i>' +
            '</button>' +
          '</div>' +
        '</div>';
    });
    container.innerHTML = html;

    // Attach events
    container.querySelectorAll('.cb-conv-deactivate').forEach(function(btn) {
      btn.addEventListener('click', function() {
        deactivateConversation(this.dataset.phone);
      });
    });
    container.querySelectorAll('.cb-conv-reset').forEach(function(btn) {
      btn.addEventListener('click', function() {
        resetConversationUI(this.dataset.phone);
      });
    });
  } catch (err) {
    console.error('loadConversations error:', err);
    container.innerHTML = '<div class="text-muted" style="padding: var(--space-md);">Error cargando conversaciones</div>';
  }
}

async function deactivateConversation(phone) {
  try {
    var res = await authFetch('/chatbot/conversations/' + encodeURIComponent(phone) + '/deactivate', { method: 'PUT' });
    if (res && res.ok) {
      showAlert('Conversacion desactivada', 'success');
      loadConversations();
    }
  } catch (err) {
    showAlert('Error desactivando conversacion', 'danger');
  }
}

async function resetConversationUI(phone) {
  if (!confirm('Resetear la conversacion con ' + phone + '?')) return;
  try {
    var res = await authFetch('/chatbot/conversations/' + encodeURIComponent(phone), { method: 'DELETE' });
    if (res && res.ok) {
      showAlert('Conversacion reseteada', 'success');
      loadConversations();
    }
  } catch (err) {
    showAlert('Error reseteando conversacion', 'danger');
  }
}

// ── Utility ──
function escHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── Day pill toggle ──
function toggleDay(dayValue) {
  var pill = document.getElementById('cb-day-' + dayValue);
  if (pill) pill.classList.toggle('active');
}

// ── Exports ──
window.initChatbot = initChatbot;
window.loadChatbot = loadChatbot;
window.toggleBot = toggleBot;
window.saveChatbotConfig = saveChatbotConfig;
window.saveAiConfig = saveAiConfig;
window.saveAllNodes = saveAllNodes;
window.addNode = addNode;
window.toggleDay = toggleDay;
