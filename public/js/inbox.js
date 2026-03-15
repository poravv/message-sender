/**
 * Inbox - WhatsApp-style message inbox
 */

var inboxState = {
  conversations: [],
  activePhone: null,
  messages: [],
  pollTimer: null,
  unreadCount: 0,
  searchTerm: '',
  isMobileView: false,
  showingChat: false,
  botPaused: false,
  _lastConvJson: '',
  _lastMsgJson: ''
};

function initInbox() {
  // Check for mobile on resize
  window.addEventListener('resize', function() {
    var wasMobile = inboxState.isMobileView;
    inboxState.isMobileView = window.innerWidth < 768;
    if (wasMobile !== inboxState.isMobileView && inboxState.activePhone) {
      renderInboxLayout();
    }
  });
  inboxState.isMobileView = window.innerWidth < 768;

  // Start polling for unread count (always, for badge)
  pollUnreadCount();
  setInterval(pollUnreadCount, 15000);
}

function loadInbox() {
  fetchConversations();
  startInboxPolling();
}

function stopInboxPolling() {
  if (inboxState.pollTimer) {
    clearInterval(inboxState.pollTimer);
    inboxState.pollTimer = null;
  }
}

function startInboxPolling() {
  stopInboxPolling();
  inboxState.pollTimer = setInterval(function() {
    fetchConversations(true);
    if (inboxState.activePhone) {
      fetchMessages(inboxState.activePhone, true);
    }
  }, 10000);
}

async function pollUnreadCount() {
  try {
    var res = await authFetch('/messages/inbox/unread');
    if (!res || !res.ok) return;
    var data = await res.json();
    inboxState.unreadCount = data.unread_conversations || 0;
    updateInboxBadge();
  } catch (e) {
    // silent
  }
}

function updateInboxBadge() {
  var badge = document.getElementById('inbox-unread-badge');
  if (!badge) return;
  if (inboxState.unreadCount > 0) {
    badge.textContent = inboxState.unreadCount > 99 ? '99+' : inboxState.unreadCount;
    badge.classList.remove('d-none');
  } else {
    badge.classList.add('d-none');
  }
}

async function fetchConversations(silent) {
  try {
    var res = await authFetch('/messages/inbox?limit=50');
    if (!res || !res.ok) {
      if (!silent) showAlert('Error al cargar bandeja', 'danger');
      return;
    }
    var data = await res.json();
    var newConversations = data.conversations || [];
    var newJson = JSON.stringify(newConversations);
    if (silent && newJson === inboxState._lastConvJson) return; // no changes, skip re-render
    inboxState._lastConvJson = newJson;
    inboxState.conversations = newConversations;
    renderConversationList();
  } catch (e) {
    if (!silent) showAlert('Error al cargar bandeja', 'danger');
  }
}

async function fetchMessages(phone, silent) {
  try {
    var res = await authFetch('/messages/inbox/' + encodeURIComponent(phone) + '?limit=100');
    if (!res || !res.ok) {
      if (!silent) showAlert('Error al cargar mensajes', 'danger');
      return;
    }
    var data = await res.json();
    // Messages come DESC, reverse for chronological
    var newMessages = (data.messages || []).reverse();
    var newMsgJson = JSON.stringify(newMessages);
    if (silent && newMsgJson === inboxState._lastMsgJson) return; // no changes, skip re-render
    inboxState._lastMsgJson = newMsgJson;
    inboxState.messages = newMessages;
    renderChatMessages();
    // Update unread count after reading
    pollUnreadCount();
    // Also update conversation list unread
    var conv = inboxState.conversations.find(function(c) { return c.contact_phone === phone; });
    if (conv) {
      conv.unread_count = 0;
      renderConversationList();
    }
  } catch (e) {
    if (!silent) showAlert('Error al cargar mensajes', 'danger');
  }
}

async function sendReply(phone, message) {
  if (!message || !message.trim()) return;

  var sendBtn = document.getElementById('inbox-send-btn');
  var input = document.getElementById('inbox-reply-input');
  if (sendBtn) sendBtn.disabled = true;

  try {
    var res = await authFetch('/messages/inbox/' + encodeURIComponent(phone) + '/reply', {
      method: 'POST',
      body: JSON.stringify({ message: message.trim() })
    });

    if (!res || !res.ok) {
      var errData = await res.json().catch(function() { return {}; });
      showAlert(errData.error || 'Error al enviar respuesta', 'danger');
      return;
    }

    // Clear input
    if (input) input.value = '';

    // Auto-pause bot (backend already does this, update UI)
    inboxState.botPaused = true;
    updateBotPausedUI(true);

    // Refresh messages
    await fetchMessages(phone, true);
  } catch (e) {
    showAlert('Error al enviar respuesta', 'danger');
  } finally {
    if (sendBtn) sendBtn.disabled = false;
    if (input) input.focus();
  }
}

function openChat(phone) {
  inboxState.activePhone = phone;
  inboxState.showingChat = true;
  fetchMessages(phone);
  fetchBotStatus(phone);
  renderInboxLayout();

  // Highlight active conversation
  document.querySelectorAll('.inbox-conv-item').forEach(function(el) {
    el.classList.toggle('active', el.dataset.phone === phone);
  });
}

function closeChat() {
  inboxState.showingChat = false;
  inboxState.activePhone = null;
  inboxState.messages = [];
  inboxState.botPaused = false;
  updateBotPausedUI(false);
  renderInboxLayout();
}

async function deleteInboxChat() {
  if (!inboxState.activePhone) return;
  if (!confirm('¿Borrar esta conversación de la bandeja? Los mensajes se eliminan solo de la base de datos, no de WhatsApp.')) return;
  try {
    var res = await authFetch('/messages/inbox/' + encodeURIComponent(inboxState.activePhone), { method: 'DELETE' });
    if (res && res.ok) {
      showAlert('Conversación eliminada', 'success');
      closeChat();
      fetchConversations();
    } else {
      showAlert('Error al borrar', 'danger');
    }
  } catch (e) {
    showAlert('Error al borrar', 'danger');
  }
}
window.deleteInboxChat = deleteInboxChat;

function renderInboxLayout() {
  var listPanel = document.getElementById('inbox-list-panel');
  var chatPanel = document.getElementById('inbox-chat-panel');
  if (!listPanel || !chatPanel) return;

  if (inboxState.isMobileView) {
    if (inboxState.showingChat) {
      listPanel.classList.add('inbox-panel-hidden');
      chatPanel.classList.remove('inbox-panel-hidden');
    } else {
      listPanel.classList.remove('inbox-panel-hidden');
      chatPanel.classList.add('inbox-panel-hidden');
    }
  } else {
    listPanel.classList.remove('inbox-panel-hidden');
    chatPanel.classList.remove('inbox-panel-hidden');
  }
}

function renderConversationList() {
  var container = document.getElementById('inbox-conv-list');
  if (!container) return;

  var filtered = inboxState.conversations;
  if (inboxState.searchTerm) {
    var term = inboxState.searchTerm.toLowerCase();
    filtered = filtered.filter(function(c) {
      return (c.contact_phone || '').toLowerCase().includes(term) ||
             (c.contact_name || '').toLowerCase().includes(term) ||
             (c.grupo || '').toLowerCase().includes(term);
    });
  }

  if (filtered.length === 0) {
    container.innerHTML =
      '<div class="inbox-empty">' +
        '<i class="bi bi-chat-dots"></i>' +
        '<p>No hay conversaciones</p>' +
      '</div>';
    return;
  }

  var html = '';
  filtered.forEach(function(conv) {
    var isActive = conv.contact_phone === inboxState.activePhone;
    var name = conv.contact_name || conv.contact_phone;
    var subtitle = conv.contact_name ? formatPhoneDisplay(conv.contact_phone) : '';
    var grupoBadge = conv.grupo ? '<span class="badge bg-info bg-opacity-25 text-info ms-1" style="font-size:0.65em;vertical-align:middle;">' + escapeHtml(conv.grupo) + '</span>' : '';
    var preview = conv.last_message || '';
    if (preview.length > 50) preview = preview.substring(0, 50) + '...';
    var timeStr = timeAgo(conv.last_message_at);
    var unread = parseInt(conv.unread_count) || 0;

    html +=
      '<div class="inbox-conv-item' + (isActive ? ' active' : '') + '" data-phone="' + escapeHtml(conv.contact_phone) + '" onclick="openChat(\'' + escapeHtml(conv.contact_phone) + '\')">' +
        '<div class="inbox-conv-avatar">' +
          '<i class="bi bi-person-circle"></i>' +
        '</div>' +
        '<div class="inbox-conv-info">' +
          '<div class="inbox-conv-header">' +
            '<span class="inbox-conv-name">' + escapeHtml(name) + grupoBadge + '</span>' +
            '<span class="inbox-conv-time">' + timeStr + '</span>' +
          '</div>' +
          (subtitle ? '<div class="inbox-conv-phone" style="font-size:0.75em;color:var(--text-muted,#888);">' + escapeHtml(subtitle) + '</div>' : '') +
          '<div class="inbox-conv-preview">' +
            '<span class="inbox-conv-text">' + escapeHtml(preview) + '</span>' +
            (unread > 0 ? '<span class="inbox-unread-dot">' + unread + '</span>' : '') +
          '</div>' +
        '</div>' +
      '</div>';
  });

  container.innerHTML = html;
}

function renderChatMessages() {
  var container = document.getElementById('inbox-messages');
  var headerName = document.getElementById('inbox-chat-name');
  if (!container) return;

  // Update header
  if (headerName && inboxState.activePhone) {
    var conv = inboxState.conversations.find(function(c) { return c.contact_phone === inboxState.activePhone; });
    var displayName = (conv && conv.contact_name) ? conv.contact_name : formatPhoneDisplay(inboxState.activePhone);
    headerName.textContent = displayName;
  }

  if (inboxState.messages.length === 0) {
    container.innerHTML =
      '<div class="inbox-empty">' +
        '<i class="bi bi-chat-dots"></i>' +
        '<p>No hay mensajes</p>' +
      '</div>';
    return;
  }

  var html = '';
  var lastDate = '';

  inboxState.messages.forEach(function(msg) {
    var msgDate = new Date(msg.created_at).toLocaleDateString('es');
    if (msgDate !== lastDate) {
      html += '<div class="inbox-date-divider"><span>' + msgDate + '</span></div>';
      lastDate = msgDate;
    }

    var isIncoming = msg.is_from_contact;
    var bubbleClass = isIncoming ? 'inbox-bubble-in' : 'inbox-bubble-out';
    var time = new Date(msg.created_at).toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' });
    var botIcon = msg.is_bot_reply ? ' <i class="bi bi-robot inbox-bot-icon" title="Respuesta del bot"></i>' : '';

    html +=
      '<div class="inbox-msg-row ' + (isIncoming ? 'inbox-msg-in' : 'inbox-msg-out') + '">' +
        '<div class="inbox-bubble ' + bubbleClass + '">' +
          '<div class="inbox-bubble-text">' + escapeHtml(msg.message_text || '') + '</div>' +
          '<div class="inbox-bubble-meta">' +
            botIcon +
            '<span class="inbox-bubble-time">' + time + '</span>' +
            (!isIncoming ? ' <i class="bi bi-check2-all inbox-read-icon"></i>' : '') +
          '</div>' +
        '</div>' +
      '</div>';
  });

  container.innerHTML = html;

  // Auto-scroll to bottom
  container.scrollTop = container.scrollHeight;
}

function timeAgo(dateStr) {
  if (!dateStr) return '';
  var now = Date.now();
  var then = new Date(dateStr).getTime();
  var diff = now - then;
  var seconds = Math.floor(diff / 1000);
  var minutes = Math.floor(seconds / 60);
  var hours = Math.floor(minutes / 60);
  var days = Math.floor(hours / 24);

  if (seconds < 60) return 'ahora';
  if (minutes < 60) return minutes + ' min';
  if (hours < 24) return hours + 'h';
  if (days < 7) return days + 'd';
  return new Date(dateStr).toLocaleDateString('es', { day: 'numeric', month: 'short' });
}

function escapeHtml(str) {
  if (!str) return '';
  var div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function formatPhoneDisplay(phone) {
  if (typeof formatPhoneForDisplay === 'function') {
    return formatPhoneForDisplay(phone);
  }
  if (!phone) return '';
  return '+' + String(phone).replace(/\D/g, '');
}

function handleInboxSearch(value) {
  inboxState.searchTerm = value || '';
  renderConversationList();
}

function handleReplyKeypress(e) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    var input = document.getElementById('inbox-reply-input');
    if (input && input.value.trim() && inboxState.activePhone) {
      sendReply(inboxState.activePhone, input.value);
    }
  }
}

function handleSendClick() {
  var input = document.getElementById('inbox-reply-input');
  if (input && input.value.trim() && inboxState.activePhone) {
    sendReply(inboxState.activePhone, input.value);
  }
}

// ─── Bot pause/resume ──────────────────────────────────────────────────────

async function fetchBotStatus(phone) {
  try {
    var res = await authFetch('/messages/inbox/' + encodeURIComponent(phone) + '/bot-status');
    if (!res || !res.ok) return;
    var data = await res.json();
    inboxState.botPaused = data.bot_paused || data.human_intervention;
    updateBotPausedUI(inboxState.botPaused);
  } catch (e) {
    // silent
  }
}

function updateBotPausedUI(paused) {
  var toggleBtn = document.getElementById('inbox-bot-toggle-btn');
  var toggleLabel = document.getElementById('inbox-bot-toggle-label');
  var banner = document.getElementById('inbox-bot-paused-banner');

  if (toggleBtn) {
    toggleBtn.style.display = inboxState.activePhone ? '' : 'none';
    if (paused) {
      toggleBtn.classList.add('bot-paused');
      toggleBtn.classList.remove('bot-active');
      toggleBtn.title = 'Reactivar Bot';
    } else {
      toggleBtn.classList.remove('bot-paused');
      toggleBtn.classList.add('bot-active');
      toggleBtn.title = 'Pausar Bot';
    }
  }
  if (toggleLabel) {
    toggleLabel.textContent = paused ? 'Reactivar Bot' : 'Pausar Bot';
  }
  if (banner) {
    if (paused) {
      banner.classList.remove('d-none');
    } else {
      banner.classList.add('d-none');
    }
  }
}

async function toggleBotPause() {
  if (!inboxState.activePhone) return;

  var toggleBtn = document.getElementById('inbox-bot-toggle-btn');
  if (toggleBtn) toggleBtn.disabled = true;

  try {
    var endpoint = inboxState.botPaused ? 'resume-bot' : 'pause-bot';
    var res = await authFetch('/messages/inbox/' + encodeURIComponent(inboxState.activePhone) + '/' + endpoint, {
      method: 'PUT'
    });

    if (!res || !res.ok) {
      showAlert('Error al cambiar estado del bot', 'danger');
      return;
    }

    var data = await res.json();
    inboxState.botPaused = data.bot_paused;
    updateBotPausedUI(inboxState.botPaused);
    showAlert(inboxState.botPaused ? 'Bot pausado para este contacto' : 'Bot reactivado para este contacto', 'success');
  } catch (e) {
    showAlert('Error al cambiar estado del bot', 'danger');
  } finally {
    if (toggleBtn) toggleBtn.disabled = false;
  }
}

// Exports
window.initInbox = initInbox;
window.loadInbox = loadInbox;
window.stopInboxPolling = stopInboxPolling;
window.openChat = openChat;
window.closeChat = closeChat;
window.handleInboxSearch = handleInboxSearch;
window.handleReplyKeypress = handleReplyKeypress;
window.handleSendClick = handleSendClick;
window.toggleBotPause = toggleBotPause;
window.fetchBotStatus = fetchBotStatus;
