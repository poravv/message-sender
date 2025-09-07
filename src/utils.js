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

function loadNumbersFromCSV(filePath) {
  const csv = require('csv-parser');
  return new Promise((resolve, reject) => {
    const numbers = [];
    let line = 0;
    fs.createReadStream(filePath)
      .pipe(csv({ skipLines: 0, headers: false }))
      .on('data', (row) => {
        line++;
        const values = Object.values(row);
        const number = String(values[0] || '').trim();
        
        if (number && /^\d+$/.test(number)) {
          const entry = {
            number,
            index: line,
            variables: {} // Para almacenar las variables adicionales
          };
          
          // Procesar columnas adicionales para variables
          if (values.length > 1) {
            const sustantivo = String(values[1] || '').trim();
            if (sustantivo) {
              entry.variables.sustantivo = sustantivo;
            }
          }
          
          if (values.length > 2) {
            const nombre = String(values[2] || '').trim();
            if (nombre) {
              entry.variables.nombre = nombre;
            }
          }
          
          numbers.push(entry);
          
          // Log más detallado para debugging
          const variablesInfo = Object.keys(entry.variables).length > 0 
            ? entry.variables 
            : 'sin variables';
          logger.info({ 
            line, 
            number, 
            variables: variablesInfo,
            totalColumns: values.length
          }, 'Número procesado');
          
        } else {
          logger.warn({ line, number, values }, 'Número inválido en CSV');
        }
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
          ...summary
        }, 'Resumen de procesamiento CSV');
        
        resolve(numbers.sort((a,b)=>a.index-b.index));
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
  loadNumbersFromCSV
};