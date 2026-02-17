const { getRedis } = require('./redisClient');
const logger = require('./logger');

function now() { return Date.now(); }

function contactsKey(userId) { return `ms:contacts:${userId}`; } // phone -> json
function contactIdMapKey(userId) { return `ms:contacts:idmap:${userId}`; } // id -> phone
function campaignSeqKey() { return 'ms:campaign:seq'; }
function campaignDataKey(campaignId) { return `ms:campaign:data:${campaignId}`; }
function campaignRecipientsKey(campaignId) { return `ms:campaign:recipients:${campaignId}`; } // phone -> json
function userCampaignsKey(userId) { return `ms:campaigns:${userId}`; } // zset score=createdAt member=campaignId
function eventSeqKey(userId) { return `ms:metrics:events:seq:${userId}`; }
function eventZKey(userId) { return `ms:metrics:events:z:${userId}`; } // score=timestamp member=id
function eventHashKey(userId) { return `ms:metrics:events:h:${userId}`; } // id -> json
function monthlySentKey(userId) { return `ms:metrics:monthly:sent:${userId}`; } // YYYY-MM -> count
function monthlyErrorKey(userId) { return `ms:metrics:monthly:error:${userId}`; } // YYYY-MM -> count
function contactStatsKey(userId) { return `ms:metrics:contact:stats:${userId}`; } // phone -> json

function monthKey(ts) {
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

function dayKey(ts) {
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function hourKey(ts) {
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const h = String(d.getHours()).padStart(2, '0');
  return `${y}-${m}-${day} ${h}:00`;
}

function safeJsonParse(raw) {
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

function mkContactId() {
  return `ct_${Math.random().toString(36).slice(2, 10)}_${Date.now().toString(36)}`;
}

async function getContactByPhone(userId, phone) {
  const r = getRedis();
  const raw = await r.hget(contactsKey(userId), String(phone));
  return safeJsonParse(raw);
}

async function getContactById(userId, contactId) {
  const r = getRedis();
  const phone = await r.hget(contactIdMapKey(userId), String(contactId));
  if (!phone) return null;
  return getContactByPhone(userId, phone);
}

async function upsertContact(userId, data, source = 'manual') {
  const r = getRedis();
  const phone = String(data.phone || '').trim();
  if (!phone) throw new Error('El teléfono es obligatorio');

  const existing = await getContactByPhone(userId, phone);
  const ts = now();

  if (existing) {
    const updated = {
      ...existing,
      nombre: data.nombre !== undefined ? data.nombre : existing.nombre,
      sustantivo: data.sustantivo !== undefined ? data.sustantivo : existing.sustantivo,
      grupo: data.grupo !== undefined ? data.grupo : existing.grupo,
      updatedAt: ts,
      lastSeenAt: ts,
    };
    await r.hset(contactsKey(userId), phone, JSON.stringify(updated));
    return { contact: updated, created: false, updated: true };
  }

  const createdContact = {
    id: mkContactId(),
    phone,
    nombre: data.nombre || null,
    sustantivo: data.sustantivo || null,
    grupo: data.grupo || null,
    source: source || 'manual',
    createdAt: ts,
    updatedAt: ts,
    lastSeenAt: ts,
  };
  await r.hset(contactsKey(userId), phone, JSON.stringify(createdContact));
  await r.hset(contactIdMapKey(userId), createdContact.id, phone);
  return { contact: createdContact, created: true, updated: false };
}

async function updateContact(userId, contactId, patch) {
  const r = getRedis();
  const existing = await getContactById(userId, contactId);
  if (!existing) return null;

  const targetPhone = String(patch.phone || existing.phone).trim();
  if (!targetPhone) throw new Error('El teléfono es obligatorio');

  if (targetPhone !== existing.phone) {
    const phoneTaken = await getContactByPhone(userId, targetPhone);
    if (phoneTaken && phoneTaken.id !== existing.id) {
      throw new Error('Ya existe un contacto con ese número');
    }
  }

  const merged = {
    ...existing,
    phone: targetPhone,
    nombre: patch.nombre !== undefined ? patch.nombre : existing.nombre,
    sustantivo: patch.sustantivo !== undefined ? patch.sustantivo : existing.sustantivo,
    grupo: patch.grupo !== undefined ? patch.grupo : existing.grupo,
    updatedAt: now(),
  };

  const multi = r.multi();
  if (targetPhone !== existing.phone) {
    multi.hdel(contactsKey(userId), existing.phone);
    multi.hset(contactIdMapKey(userId), existing.id, targetPhone);
  }
  multi.hset(contactsKey(userId), targetPhone, JSON.stringify(merged));
  await multi.exec();
  return merged;
}

async function deleteContact(userId, contactId) {
  const r = getRedis();
  const existing = await getContactById(userId, contactId);
  if (!existing) return false;
  const multi = r.multi();
  multi.hdel(contactsKey(userId), existing.phone);
  multi.hdel(contactIdMapKey(userId), existing.id);
  multi.hdel(contactStatsKey(userId), existing.phone);
  await multi.exec();
  return true;
}

async function listContacts(userId, opts = {}) {
  const r = getRedis();
  const search = String(opts.search || '').trim().toLowerCase();
  const group = String(opts.group || '').trim().toLowerCase();
  const page = Math.max(1, Number(opts.page) || 1);
  const pageSize = Math.max(1, Math.min(200, Number(opts.pageSize) || 25));

  const rawMap = await r.hgetall(contactsKey(userId));
  let items = Object.values(rawMap)
    .map(safeJsonParse)
    .filter(Boolean);

  if (search) {
    items = items.filter((c) => {
      const haystack = `${c.phone || ''} ${c.nombre || ''} ${c.sustantivo || ''} ${c.grupo || ''}`.toLowerCase();
      return haystack.includes(search);
    });
  }

  if (group) {
    items = items.filter((c) => String(c.grupo || '').toLowerCase() === group);
  }

  items.sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0));
  const total = items.length;
  const offset = (page - 1) * pageSize;
  const paged = items.slice(offset, offset + pageSize);

  return { items: paged, total, page, pageSize };
}

// Obtener grupos únicos de contactos
async function getContactGroups(userId) {
  const r = getRedis();
  const rawMap = await r.hgetall(contactsKey(userId));
  const items = Object.values(rawMap)
    .map(safeJsonParse)
    .filter(Boolean);

  const groups = new Set();
  items.forEach((c) => {
    if (c.grupo && String(c.grupo).trim()) {
      groups.add(String(c.grupo).trim());
    }
  });

  return Array.from(groups).sort();
}

// Obtener contactos por IDs
async function getContactsByIds(userId, contactIds) {
  const r = getRedis();
  const rawMap = await r.hgetall(contactsKey(userId));
  const all = Object.values(rawMap)
    .map(safeJsonParse)
    .filter(Boolean);

  const idSet = new Set(contactIds);
  return all.filter((c) => idSet.has(c.id));
}

// Obtener contactos por grupo
async function getContactsByGroup(userId, groupName) {
  const r = getRedis();
  const rawMap = await r.hgetall(contactsKey(userId));
  const items = Object.values(rawMap)
    .map(safeJsonParse)
    .filter(Boolean);

  const group = String(groupName || '').trim().toLowerCase();
  return items.filter((c) => String(c.grupo || '').toLowerCase() === group);
}

async function importContactsFromEntries(userId, entries, source = 'csv') {
  const summary = { inserted: 0, updated: 0, total: 0 };
  const enriched = [];

  for (const entry of (Array.isArray(entries) ? entries : [])) {
    const number = String(entry?.number || '').trim();
    if (!number) continue;

    const vars = entry?.variables || {};
    const contactPayload = {
      phone: number,
      nombre: vars.nombre || entry.nombre || null,
      sustantivo: vars.sustantivo || entry.sustantivo || null,
      grupo: vars.grupo || entry.grupo || null,
    };

    const result = await upsertContact(userId, contactPayload, source);
    summary.total++;
    if (result.created) summary.inserted++;
    else summary.updated++;

    const c = result.contact;
    enriched.push({
      ...entry,
      number: c.phone,
      contactId: c.id,
      group: c.grupo || null,
      variables: {
        ...vars,
        nombre: c.nombre || vars.nombre || '',
        sustantivo: c.sustantivo || vars.sustantivo || '',
        grupo: c.grupo || vars.grupo || '',
      },
    });
  }

  return { entries: enriched, summary };
}

async function createCampaign(userId, payload = {}) {
  const r = getRedis();
  const seq = await r.incr(campaignSeqKey());
  const id = `cp_${seq}`;
  const ts = now();
  const campaign = {
    id,
    userId,
    name: payload.name || `Campaña ${new Date(ts).toLocaleString()}`,
    status: 'queued',
    totalRecipients: Number(payload.totalRecipients || 0),
    sentCount: 0,
    errorCount: 0,
    templateCount: Number(payload.templateCount || 1),
    createdAt: ts,
    updatedAt: ts,
    startedAt: null,
    finishedAt: null,
  };
  const multi = r.multi();
  multi.set(campaignDataKey(id), JSON.stringify(campaign));
  multi.zadd(userCampaignsKey(userId), ts, id);
  await multi.exec();
  return campaign;
}

async function getCampaign(userId, campaignId) {
  const r = getRedis();
  const raw = await r.get(campaignDataKey(campaignId));
  const campaign = safeJsonParse(raw);
  if (!campaign || campaign.userId !== userId) return null;
  return campaign;
}

async function saveCampaign(campaign) {
  const r = getRedis();
  await r.set(campaignDataKey(campaign.id), JSON.stringify(campaign));
}

async function setCampaignStatus(userId, campaignId, status, extra = {}) {
  const campaign = await getCampaign(userId, campaignId);
  if (!campaign) return null;
  const ts = now();
  campaign.status = status;
  campaign.updatedAt = ts;
  if (!campaign.startedAt && (status === 'running' || extra.startedAt)) {
    campaign.startedAt = extra.startedAt || ts;
  }
  if (status === 'completed' || status === 'canceled' || status === 'failed') {
    campaign.finishedAt = extra.finishedAt || ts;
  }
  if (extra.sentCount !== undefined) campaign.sentCount = Number(extra.sentCount);
  if (extra.errorCount !== undefined) campaign.errorCount = Number(extra.errorCount);
  await saveCampaign(campaign);
  await addMetricEvent(userId, {
    type: `campaign_${status}`,
    campaignId,
    timestamp: ts,
  });
  return campaign;
}

async function initCampaignRecipients(userId, campaignId, entries = []) {
  const r = getRedis();
  const key = campaignRecipientsKey(campaignId);
  const multi = r.multi();
  const ts = now();
  for (const entry of entries) {
    const phone = String(entry?.number || '').trim();
    if (!phone) continue;
    const rec = {
      phone,
      contactId: entry.contactId || null,
      nombre: entry?.variables?.nombre || entry.nombre || null,
      sustantivo: entry?.variables?.sustantivo || entry.sustantivo || null,
      group: entry?.variables?.grupo || entry.group || null,
      status: 'queued',
      attempts: 0,
      templateIndex: entry.templateIndex || null,
      errorMessage: null,
      createdAt: ts,
      updatedAt: ts,
      sentAt: null,
      errorAt: null,
    };
    multi.hset(key, phone, JSON.stringify(rec));
  }
  await multi.exec();
  await addMetricEvent(userId, { type: 'campaign_enqueue', campaignId, total: entries.length, timestamp: ts });
}

async function incCampaignCounter(userId, campaignId, field, by = 1) {
  const campaign = await getCampaign(userId, campaignId);
  if (!campaign) return null;
  campaign[field] = Number(campaign[field] || 0) + Number(by || 0);
  campaign.updatedAt = now();
  await saveCampaign(campaign);
  return campaign;
}

async function addMetricEvent(userId, event) {
  const r = getRedis();
  const ts = Number(event.timestamp || now());
  const seq = await r.incr(eventSeqKey(userId));
  const id = String(seq);
  const payload = { ...event, timestamp: ts };
  const multi = r.multi();
  multi.zadd(eventZKey(userId), ts, id);
  multi.hset(eventHashKey(userId), id, JSON.stringify(payload));
  await multi.exec();
}

async function incrementMonthlyCounters(userId, status, ts) {
  const r = getRedis();
  const key = monthKey(ts);
  if (status === 'sent') await r.hincrby(monthlySentKey(userId), key, 1);
  if (status === 'error') await r.hincrby(monthlyErrorKey(userId), key, 1);
}

async function updateContactStats(userId, recipient, status, ts) {
  const r = getRedis();
  const phone = String(recipient.phone || '').trim();
  if (!phone) return;
  const raw = await r.hget(contactStatsKey(userId), phone);
  const stats = safeJsonParse(raw) || {
    phone,
    contactId: recipient.contactId || null,
    nombre: recipient.nombre || null,
    grupo: recipient.group || null,
    sent: 0,
    error: 0,
    lastActivityAt: null,
  };
  if (status === 'sent') stats.sent += 1;
  if (status === 'error') stats.error += 1;
  if (recipient.nombre) stats.nombre = recipient.nombre;
  if (recipient.group) stats.grupo = recipient.group;
  stats.lastActivityAt = ts;
  await r.hset(contactStatsKey(userId), phone, JSON.stringify(stats));
}

async function recordRecipientStatus(userId, campaignId, entry, status, meta = {}) {
  if (!campaignId) return null;
  const r = getRedis();
  const phone = String(entry?.number || entry?.phone || '').trim();
  if (!phone) return null;

  const key = campaignRecipientsKey(campaignId);
  const raw = await r.hget(key, phone);
  const ts = Number(meta.timestamp || now());
  const recipient = safeJsonParse(raw) || {
    phone,
    contactId: entry.contactId || null,
    nombre: entry?.variables?.nombre || null,
    sustantivo: entry?.variables?.sustantivo || null,
    group: entry?.variables?.grupo || entry.group || null,
    status: 'queued',
    attempts: 0,
    createdAt: ts,
    updatedAt: ts,
  };

  const prevStatus = recipient.status;
  recipient.status = status;
  recipient.updatedAt = ts;
  if (meta.templateIndex !== undefined) recipient.templateIndex = meta.templateIndex;
  if (meta.attempts !== undefined) recipient.attempts = meta.attempts;
  if (status === 'sent') recipient.sentAt = ts;
  if (status === 'error') {
    recipient.errorAt = ts;
    recipient.errorMessage = meta.errorMessage || null;
  }
  if (meta.errorMessage && status !== 'error') recipient.errorMessage = meta.errorMessage;
  await r.hset(key, phone, JSON.stringify(recipient));

  if (status === 'sent' && prevStatus !== 'sent') {
    await incCampaignCounter(userId, campaignId, 'sentCount', 1);
    await incrementMonthlyCounters(userId, 'sent', ts);
    await updateContactStats(userId, recipient, 'sent', ts);
    await addMetricEvent(userId, {
      type: 'message_sent',
      campaignId,
      phone,
      contactId: recipient.contactId || null,
      group: recipient.group || 'Sin grupo',
      timestamp: ts,
    });
  } else if (status === 'error' && prevStatus !== 'error') {
    await incCampaignCounter(userId, campaignId, 'errorCount', 1);
    await incrementMonthlyCounters(userId, 'error', ts);
    await updateContactStats(userId, recipient, 'error', ts);
    await addMetricEvent(userId, {
      type: 'message_error',
      campaignId,
      phone,
      contactId: recipient.contactId || null,
      group: recipient.group || 'Sin grupo',
      errorMessage: meta.errorMessage || null,
      timestamp: ts,
    });
  } else if (status === 'sending') {
    await addMetricEvent(userId, {
      type: 'message_sending',
      campaignId,
      phone,
      contactId: recipient.contactId || null,
      group: recipient.group || 'Sin grupo',
      timestamp: ts,
    });
  }

  return recipient;
}

async function getCampaignDetail(userId, campaignId) {
  const r = getRedis();
  const campaign = await getCampaign(userId, campaignId);
  if (!campaign) return null;
  const rawMap = await r.hgetall(campaignRecipientsKey(campaignId));
  const recipients = Object.values(rawMap).map(safeJsonParse).filter(Boolean);
  recipients.sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0));
  return { campaign, recipients };
}

function parseRange(from, to) {
  const nowTs = now();
  const parseTs = (val, asEnd = false) => {
    if (!val) return null;
    const s = String(val).trim();
    if (!s) return null;
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
      const d = new Date(`${s}T00:00:00`);
      if (asEnd) d.setHours(23, 59, 59, 999);
      return d.getTime();
    }
    return Number(new Date(s).getTime());
  };
  const end = parseTs(to, true) ?? nowTs;
  const start = parseTs(from, false) ?? (end - (30 * 24 * 3600 * 1000));
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  return { start, end };
}

async function getEventsInRange(userId, start, end, limit = 20000) {
  const r = getRedis();
  const ids = await r.zrangebyscore(eventZKey(userId), start, end, 'LIMIT', 0, Math.max(1, Number(limit) || 20000));
  if (!ids.length) return [];
  const raws = await r.hmget(eventHashKey(userId), ...ids);
  return raws.map(safeJsonParse).filter(Boolean);
}

async function dashboardSummary(userId, from, to) {
  const range = parseRange(from, to);
  if (!range) throw new Error('Rango de fechas inválido');
  const events = await getEventsInRange(userId, range.start, range.end);
  const sent = events.filter((e) => e.type === 'message_sent').length;
  const errors = events.filter((e) => e.type === 'message_error').length;
  const delivered = sent + errors;
  const successRate = delivered > 0 ? Number(((sent * 100) / delivered).toFixed(2)) : 0;

  const r = getRedis();
  const campaigns = await r.zcount(userCampaignsKey(userId), range.start, range.end);

  return {
    from: range.start,
    to: range.end,
    campaigns: Number(campaigns || 0),
    sent,
    errors,
    delivered,
    successRate,
  };
}

function getBucketLabel(ts, bucket) {
  if (bucket === 'hour') return hourKey(ts);
  if (bucket === 'month') return monthKey(ts);
  return dayKey(ts);
}

async function dashboardTimeline(userId, from, to, bucket = 'day') {
  const range = parseRange(from, to);
  if (!range) throw new Error('Rango de fechas inválido');
  const bucketType = ['hour', 'day', 'month'].includes(bucket) ? bucket : 'day';
  const events = await getEventsInRange(userId, range.start, range.end, 50000);
  const map = new Map();

  for (const e of events) {
    if (e.type !== 'message_sent' && e.type !== 'message_error') continue;
    const label = getBucketLabel(e.timestamp, bucketType);
    const row = map.get(label) || { bucket: label, sent: 0, errors: 0 };
    if (e.type === 'message_sent') row.sent += 1;
    if (e.type === 'message_error') row.errors += 1;
    map.set(label, row);
  }

  return Array.from(map.values()).sort((a, b) => a.bucket.localeCompare(b.bucket));
}

async function dashboardByGroup(userId, from, to) {
  const range = parseRange(from, to);
  if (!range) throw new Error('Rango de fechas inválido');
  const events = await getEventsInRange(userId, range.start, range.end, 50000);
  const map = new Map();

  for (const e of events) {
    if (e.type !== 'message_sent' && e.type !== 'message_error') continue;
    const name = String(e.group || 'Sin grupo');
    const row = map.get(name) || { group: name, sent: 0, errors: 0, total: 0 };
    if (e.type === 'message_sent') row.sent += 1;
    if (e.type === 'message_error') row.errors += 1;
    row.total += 1;
    map.set(name, row);
  }

  return Array.from(map.values()).sort((a, b) => b.total - a.total);
}

async function dashboardByContact(userId, from, to, limit = 20) {
  const range = parseRange(from, to);
  if (!range) throw new Error('Rango de fechas inválido');
  const events = await getEventsInRange(userId, range.start, range.end, 50000);
  const map = new Map();

  for (const e of events) {
    if (e.type !== 'message_sent' && e.type !== 'message_error') continue;
    const phone = String(e.phone || '').trim();
    if (!phone) continue;
    const row = map.get(phone) || { phone, sent: 0, errors: 0, total: 0 };
    if (e.type === 'message_sent') row.sent += 1;
    if (e.type === 'message_error') row.errors += 1;
    row.total += 1;
    map.set(phone, row);
  }

  const rows = Array.from(map.values()).sort((a, b) => b.total - a.total).slice(0, Math.max(1, Number(limit) || 20));
  for (const row of rows) {
    const c = await getContactByPhone(userId, row.phone);
    row.nombre = c?.nombre || null;
    row.group = c?.grupo || null;
  }
  return rows;
}

function buildMonthList(months) {
  const total = Math.max(1, Math.min(36, Number(months) || 12));
  const out = [];
  const base = new Date();
  base.setDate(1);
  base.setHours(0, 0, 0, 0);
  for (let i = total - 1; i >= 0; i--) {
    const d = new Date(base);
    d.setMonth(d.getMonth() - i);
    out.push(monthKey(d.getTime()));
  }
  return out;
}

async function dashboardCurrentMonth(userId) {
  const r = getRedis();
  const curMonth = monthKey(now());
  const d = new Date();
  d.setDate(1);
  d.setHours(0, 0, 0, 0);
  d.setMonth(d.getMonth() - 1);
  const prevMonth = monthKey(d.getTime());

  const sent = Number((await r.hget(monthlySentKey(userId), curMonth)) || 0);
  const errors = Number((await r.hget(monthlyErrorKey(userId), curMonth)) || 0);
  const prevSent = Number((await r.hget(monthlySentKey(userId), prevMonth)) || 0);
  const delivered = sent + errors;
  const successRate = delivered > 0 ? Number(((sent * 100) / delivered).toFixed(2)) : 0;
  const delta = sent - prevSent;
  const deltaPct = prevSent > 0 ? Number(((delta * 100) / prevSent).toFixed(2)) : (sent > 0 ? 100 : 0);

  return {
    month: curMonth,
    sent,
    errors,
    delivered,
    successRate,
    previousMonthSent: prevSent,
    deltaSent: delta,
    deltaPercent: deltaPct,
  };
}

async function dashboardMonthly(userId, months = 12) {
  const r = getRedis();
  const keys = buildMonthList(months);
  if (!keys.length) return [];
  const sentVals = await r.hmget(monthlySentKey(userId), ...keys);
  const errVals = await r.hmget(monthlyErrorKey(userId), ...keys);
  return keys.map((m, i) => {
    const sent = Number(sentVals[i] || 0);
    const errors = Number(errVals[i] || 0);
    return { month: m, sent, errors, total: sent + errors };
  });
}

module.exports = {
  upsertContact,
  updateContact,
  deleteContact,
  listContacts,
  getContactById,
  getContactGroups,
  getContactsByIds,
  getContactsByGroup,
  importContactsFromEntries,
  createCampaign,
  initCampaignRecipients,
  setCampaignStatus,
  recordRecipientStatus,
  getCampaignDetail,
  dashboardSummary,
  dashboardTimeline,
  dashboardByGroup,
  dashboardByContact,
  dashboardCurrentMonth,
  dashboardMonthly,
  addMetricEvent,
};
