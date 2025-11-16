const fs = require('fs');
const path = require('path');
const { uploadsDir, tempDir } = require('./config');
const logger = require('./logger');

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
 * Normaliza un número de teléfono paraguayo al formato 595XXXXXXXXX (12 dígitos)
 * Formatos aceptados:
 * - 595992756462 (ya normalizado)
 * - 992756462 (sin código de país)
 * - +595992756462 (con +)
 * - 0992756462 (con 0 inicial)
 * - 595 992756462 (con espacios)
 */
function normalizeParaguayanNumber(rawNumber) {
  if (!rawNumber) return null;
  
  // Convertir a string y limpiar espacios, guiones, paréntesis
  let cleaned = String(rawNumber)
    .trim()
    .replace(/[\s\-\(\)]/g, '');
  
  // Remover el símbolo + si existe
  if (cleaned.startsWith('+')) {
    cleaned = cleaned.substring(1);
  }
  
  // Si empieza con 0, quitarlo (formato local: 0992756462 → 992756462)
  if (cleaned.startsWith('0') && cleaned.length === 10) {
    cleaned = cleaned.substring(1);
  }
  
  // Si tiene 9 dígitos, agregar prefijo 595 (formato local sin 0: 992756462 → 595992756462)
  if (cleaned.length === 9 && /^\d{9}$/.test(cleaned)) {
    cleaned = '595' + cleaned;
  }
  
  // Validar formato final: debe ser exactamente 12 dígitos comenzando con 595
  if (cleaned.length === 12 && /^\d{12}$/.test(cleaned) && cleaned.startsWith('595')) {
    return cleaned;
  }
  
  // Si no cumple las condiciones, retornar null (número inválido)
  return null;
}

function loadNumbersFromCSV(filePath) {
  const ext = path.extname(filePath).toLowerCase();

  const buildEntry = (line, values, numbers, invalidRef, seenNumbers) => {
    const rawNumber = String(values[0] || '').trim();
    
    // Normalizar el número
    const normalized = normalizeParaguayanNumber(rawNumber);
    
    if (normalized) {
      // Verificar duplicados
      if (seenNumbers.has(normalized)) {
        logger.warn({ line, number: rawNumber, normalized, reason: 'duplicate' }, 'Número duplicado, omitiendo');
        invalidRef.duplicates++;
        return;
      }
      
      seenNumbers.add(normalized);
      
      const entry = { number: normalized, index: line, variables: {} };
      if (values.length > 1) {
        const sustantivo = String(values[1] || '').trim();
        if (sustantivo) entry.variables.sustantivo = sustantivo;
      }
      if (values.length > 2) {
        const nombre = String(values[2] || '').trim();
        if (nombre) entry.variables.nombre = nombre;
      }
      numbers.push(entry);
      const variablesInfo = Object.keys(entry.variables).length > 0 ? entry.variables : 'sin variables';
      const wasNormalized = rawNumber !== normalized;
      logger.info({ 
        line, 
        original: wasNormalized ? rawNumber : undefined,
        number: normalized, 
        variables: variablesInfo, 
        totalColumns: values.length 
      }, 'Número procesado' + (wasNormalized ? ' (normalizado)' : ''));
    } else {
      logger.warn({ line, number: rawNumber, reason: 'invalid_format' }, 'Número inválido');
      invalidRef.count++;
    }
  };

  return new Promise((resolve, reject) => {
    const numbers = [];
    const invalidRef = { count: 0, duplicates: 0 };
    const seenNumbers = new Set(); // Para detectar duplicados
    let line = 0;

    if (ext === '.txt') {
      try {
        const content = fs.readFileSync(filePath, 'utf8');
        const lines = content.split(/\r?\n/);
        for (const rawLine of lines) {
          if (!rawLine || !rawLine.trim()) continue;
          line++;
          const parts = rawLine.split(',').map(s => s.trim());
          buildEntry(line, parts, numbers, invalidRef, seenNumbers);
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
          ...summary 
        }, 'Resumen de procesamiento TXT');
        const sorted = numbers.sort((a,b)=>a.index-b.index);
        resolve({ numbers: sorted, invalidCount: invalidRef.count, duplicates: invalidRef.duplicates, totalRows: line });
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
        buildEntry(line, values, numbers, invalidRef, seenNumbers);
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
          ...summary 
        }, 'Resumen de procesamiento CSV');
        const sorted = numbers.sort((a,b)=>a.index-b.index);
        resolve({ numbers: sorted, invalidCount: invalidRef.count, duplicates: invalidRef.duplicates, totalRows: line });
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
