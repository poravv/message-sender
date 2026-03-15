const fs = require('fs');
const path = require('path');
const { uploadsDir, tempDir } = require('./config');
const logger = require('./logger');
const { normalizeNumber } = require('./phoneValidator');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function isIgnorableSerializeError(err) {
  const msg = String(err?.message || err || '');
  return msg.includes('serialize') || msg.includes('getMessageModel');
}

async function safeSend(client, jid, payload, options) {
  try {
    return await client.sendMessage(jid, payload, options);
  } catch (err) {
    if (isIgnorableSerializeError(err)) {
      logger.warn({ jid, err: err?.message }, 'Ignorando error interno "serialize"');
      return { _ignoredSerialize: true };
    }
    throw err;
  }
}

function cleanupDirectory(directory, maxAgeMs, now) {
  try {
    if (!fs.existsSync(directory)) return;
    let deleted = 0;
    for (const file of fs.readdirSync(directory)) {
      const filePath = path.join(directory, file);
      try {
        if (fs.statSync(filePath).isDirectory()) continue;
        const age = now - fs.statSync(filePath).mtimeMs;
        if (age > maxAgeMs) {
          fs.unlinkSync(filePath);
          deleted++;
        }
      } catch (e) {
        logger.error({ filePath, err: e?.message }, 'Error al eliminar archivo');
      }
    }
    if (deleted > 0) {
      logger.info({ directory: path.basename(directory), deleted }, 'Limpieza completada');
    }
  } catch (e) {
    logger.error({ directory, err: e?.message }, 'Error al limpiar directorio');
  }
}

function cleanupOldFiles(maxAgeHours = 24) {
  const maxAgeMs = maxAgeHours * 3600 * 1000;
  const now = Date.now();
  logger.info({ maxAgeHours }, 'Iniciando limpieza de archivos antiguos');
  cleanupDirectory(uploadsDir, maxAgeMs, now);
  cleanupDirectory(tempDir, maxAgeMs, now);
}

/**
 * Normaliza un número de teléfono paraguayo al formato 595XXXXXXXXX (12 dígitos).
 * Backwards-compatible wrapper around normalizeNumber().
 * @param {string|number} rawNumber
 * @returns {string|null} Normalized number or null if invalid
 */
function normalizeParaguayanNumber(rawNumber) {
  if (!rawNumber) return null;
  const result = normalizeNumber(rawNumber, 'PY');
  return result.valid ? result.normalized : null;
}

function loadNumbersFromCSV(filePath, countryCode) {
  const cc = countryCode || 'PY';
  const ext = path.extname(filePath).toLowerCase();

  const aliases = {
    number: ['numero', 'número', 'phone', 'telefono', 'tel', 'number', 'celular', 'whatsapp'],
    tratamiento: ['tratamiento', 'sustantivo', 'titulo', 'title'],
    nombre: ['nombre', 'name', 'cliente', 'contacto'],
    grupo: ['grupo', 'segmento', 'group', 'categoria', 'categoría'],
  };

  const normalizeHeader = (v) => String(v || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');

  const looksLikeHeader = (values) => {
    const first = normalizeHeader(values[0] || '');
    const second = normalizeHeader(values[1] || '');
    const hasKnown = aliases.number.includes(first) || aliases.nombre.includes(first) || aliases.tratamiento.includes(first) || aliases.grupo.includes(first);
    const hasNonNumberWord = first && !/^\+?\d+$/.test(first);
    return hasKnown || (hasNonNumberWord && (aliases.nombre.includes(second) || aliases.tratamiento.includes(second) || aliases.grupo.includes(second)));
  };

  const buildHeaderMap = (values) => {
    const map = {};
    const normalized = values.map(normalizeHeader);
    normalized.forEach((name, idx) => {
      if (!name) return;
      if (aliases.number.includes(name)) map.number = idx;
      if (aliases.tratamiento.includes(name)) map.tratamiento = idx;
      if (aliases.nombre.includes(name)) map.nombre = idx;
      if (aliases.grupo.includes(name)) map.grupo = idx;
    });
    return map;
  };

  const mapValuesToFields = (values, headerMap) => {
    const clean = values.map(v => String(v || '').trim());
    if (headerMap && Object.keys(headerMap).length > 0) {
      return {
        rawNumber: clean[headerMap.number ?? 0],
        tratamiento: clean[headerMap.tratamiento ?? -1] || '',
        nombre: clean[headerMap.nombre ?? -1] || '',
        grupo: clean[headerMap.grupo ?? -1] || '',
      };
    }
    return {
      rawNumber: clean[0] || '',
      tratamiento: clean[1] || '',
      nombre: clean[2] || '',
      grupo: clean[3] || '',
    };
  };

  const buildEntry = (line, values, numbers, invalidRef, seenNumbers, headerCtx) => {
    if (line === 1 && looksLikeHeader(values)) {
      headerCtx.map = buildHeaderMap(values);
      headerCtx.hasHeader = true;
      logger.info({ line, headerMap: headerCtx.map }, 'Cabecera CSV detectada');
      return;
    }

    const { rawNumber, tratamiento, nombre, grupo } = mapValuesToFields(values, headerCtx.hasHeader ? headerCtx.map : null);

    const result = normalizeNumber(rawNumber, cc);
    const normalized = result.valid ? result.normalized : null;
    if (normalized) {
      if (seenNumbers.has(normalized)) {
        logger.warn({ line, number: rawNumber, normalized, reason: 'duplicate' }, 'Número duplicado, omitiendo');
        invalidRef.duplicates++;
        return;
      }

      seenNumbers.add(normalized);

      const entry = { number: normalized, index: line, variables: {} };
      if (tratamiento) entry.variables.tratamiento = tratamiento;
      if (nombre) entry.variables.nombre = nombre;
      if (grupo) entry.variables.grupo = grupo;
      if (grupo) entry.group = grupo;
      numbers.push(entry);

      const variablesInfo = Object.keys(entry.variables).length > 0 ? entry.variables : 'sin variables';
      const wasNormalized = rawNumber !== normalized;
      logger.info({
        line,
        original: wasNormalized ? rawNumber : undefined,
        number: normalized,
        variables: variablesInfo,
        totalColumns: values.length,
      }, 'Número procesado' + (wasNormalized ? ' (normalizado)' : ''));
    } else {
      logger.warn({ line, number: rawNumber, reason: 'invalid_format' }, 'Número inválido');
      invalidRef.count++;
    }
  };

  return new Promise((resolve, reject) => {
    const numbers = [];
    const invalidRef = { count: 0, duplicates: 0 };
    const seenNumbers = new Set();
    const headerCtx = { hasHeader: false, map: null };
    let line = 0;

    if (ext === '.txt') {
      try {
        const content = fs.readFileSync(filePath, 'utf8');
        const lines = content.split(/\r?\n/);
        for (const rawLine of lines) {
          if (!rawLine || !rawLine.trim()) continue;
          line++;
          const parts = rawLine.split(',').map(s => s.trim());
          buildEntry(line, parts, numbers, invalidRef, seenNumbers, headerCtx);
        }
        if (numbers.length === 0) return reject(new Error('El archivo TXT no contiene números válidos.'));
        const summary = numbers.reduce((acc, entry) => {
          const hasVars = Object.keys(entry.variables).length > 0;
          acc[hasVars ? 'withVariables' : 'withoutVariables']++;
          return acc;
        }, { withVariables: 0, withoutVariables: 0 });
        logger.info({
          total: numbers.length,
          invalid: invalidRef.count,
          duplicates: invalidRef.duplicates,
          unique: numbers.length,
          ...summary,
        }, 'Resumen de procesamiento TXT');
        const sorted = numbers.sort((a, b) => a.index - b.index);
        resolve({ numbers: sorted, invalidCount: invalidRef.count, duplicates: invalidRef.duplicates, totalRows: line, hasHeader: headerCtx.hasHeader });
      } catch (err) {
        logger.error({ err: err?.message }, 'Error leyendo TXT');
        reject(err);
      }
      return;
    }

    const csv = require('csv-parser');
    fs.createReadStream(filePath)
      .pipe(csv({ skipLines: 0, headers: false }))
      .on('data', (row) => {
        line++;
        const values = Object.values(row);
        buildEntry(line, values, numbers, invalidRef, seenNumbers, headerCtx);
      })
      .on('end', () => {
        if (numbers.length === 0) return reject(new Error('El archivo CSV no contiene números válidos.'));
        const summary = numbers.reduce((acc, entry) => {
          const hasVars = Object.keys(entry.variables).length > 0;
          acc[hasVars ? 'withVariables' : 'withoutVariables']++;
          return acc;
        }, { withVariables: 0, withoutVariables: 0 });
        logger.info({
          total: numbers.length,
          invalid: invalidRef.count,
          duplicates: invalidRef.duplicates,
          unique: numbers.length,
          hasHeader: headerCtx.hasHeader,
          ...summary,
        }, 'Resumen de procesamiento CSV');
        const sorted = numbers.sort((a, b) => a.index - b.index);
        resolve({ numbers: sorted, invalidCount: invalidRef.count, duplicates: invalidRef.duplicates, totalRows: line, hasHeader: headerCtx.hasHeader });
      })
      .on('error', (err) => {
        logger.error({ err: err?.message }, 'Error leyendo CSV');
        reject(err);
      });
  });
}

module.exports = {
  sleep,
  cleanupOldFiles,
  isIgnorableSerializeError,
  safeSend,
  loadNumbersFromCSV,
  normalizeParaguayanNumber
};
