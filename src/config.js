const path = require('path');
const fs = require('fs');

const ROOT = __dirname.replace(/\/src$/, '');
const tempDir = path.join(ROOT, 'temp');
const uploadsDir = path.join(ROOT, 'uploads');
const publicDir = path.join(ROOT, 'public');

[ tempDir, uploadsDir, publicDir ].forEach(dir => !fs.existsSync(dir) && fs.mkdirSync(dir, { recursive: true }));

const retentionHours = Number(process.env.FILE_RETENTION_HOURS || 24);

const messageDelay = Number(process.env.MESSAGE_DELAY_MS || 600);

const authorizedPhoneNumbers = process.env.AUTHORIZED_PHONES
  ? process.env.AUTHORIZED_PHONES.split(',').map(p => p.trim())
  : ['595992756462'];

const isAuthorizedPhone = (phoneNumber) => {
  const normalized = String(phoneNumber).replace(/[\s\-\+]/g, '');
  return authorizedPhoneNumbers.some(p => normalized === p);
};

module.exports = {
  ROOT, tempDir, uploadsDir, publicDir,
  retentionHours,
  messageDelay,
  authorizedPhoneNumbers,
  isAuthorizedPhone
};