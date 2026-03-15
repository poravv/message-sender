// src/firebaseAdmin.js
const admin = require('firebase-admin');
const logger = require('./logger');

/**
 * Initialize Firebase Admin SDK.
 *
 * Supports two modes:
 *   1. FIREBASE_SERVICE_ACCOUNT  — base64-encoded JSON service-account key
 *   2. GOOGLE_APPLICATION_CREDENTIALS — file path (standard Firebase/GCP env var)
 *
 * If neither is set AND we're in development mode, Firebase is skipped entirely
 * (exports null db/auth so the app can still start).
 *
 * In production without credentials the SDK falls back to Application Default
 * Credentials (works inside GCP or when `gcloud auth application-default login`
 * has been run).
 */

let db = null;
let auth = null;
let firebaseAvailable = false;

function initFirebase() {
  if (admin.apps.length) {
    // Already initialized — return existing app's services
    return true;
  }

  const base64Key = process.env.FIREBASE_SERVICE_ACCOUNT;
  const hasCredentials = base64Key || process.env.GOOGLE_APPLICATION_CREDENTIALS;

  // In development without any credentials, skip Firebase entirely
  if (!hasCredentials && process.env.NODE_ENV !== 'production') {
    logger.warn(
      'No Firebase credentials found (FIREBASE_SERVICE_ACCOUNT / GOOGLE_APPLICATION_CREDENTIALS). ' +
      'Firebase services disabled — running in dev mode without Firestore/Auth.'
    );
    return false;
  }

  if (base64Key) {
    try {
      const serviceAccount = JSON.parse(
        Buffer.from(base64Key, 'base64').toString('utf8')
      );
      admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
      });
      logger.info(
        { projectId: serviceAccount.project_id },
        'Firebase Admin initialized from FIREBASE_SERVICE_ACCOUNT'
      );
      return true;
    } catch (err) {
      logger.error(
        { err: err.message },
        'Failed to parse FIREBASE_SERVICE_ACCOUNT — check base64 encoding'
      );
      if (process.env.NODE_ENV === 'production') throw err;
      return false;
    }
  } else if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    try {
      admin.initializeApp({
        credential: admin.credential.applicationDefault(),
      });
      logger.info(
        { credPath: process.env.GOOGLE_APPLICATION_CREDENTIALS },
        'Firebase Admin initialized from GOOGLE_APPLICATION_CREDENTIALS file'
      );
      return true;
    } catch (err) {
      logger.error({ err: err.message }, 'Failed to init Firebase from GOOGLE_APPLICATION_CREDENTIALS');
      if (process.env.NODE_ENV === 'production') throw err;
      return false;
    }
  } else {
    // Production fallback: Application Default Credentials (GCP environments)
    try {
      admin.initializeApp();
      logger.info('Firebase Admin initialized with application-default credentials');
      return true;
    } catch (err) {
      logger.error({ err: err.message }, 'Failed to init Firebase with default credentials');
      throw err;
    }
  }
}

try {
  firebaseAvailable = initFirebase();
  if (firebaseAvailable) {
    db = admin.firestore();
    auth = admin.auth();
  }
} catch (err) {
  logger.error({ err: err.message }, 'Firebase initialization failed');
  // In non-production, swallow the error so the app can start
  if (process.env.NODE_ENV === 'production') {
    throw err;
  }
}

module.exports = { admin, db, auth, firebaseAvailable };
