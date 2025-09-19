const crypto = require('crypto');
let S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand;

try {
  ({ S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3'));
} catch (e) {
  // sdk no instalado; el módulo seguirá deshabilitado
}

function bool(v, def = false) {
  if (v === undefined || v === null || v === '') return def;
  return String(v).toLowerCase() === 'true' || String(v) === '1';
}

function env(...names) {
  for (const n of names) {
    if (process.env[n] !== undefined && process.env[n] !== '') return process.env[n];
  }
  return undefined;
}

function ensureScheme(hostOrUrl) {
  if (!hostOrUrl) return hostOrUrl;
  if (/^https?:\/\//i.test(hostOrUrl)) return hostOrUrl;
  const secure = bool(env('S3_SECURE', 'MINIO_SECURE'), true);
  return `${secure ? 'https' : 'http'}://${hostOrUrl}`;
}

function isEnabled() {
  const hasS3 = env('S3_ENABLED') || env('S3_BUCKET');
  const hasMinio = env('MINIO_BUCKET') || env('MINIO_ENDPOINT');
  return !!(S3Client && (hasS3 || hasMinio));
}

function shouldDeleteAfterSend() {
  return bool(env('S3_DELETE_AFTER_SEND', 'MINIO_DELETE_AFTER_SEND'), false);
}

function getBucket() {
  return env('S3_BUCKET', 'MINIO_BUCKET');
}

function getClient() {
  if (!isEnabled()) throw new Error('Object storage not configured');
  const cfg = {
    region: env('S3_REGION', 'MINIO_REGION') || 'us-east-1',
    credentials: {
      accessKeyId: env('S3_ACCESS_KEY_ID', 'AWS_ACCESS_KEY_ID', 'MINIO_ACCESS_KEY') || '',
      secretAccessKey: env('S3_SECRET_ACCESS_KEY', 'AWS_SECRET_ACCESS_KEY', 'MINIO_SECRET_KEY') || ''
    },
  };
  const endpoint = env('S3_ENDPOINT', 'MINIO_ENDPOINT');
  if (endpoint) cfg.endpoint = ensureScheme(endpoint);
  const forcePath = env('S3_FORCE_PATH_STYLE', 'MINIO_FORCE_PATH_STYLE');
  // Por defecto true en MinIO si no se especifica
  cfg.forcePathStyle = bool(forcePath, !!env('MINIO_ENDPOINT'));
  return new S3Client(cfg);
}

function sanitizeName(name) {
  return String(name || '').replace(/[^\w.\-]/g, '_');
}

function buildKey(userId, originalname) {
  const ts = Date.now();
  const rnd = crypto.randomBytes(6).toString('hex');
  const base = sanitizeName(originalname);
  const uid = sanitizeName(userId || 'default');
  return `uploads/${uid}/${ts}-${rnd}-${base}`;
}

async function putObjectFromBuffer(key, buffer, contentType) {
  const client = getClient();
  const Bucket = getBucket();
  const params = { Bucket, Key: key, Body: buffer };
  if (contentType) params.ContentType = contentType;
  await client.send(new PutObjectCommand(params));
  return { bucket: Bucket, key };
}

const fs = require('fs');
const path = require('path');

async function putObjectFromPath(key, filePath, contentType) {
  const buf = fs.readFileSync(filePath);
  return putObjectFromBuffer(key, buf, contentType);
}

async function getObjectBuffer(key) {
  const client = getClient();
  const Bucket = getBucket();
  const res = await client.send(new GetObjectCommand({ Bucket, Key: key }));
  const stream = res.Body;
  // stream to buffer
  const chunks = [];
  return await new Promise((resolve, reject) => {
    stream.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}

async function deleteObject(key) {
  try {
    const client = getClient();
    const Bucket = getBucket();
    await client.send(new DeleteObjectCommand({ Bucket, Key: key }));
    return true;
  } catch {
    return false;
  }
}

function publicUrlForKey(key) {
  // 1) MINIO_EXTERNAL_ENDPOINT si existe
  const external = env('S3_PUBLIC_URL', 'MINIO_EXTERNAL_ENDPOINT');
  const endpoint = env('S3_ENDPOINT', 'MINIO_ENDPOINT');
  const bucket = getBucket();
  if (external) return `${ensureScheme(external).replace(/\/$/, '')}/${key}`;
  if (endpoint) {
    // path-style para compatibilidad amplia
    return `${ensureScheme(endpoint).replace(/\/$/, '')}/${bucket}/${key}`;
  }
  // 2) AWS por defecto
  const region = env('S3_REGION', 'MINIO_REGION') || 'us-east-1';
  return `https://${bucket}.s3.${region}.amazonaws.com/${key}`;
}

module.exports = {
  isEnabled,
  shouldDeleteAfterSend,
  buildKey,
  putObjectFromBuffer,
  putObjectFromPath,
  getObjectBuffer,
  deleteObject,
  publicUrlForKey,
};
