// src/chatbotEngine.js
const logger = require('./logger');
const pg = require('./postgresClient');
const crypto = require('crypto');

// ─── Encryption helpers for AI API keys ───────────────────────────────────────
const ENCRYPTION_KEY = process.env.CHATBOT_ENCRYPTION_KEY || 'default-chatbot-key-change-me-32!'; // 32 bytes
const ALGORITHM = 'aes-256-cbc';

function encrypt(text) {
  if (!text) return null;
  const key = Buffer.from(ENCRYPTION_KEY.padEnd(32, '0').slice(0, 32), 'utf8');
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  return iv.toString('hex') + ':' + encrypted;
}

function decrypt(text) {
  if (!text) return null;
  try {
    const key = Buffer.from(ENCRYPTION_KEY.padEnd(32, '0').slice(0, 32), 'utf8');
    const [ivHex, encrypted] = text.split(':');
    const iv = Buffer.from(ivHex, 'hex');
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  } catch (err) {
    logger.error({ err: err?.message }, 'Failed to decrypt AI API key');
    return null;
  }
}

// ─── Ensure tables exist (memoized) ──────────────────────────────────────────
const ensureChatbotTables = (() => {
  let created = false;
  return async () => {
    if (created) return;
    await pg.query(`
      CREATE TABLE IF NOT EXISTS chatbot_configs (
        id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
        user_id VARCHAR(255) NOT NULL,
        name VARCHAR(255) NOT NULL DEFAULT 'Mi Bot',
        enabled BOOLEAN DEFAULT false,
        active_hours_start TIME DEFAULT '08:00',
        active_hours_end TIME DEFAULT '22:00',
        active_days INTEGER[] DEFAULT '{1,2,3,4,5}',
        cooldown_minutes INTEGER DEFAULT 30,
        only_known_contacts BOOLEAN DEFAULT true,
        max_responses_per_contact INTEGER DEFAULT 5,
        ai_enabled BOOLEAN DEFAULT false,
        ai_provider VARCHAR(50),
        ai_api_key_encrypted TEXT,
        ai_model VARCHAR(100),
        ai_system_prompt TEXT,
        welcome_message TEXT,
        fallback_message TEXT DEFAULT 'No entendí tu mensaje. Escribí "menu" para ver las opciones.',
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_chatbot_configs_user ON chatbot_configs(user_id);

      CREATE TABLE IF NOT EXISTS chatbot_nodes (
        id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
        config_id UUID NOT NULL REFERENCES chatbot_configs(id) ON DELETE CASCADE,
        node_id VARCHAR(100) NOT NULL,
        type VARCHAR(50) NOT NULL,
        content JSONB NOT NULL DEFAULT '{}',
        position_x INTEGER DEFAULT 0,
        position_y INTEGER DEFAULT 0,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_chatbot_nodes_config ON chatbot_nodes(config_id);
      CREATE INDEX IF NOT EXISTS idx_chatbot_nodes_node_id ON chatbot_nodes(config_id, node_id);

      CREATE TABLE IF NOT EXISTS chatbot_conversations (
        id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
        user_id VARCHAR(255) NOT NULL,
        contact_phone VARCHAR(20) NOT NULL,
        current_node_id VARCHAR(100),
        context JSONB DEFAULT '{}',
        responses_today INTEGER DEFAULT 0,
        last_response_at TIMESTAMPTZ,
        last_human_intervention_at TIMESTAMPTZ,
        is_active BOOLEAN DEFAULT true,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(user_id, contact_phone)
      );
      CREATE INDEX IF NOT EXISTS idx_chatbot_conv_user ON chatbot_conversations(user_id);
      CREATE INDEX IF NOT EXISTS idx_chatbot_conv_user_phone ON chatbot_conversations(user_id, contact_phone);

      CREATE TABLE IF NOT EXISTS incoming_messages (
        id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
        user_id VARCHAR(255) NOT NULL,
        contact_phone VARCHAR(20) NOT NULL,
        contact_name VARCHAR(255),
        message_text TEXT,
        message_type VARCHAR(50) DEFAULT 'text',
        media_url TEXT,
        is_from_contact BOOLEAN DEFAULT true,
        is_bot_reply BOOLEAN DEFAULT false,
        read BOOLEAN DEFAULT false,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_incoming_user_phone ON incoming_messages(user_id, contact_phone, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_incoming_user_date ON incoming_messages(user_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_incoming_unread ON incoming_messages(user_id, read, created_at DESC);
    `);
    created = true;
    logger.info('Chatbot tables ensured');
  };
})();

// ─── Accent-insensitive normalization ────────────────────────────────────────
function normalizeText(str) {
  if (!str) return '';
  return str.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
}

// ─── Deactivation keywords ───────────────────────────────────────────────────
const DEACTIVATION_KEYWORDS = ['salir', 'hablar con persona', 'agente', 'humano', 'operador'];

// ─── Config cache (per-user, short TTL) ──────────────────────────────────────
const configCache = new Map();
const CONFIG_CACHE_TTL = 30_000; // 30 seconds

async function getCachedConfig(userId) {
  const cached = configCache.get(userId);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.config;
  }
  const result = await pg.query(
    'SELECT * FROM chatbot_configs WHERE user_id = $1 LIMIT 1',
    [userId]
  );
  const config = result.rows[0] || null;
  // Attach user's country for timezone-aware checks
  if (config) {
    try {
      const { db } = require('./firebaseAdmin');
      if (db) {
        const snap = await db.collection('users').doc(userId).get();
        config._userCountry = snap.exists ? (snap.data().country || 'PY') : 'PY';
      } else {
        config._userCountry = 'PY';
      }
    } catch {
      config._userCountry = 'PY';
    }
  }
  configCache.set(userId, { config, expiresAt: Date.now() + CONFIG_CACHE_TTL });
  return config;
}

function invalidateConfigCache(userId) {
  configCache.delete(userId);
}

// ─── Node cache (per config_id) ──────────────────────────────────────────────
const nodesCache = new Map();
const NODES_CACHE_TTL = 30_000;

async function getCachedNodes(configId) {
  const cached = nodesCache.get(configId);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.nodes;
  }
  const result = await pg.query(
    'SELECT * FROM chatbot_nodes WHERE config_id = $1',
    [configId]
  );
  const nodes = result.rows;
  nodesCache.set(configId, { nodes, expiresAt: Date.now() + NODES_CACHE_TTL });
  return nodes;
}

function invalidateNodesCache(configId) {
  nodesCache.delete(configId);
}

// ─── Variable replacement ────────────────────────────────────────────────────
function replaceVariables(text, contactData) {
  if (!text) return text;
  return text
    .replace(/\{nombre\}/gi, contactData.nombre || '')
    .replace(/\{tratamiento\}/gi, contactData.sustantivo || '')
    .replace(/\{grupo\}/gi, contactData.grupo || '')
    .replace(/\{telefono\}/gi, contactData.phone || '');
}

// ─── Smart activation checks ────────────────────────────────────────────────
function isWithinActiveHours(config) {
  // Get local time using the user's country timezone
  const COUNTRY_TZ = {
    PY: 'America/Asuncion', AR: 'America/Buenos_Aires', BR: 'America/Sao_Paulo',
    CL: 'America/Santiago', UY: 'America/Montevideo', CO: 'America/Bogota',
    PE: 'America/Lima', EC: 'America/Guayaquil', BO: 'America/La_Paz',
    VE: 'America/Caracas', MX: 'America/Mexico_City', US: 'America/New_York',
    ES: 'Europe/Madrid'
  };
  const tz = COUNTRY_TZ[config._userCountry] || 'America/Asuncion';
  const now = new Date();
  let localHours, localMinutes;
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: 'numeric', hour12: false }).formatToParts(now);
    localHours = parseInt(parts.find(p => p.type === 'hour')?.value) || 0;
    localMinutes = parseInt(parts.find(p => p.type === 'minute')?.value) || 0;
  } catch {
    // Fallback to UTC-3 (Paraguay summer)
    localHours = (now.getUTCHours() - 3 + 24) % 24;
    localMinutes = now.getUTCMinutes();
  }
  const currentTime = localHours * 60 + localMinutes;

  const [startH, startM] = (config.active_hours_start || '08:00').split(':').map(Number);
  const [endH, endM] = (config.active_hours_end || '22:00').split(':').map(Number);
  const startTime = startH * 60 + startM;
  const endTime = endH * 60 + endM;

  if (startTime <= endTime) {
    return currentTime >= startTime && currentTime <= endTime;
  }
  // Handles overnight range (e.g. 22:00 - 06:00)
  return currentTime >= startTime || currentTime <= endTime;
}

function isActiveDay(config) {
  const COUNTRY_TZ = {
    PY: 'America/Asuncion', AR: 'America/Buenos_Aires', BR: 'America/Sao_Paulo',
    CL: 'America/Santiago', UY: 'America/Montevideo', CO: 'America/Bogota',
    PE: 'America/Lima', EC: 'America/Guayaquil', BO: 'America/La_Paz',
    VE: 'America/Caracas', MX: 'America/Mexico_City', US: 'America/New_York',
    ES: 'Europe/Madrid'
  };
  const tz = COUNTRY_TZ[config._userCountry] || 'America/Asuncion';
  const now = new Date();
  let jsDay;
  try {
    const dayStr = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short' }).format(now);
    const dayMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
    jsDay = dayMap[dayStr] ?? now.getDay();
  } catch {
    jsDay = now.getDay();
  }
  const isoDay = jsDay === 0 ? 7 : jsDay;
  const activeDays = config.active_days || [1, 2, 3, 4, 5];
  return activeDays.includes(isoDay);
}

async function isKnownContact(userId, phone) {
  const result = await pg.query(
    'SELECT id, nombre, sustantivo, grupo FROM contacts WHERE user_id = $1 AND phone = $2 LIMIT 1',
    [userId, phone]
  );
  return result.rows[0] || null;
}

function isCooldownElapsed(conversation, cooldownMinutes) {
  if (!conversation || !conversation.last_response_at) return true;
  const elapsed = Date.now() - new Date(conversation.last_response_at).getTime();
  return elapsed >= cooldownMinutes * 60_000;
}

function isHumanInterventionRecent(conversation) {
  if (!conversation || !conversation.last_human_intervention_at) return false;
  const elapsed = Date.now() - new Date(conversation.last_human_intervention_at).getTime();
  return elapsed < 30 * 60_000; // 30 minutes
}

function isMaxResponsesReached(conversation, maxResponses) {
  if (!conversation) return false;
  // Reset counter if last response was on a different day
  if (conversation.last_response_at) {
    const lastDate = new Date(conversation.last_response_at).toDateString();
    const today = new Date().toDateString();
    if (lastDate !== today) return false;
  }
  return (conversation.responses_today || 0) >= maxResponses;
}

// ─── Conversation state management ──────────────────────────────────────────
async function getOrCreateConversation(userId, contactPhone) {
  const result = await pg.query(
    'SELECT * FROM chatbot_conversations WHERE user_id = $1 AND contact_phone = $2 LIMIT 1',
    [userId, contactPhone]
  );
  if (result.rows[0]) {
    const conv = result.rows[0];

    // Reset responses_today if last_response_at is from a previous day
    if (conv.last_response_at) {
      const lastDate = new Date(conv.last_response_at).toDateString();
      const today = new Date().toDateString();
      if (lastDate !== today && conv.responses_today > 0) {
        await pg.query(
          'UPDATE chatbot_conversations SET responses_today = 0, updated_at = NOW() WHERE id = $1',
          [conv.id]
        );
        conv.responses_today = 0;
      }
    }

    return conv;
  }

  const insert = await pg.query(
    `INSERT INTO chatbot_conversations (user_id, contact_phone, is_active)
     VALUES ($1, $2, true)
     ON CONFLICT (user_id, contact_phone) DO UPDATE
       SET is_active = true, current_node_id = NULL, context = '{}',
           responses_today = 0, updated_at = NOW()
     RETURNING *`,
    [userId, contactPhone]
  );
  return insert.rows[0];
}

async function updateConversationState(conversationId, nodeId, context) {
  // Also reset responses_today if last_response_at was on a different day
  await pg.query(
    `UPDATE chatbot_conversations
     SET current_node_id = $1,
         context = COALESCE($2, context),
         responses_today = CASE
           WHEN last_response_at IS NULL OR DATE(last_response_at) < CURRENT_DATE
           THEN 1
           ELSE responses_today + 1
         END,
         last_response_at = NOW()
     WHERE id = $3`,
    [nodeId, context ? JSON.stringify(context) : null, conversationId]
  );
}

async function deactivateConversation(userId, contactPhone) {
  await pg.query(
    `UPDATE chatbot_conversations SET is_active = false, updated_at = NOW()
     WHERE user_id = $1 AND contact_phone = $2`,
    [userId, contactPhone]
  );
}

async function resetConversation(userId, contactPhone) {
  await pg.query(
    `UPDATE chatbot_conversations
     SET current_node_id = NULL, context = '{}', responses_today = 0,
         is_active = true, updated_at = NOW()
     WHERE user_id = $1 AND contact_phone = $2`,
    [userId, contactPhone]
  );
}

async function markHumanIntervention(userId, contactPhone) {
  await pg.query(
    `UPDATE chatbot_conversations
     SET last_human_intervention_at = NOW(), updated_at = NOW()
     WHERE user_id = $1 AND contact_phone = $2`,
    [userId, contactPhone]
  );
}

// ─── Message logging ─────────────────────────────────────────────────────────
async function logMessage(userId, contactPhone, contactName, text, messageType, isFromContact, isBotReply, mediaUrl) {
  try {
    // Skip logging protocol messages with no meaningful content
    const hasText = text !== undefined && text !== null && text !== '';
    const hasMedia = !!mediaUrl || (messageType && messageType !== 'text');
    if (!hasText && !hasMedia && !isBotReply) {
      return; // Nothing meaningful to store
    }

    await pg.query(
      `INSERT INTO incoming_messages
       (user_id, contact_phone, contact_name, message_text, message_type, media_url, is_from_contact, is_bot_reply)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [userId, contactPhone, contactName || null, hasText ? text : null, messageType || 'text', mediaUrl || null, isFromContact, isBotReply]
    );
  } catch (err) {
    logger.error({ err: err?.message, userId, contactPhone }, 'Failed to log incoming message');
  }
}

// ─── AI API call ─────────────────────────────────────────────────────────────
async function callAI(config, nodeContent, messageText, conversationContext) {
  const apiKey = decrypt(config.ai_api_key_encrypted);
  if (!apiKey) {
    logger.warn({ userId: config.user_id }, 'AI API key not configured or decryption failed');
    return null;
  }

  const provider = config.ai_provider || 'openai';
  const model = config.ai_model || 'gpt-3.5-turbo';
  const systemPrompt = nodeContent?.prompt || config.ai_system_prompt || 'Eres un asistente amable.';
  const maxTokens = nodeContent?.max_tokens || 500;

  try {
    if (provider === 'openai' || provider === 'groq') {
      const baseUrl = provider === 'groq'
        ? 'https://api.groq.com/openai/v1'
        : 'https://api.openai.com/v1';

      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: systemPrompt },
            ...(conversationContext?.messages || []).slice(-10),
            { role: 'user', content: messageText },
          ],
          max_tokens: maxTokens,
        }),
        signal: AbortSignal.timeout(30_000),
      });

      if (!response.ok) {
        const errBody = await response.text();
        logger.error({ provider, status: response.status, body: errBody.slice(0, 200) }, 'AI API error');
        return null;
      }

      const data = await response.json();
      return data.choices?.[0]?.message?.content || null;
    }

    if (provider === 'anthropic') {
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model,
          max_tokens: maxTokens,
          system: systemPrompt,
          messages: [
            ...(conversationContext?.messages || []).slice(-10).map(m => ({
              role: m.role === 'system' ? 'user' : m.role,
              content: m.content,
            })),
            { role: 'user', content: messageText },
          ],
        }),
        signal: AbortSignal.timeout(30_000),
      });

      if (!response.ok) {
        const errBody = await response.text();
        logger.error({ provider, status: response.status, body: errBody.slice(0, 200) }, 'AI API error');
        return null;
      }

      const data = await response.json();
      return data.content?.[0]?.text || null;
    }

    logger.warn({ provider }, 'Unsupported AI provider');
    return null;
  } catch (err) {
    logger.error({ err: err?.message, provider }, 'AI API call failed');
    return null;
  }
}

// ─── Find node by ID ─────────────────────────────────────────────────────────
function findNode(nodes, nodeId) {
  return nodes.find(n => n.node_id === nodeId) || null;
}

// ─── Execute a node → returns { text, nextNodeId, mediaPayload } ─────────────
async function executeNode(node, messageText, config, contactData, conversationContext) {
  if (!node) return { text: config.fallback_message, nextNodeId: null };

  const content = node.content || {};
  const type = node.type;

  switch (type) {
    case 'message': {
      const text = replaceVariables(content.text || '', contactData);
      return { text, nextNodeId: content.next || null };
    }

    case 'menu': {
      const menuText = replaceVariables(content.text || '', contactData);
      const options = content.options || [];

      // Build the menu display text
      let menuDisplay = menuText + '\n';
      options.forEach((opt, idx) => {
        menuDisplay += `\n${idx + 1}. ${opt.label}`;
      });

      if (messageText) {
        // Try to match user input to a menu option by number or label (accent-insensitive)
        const input = normalizeText(messageText);
        const match = options.find((opt, idx) => {
          const optNum = String(idx + 1);
          const optLabel = normalizeText(opt.label || '');
          return input === optNum || input === optLabel || optLabel.includes(input);
        });

        if (match) {
          return { text: null, nextNodeId: match.trigger || match.next || null };
        }

        // No match found — send fallback + re-display menu, stay on same node
        const fallback = config.fallback_message || 'No entendí tu respuesta.';
        return { text: fallback + '\n\n' + menuDisplay, nextNodeId: null, stayOnNode: true };
      }

      // No user input — just show the menu (first time display)
      return { text: menuDisplay, nextNodeId: null, stayOnNode: true };
    }

    case 'media': {
      const caption = replaceVariables(content.caption || '', contactData);
      return {
        text: caption,
        nextNodeId: content.next || null,
        mediaPayload: {
          type: content.type || 'image', // image, video, document
          url: content.url,
        },
      };
    }

    case 'redirect': {
      const text = replaceVariables(content.message || 'Te redirijo con un agente.', contactData);
      return { text, nextNodeId: null, deactivate: true };
    }

    case 'ai': {
      if (!config.ai_enabled) {
        return { text: config.fallback_message, nextNodeId: content.next || null };
      }
      const aiResponse = await callAI(config, content, messageText, conversationContext);
      if (!aiResponse) {
        return { text: config.fallback_message, nextNodeId: content.next || null };
      }
      return { text: aiResponse, nextNodeId: content.next || null };
    }

    case 'end': {
      const text = replaceVariables(content.text || 'Gracias por contactarnos!', contactData);
      return { text, nextNodeId: null, resetConversation: true };
    }

    default:
      return { text: config.fallback_message, nextNodeId: null };
  }
}

// ─── MAIN: Handle incoming message ──────────────────────────────────────────
/**
 * @param {string} userId - Bot owner's user ID
 * @param {object} messageInfo - { text, type, mediaUrl }
 * @param {string} contactPhone - Normalized phone of the sender
 * @param {string} contactName - Push name from WhatsApp
 * @param {Function} sendFn - async (jid, content) => {} — function to send replies
 * @returns {object|null} { responded: boolean, response?: string }
 */
async function handleIncomingMessage(userId, messageInfo, contactPhone, contactName, sendFn) {
  try {
    await ensureChatbotTables();

    // 1. Get chatbot config
    const config = await getCachedConfig(userId);
    if (!config || !config.enabled) {
      // Still log the message even if bot is disabled
      await logMessage(userId, contactPhone, contactName, messageInfo.text, messageInfo.type, true, false, messageInfo.mediaUrl);
      return { responded: false, reason: 'bot_disabled' };
    }

    // 2. Smart activation checks
    if (!isActiveDay(config)) {
      await logMessage(userId, contactPhone, contactName, messageInfo.text, messageInfo.type, true, false, messageInfo.mediaUrl);
      return { responded: false, reason: 'inactive_day' };
    }

    if (!isWithinActiveHours(config)) {
      await logMessage(userId, contactPhone, contactName, messageInfo.text, messageInfo.type, true, false, messageInfo.mediaUrl);
      return { responded: false, reason: 'outside_hours' };
    }

    // 3. Check if contact is known (if required)
    let contactData = { phone: contactPhone, nombre: contactName, sustantivo: '', grupo: '' };
    if (config.only_known_contacts) {
      const contact = await isKnownContact(userId, contactPhone);
      if (!contact) {
        await logMessage(userId, contactPhone, contactName, messageInfo.text, messageInfo.type, true, false, messageInfo.mediaUrl);
        return { responded: false, reason: 'unknown_contact' };
      }
      contactData = { phone: contactPhone, nombre: contact.nombre || contactName, sustantivo: contact.sustantivo || '', grupo: contact.grupo || '' };
    }

    // 4. Log the incoming message
    await logMessage(userId, contactPhone, contactName, messageInfo.text, messageInfo.type, true, false, messageInfo.mediaUrl);

    // 5. Get or create conversation
    const conversation = await getOrCreateConversation(userId, contactPhone);

    // 6. Check deactivation keywords
    if (messageInfo.text) {
      const lowerText = messageInfo.text.trim().toLowerCase();
      if (DEACTIVATION_KEYWORDS.some(kw => lowerText === kw || lowerText.includes(kw))) {
        await deactivateConversation(userId, contactPhone);
        const deactivationMsg = 'Un agente te atenderá pronto. Gracias por tu paciencia.';
        const jid = `${contactPhone}@s.whatsapp.net`;
        await sendFn(jid, { text: deactivationMsg });
        await logMessage(userId, contactPhone, contactName, deactivationMsg, 'text', false, true, null);
        return { responded: true, response: deactivationMsg, reason: 'deactivated_by_keyword' };
      }
    }

    // 7. Check if conversation is active
    if (!conversation.is_active) {
      return { responded: false, reason: 'conversation_inactive' };
    }

    // 8. Check human intervention (bot stays quiet for 30 min after owner manually replies)
    if (isHumanInterventionRecent(conversation)) {
      return { responded: false, reason: 'human_intervention' };
    }

    // 9. Check cooldown
    if (!isCooldownElapsed(conversation, config.cooldown_minutes)) {
      return { responded: false, reason: 'cooldown' };
    }

    // 10. Check max responses per day
    if (isMaxResponsesReached(conversation, config.max_responses_per_contact)) {
      // Send a one-time message that an agent will attend
      if (conversation.responses_today === config.max_responses_per_contact) {
        const maxMsg = 'Un agente te atenderá pronto. Gracias por tu paciencia.';
        const jid = `${contactPhone}@s.whatsapp.net`;
        await sendFn(jid, { text: maxMsg });
        await logMessage(userId, contactPhone, contactName, maxMsg, 'text', false, true, null);
        // Increment to avoid sending this message again
        await pg.query(
          'UPDATE chatbot_conversations SET responses_today = responses_today + 1 WHERE id = $1',
          [conversation.id]
        );
      }
      return { responded: false, reason: 'max_responses' };
    }

    // 11. Get flow nodes
    const nodes = await getCachedNodes(config.id);

    // 12. Determine response
    let currentNodeId = conversation.current_node_id;
    let responseText = null;
    let nextNodeId = null;
    let mediaPayload = null;
    let shouldDeactivate = false;
    let shouldReset = false;

    if (!currentNodeId) {
      // First interaction — send welcome message + first node (e.g. menu)
      const welcomeText = config.welcome_message ? replaceVariables(config.welcome_message, contactData) : null;

      // Find first node (look for 'welcome' or 'start' or first menu node)
      const firstNode = findNode(nodes, 'welcome') || findNode(nodes, 'start') || nodes.find(n => n.type === 'menu');

      if (firstNode) {
        // Execute the first node to get its content (e.g. the menu text)
        const result = await executeNode(firstNode, null, config, contactData, conversation.context);

        if (welcomeText && result.text) {
          // Combine welcome + first node text (e.g. greeting + menu)
          responseText = welcomeText + '\n\n' + result.text;
        } else {
          responseText = welcomeText || result.text;
        }

        // Stay on the first node so the user can respond to it (e.g. pick menu option)
        nextNodeId = firstNode.node_id;
        mediaPayload = result.mediaPayload;
        shouldDeactivate = result.deactivate;
        shouldReset = result.resetConversation;
      } else {
        // No nodes — just send welcome or fallback
        responseText = welcomeText || config.fallback_message;
      }
    } else {
      // Continuing conversation — find current node and process input
      const currentNode = findNode(nodes, currentNodeId);
      if (!currentNode) {
        // Node was deleted — reset
        responseText = config.fallback_message;
        nextNodeId = null;
      } else {
        const result = await executeNode(currentNode, messageInfo.text, config, contactData, conversation.context);
        responseText = result.text;
        nextNodeId = result.nextNodeId;
        mediaPayload = result.mediaPayload;
        shouldDeactivate = result.deactivate;
        shouldReset = result.resetConversation;

        // If we got a nextNodeId, execute that node too (for immediate transitions)
        if (nextNodeId && !result.stayOnNode) {
          const nextNode = findNode(nodes, nextNodeId);
          if (nextNode) {
            const nextResult = await executeNode(nextNode, null, config, contactData, conversation.context);
            // Append or replace response
            if (nextResult.text) {
              responseText = responseText ? responseText + '\n\n' + nextResult.text : nextResult.text;
            }
            if (!nextResult.stayOnNode && nextResult.nextNodeId) {
              nextNodeId = nextResult.nextNodeId;
            }
            if (nextResult.mediaPayload) mediaPayload = nextResult.mediaPayload;
            if (nextResult.deactivate) shouldDeactivate = true;
            if (nextResult.resetConversation) shouldReset = true;
          }
        }
      }
    }

    // 13. Send response
    const jid = `${contactPhone}@s.whatsapp.net`;

    if (mediaPayload && mediaPayload.url) {
      try {
        const mediaContent = {};
        if (mediaPayload.type === 'image') {
          mediaContent.image = { url: mediaPayload.url };
          if (responseText) mediaContent.caption = responseText;
        } else if (mediaPayload.type === 'video') {
          mediaContent.video = { url: mediaPayload.url };
          if (responseText) mediaContent.caption = responseText;
        } else if (mediaPayload.type === 'document') {
          mediaContent.document = { url: mediaPayload.url };
          if (responseText) mediaContent.caption = responseText;
          mediaContent.fileName = mediaPayload.url.split('/').pop() || 'document';
        }
        await sendFn(jid, mediaContent);
      } catch (mediaErr) {
        logger.error({ err: mediaErr?.message, userId, contactPhone }, 'Failed to send media, falling back to text');
        if (responseText) {
          await sendFn(jid, { text: responseText });
        }
      }
    } else if (responseText) {
      logger.info({ userId, contactPhone, jid, responseText: responseText?.substring(0, 80) }, 'Chatbot sending text reply');
      try {
        await sendFn(jid, { text: responseText });
        logger.info({ userId, contactPhone }, 'Chatbot reply sent successfully');
      } catch (sendErr) {
        logger.error({ err: sendErr?.message, userId, contactPhone, jid }, 'Chatbot failed to send reply via WhatsApp');
      }
    }

    // 14. Log bot reply
    if (responseText) {
      await logMessage(userId, contactPhone, contactName, responseText, 'text', false, true, null);
    }

    // 15. Update conversation state
    if (shouldReset) {
      await resetConversation(userId, contactPhone);
    } else if (shouldDeactivate) {
      await deactivateConversation(userId, contactPhone);
    } else {
      await updateConversationState(conversation.id, nextNodeId || currentNodeId, conversation.context);
    }

    return {
      responded: !!responseText,
      response: responseText,
      nextNode: nextNodeId,
    };
  } catch (err) {
    // NEVER crash the main app
    logger.error({ err: err?.message, stack: err?.stack, userId, contactPhone }, 'Chatbot engine error');
    return { responded: false, reason: 'error', error: err?.message };
  }
}

// ─── Record outgoing human message (for human intervention detection) ────────
async function recordOutgoingMessage(userId, contactPhone, messageText) {
  try {
    await ensureChatbotTables();
    await markHumanIntervention(userId, contactPhone);
    await logMessage(userId, contactPhone, null, messageText, 'text', false, false, null);
  } catch (err) {
    logger.error({ err: err?.message, userId, contactPhone }, 'Failed to record outgoing message');
  }
}

module.exports = {
  ensureChatbotTables,
  handleIncomingMessage,
  recordOutgoingMessage,
  encrypt,
  decrypt,
  invalidateConfigCache,
  invalidateNodesCache,
  markHumanIntervention,
  deactivateConversation,
  resetConversation,
};
