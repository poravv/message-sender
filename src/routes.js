const fs = require('fs');
const path = require('path');
const express = require('express');
const { upload } = require('./media');
const { cleanupOldFiles, loadNumbersFromCSV } = require('./utils');
const { publicDir, retentionHours } = require('./config');
const logger = require('./logger');
const { checkJwt, requireRole } = require('./auth');

function buildRoutes(whatsappManager) {
  const router = express.Router();

  router.get('/connection-status', (req, res) => {
    const s = whatsappManager.getState();
    const resp = {
      status: s.connectionState,
      isReady: s.isReady,
      lastActivity: s.lastActivity,
      lastActivityAgo: Math.round((Date.now() - s.lastActivity) / 1000),
      hasQR: !!s.qrCode,
      connectionState: s.connectionState
    };
    if (s.isReady && whatsappManager.client?.info) {
      resp.userInfo = {
        phoneNumber: whatsappManager.client.info.wid.user,
        pushname: whatsappManager.client.info.pushname || 'Usuario de WhatsApp'
      };
    }
    res.json(resp);
  });

  router.post('/send-messages', checkJwt, requireRole('sender_api'), upload.fields([
    { name: 'csvFile', maxCount: 1 },
    { name: 'images', maxCount: 10 },
    { name: 'singleImage', maxCount: 1 },
    { name: 'audioFile', maxCount: 1 }
  ]), async (req, res) => {
    try {
      if (!whatsappManager.isReady) {
        return res.status(400).json({ error: 'El cliente de WhatsApp no está listo. Escaneá el QR primero.' });
      }
      if (!req.files || !req.files['csvFile']) {
        return res.status(400).json({ error: 'Archivo CSV no proporcionado' });
      }

      const csvFilePath = req.files['csvFile'][0].path;
      const images = req.files['images'];
      const singleImage = req.files['singleImage'] ? req.files['singleImage'][0] : null;
      const audioFile = req.files['audioFile'] ? req.files['audioFile'][0] : null;
      const { message } = req.body;

      const numbers = await loadNumbersFromCSV(csvFilePath);
      if (numbers.length === 0) return res.status(400).json({ error: 'No se encontraron números válidos' });

      whatsappManager.updateActivity();
      await whatsappManager.messageQueue.add(numbers, message, images, singleImage, audioFile);

      res.json({ status: 'success', message: 'Procesando mensajes', totalNumbers: numbers.length, initialStats: whatsappManager.messageQueue.getStats() });
    } catch (error) {
      logger.error({ err: error?.message }, 'Error en /send-messages');
      res.status(500).json({ error: error.message });
    } finally {
      if (req.files) {
        Object.entries(req.files).forEach(([fieldName, files]) => {
          if (fieldName !== 'audioFile') {
            for (const f of files) { try { fs.existsSync(f.path) && fs.unlinkSync(f.path); } catch { } }
          }
        });
      }
    }
  });

  router.get('/message-status', checkJwt, requireRole('sender_api'), (req, res) => {
    if (!whatsappManager.messageQueue) return res.json({ total: 0, sent: 0, errors: 0, messages: [], completed: true });
    res.json(whatsappManager.messageQueue.getStats());
  });

  router.get('/qr', (req, res) => {
    const qrPath = path.join(publicDir, 'qr.png');
    if (fs.existsSync(qrPath)) res.sendFile(qrPath);
    else res.status(404).json({ error: 'QR no disponible' });
  });

  router.post('/refresh-qr', async (req, res) => {
    try {
      if (whatsappManager.isReady) {
        return res.status(400).json({ success: false, message: 'No se puede actualizar el QR si ya estás conectado' });
      }

      // Activa la compuerta
      whatsappManager.requestQrCapture();

      // Si ya hay un QR en memoria, lo escribimos YA (no esperamos a un nuevo evento)
      const wrote = await whatsappManager.captureQrToDisk();

      if (wrote) {
        return res.json({ success: true, message: 'QR actualizado' });
      }

      // Plan B: si aún no tenemos QR en memoria, pedimos regeneración (tu método existente)
      const ok = await whatsappManager.refreshQR?.();
      if (ok) {
        return res.json({ success: true, message: 'Solicitando nuevo código QR...' });
      }

      return res.status(400).json({ success: false, message: 'No se pudo refrescar el QR en este momento' });
    } catch (e) {
      logger.error({ err: e?.message }, 'Error en refresh-qr');
      res.status(500).json({ success: false, message: e.message || 'Error al refrescar QR' });
    }
  });

  router.post('/cleanup', (req, res) => {
    cleanupOldFiles(retentionHours);
    res.json({ ok: true });
  });

  return router;
}

module.exports = { buildRoutes };