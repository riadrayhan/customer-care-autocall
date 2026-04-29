/**
 * pushService.js — FCM push wake-up
 * --------------------------------------
 * When a user is offline (socket not connected), send a high-priority
 * data-only FCM message so the phone wakes up and rings via CallKit.
 *
 * Setup (one-time):
 *   1. Firebase console → Project Settings → Service accounts → Generate new private key
 *   2. Save JSON as `data/firebase-service-account.json`
 *      OR set env FIREBASE_SERVICE_ACCOUNT_JSON to the full JSON string
 *      OR set env GOOGLE_APPLICATION_CREDENTIALS to the file path
 *   3. Restart the server.
 *
 * If credentials are missing the service runs in NO-OP mode (logs a warning
 * and silently skips push). Calls to online-via-socket users still work.
 */
const path  = require('path');
const fs    = require('fs');
const logger = require('../utils/logger');

let admin = null;
let initialized = false;
let enabled = false;

function _loadCredentials() {
  // Option A: env var with full JSON
  if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    try { return JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON); }
    catch (e) { logger.error('FIREBASE_SERVICE_ACCOUNT_JSON invalid', { error: e.message }); return null; }
  }
  // Option B: file path
  const filePath = process.env.GOOGLE_APPLICATION_CREDENTIALS
    || path.join(__dirname, '..', '..', 'data', 'firebase-service-account.json');
  if (fs.existsSync(filePath)) {
    try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); }
    catch (e) { logger.error('Service account file invalid', { error: e.message }); return null; }
  }
  return null;
}

function init() {
  if (initialized) return;
  initialized = true;

  const cred = _loadCredentials();
  if (!cred) {
    logger.warn('FCM: no Firebase credentials found — push wake-up DISABLED. ' +
                'Set FIREBASE_SERVICE_ACCOUNT_JSON env or place data/firebase-service-account.json');
    return;
  }

  try {
    admin = require('firebase-admin');
    if (!admin.apps.length) {
      admin.initializeApp({ credential: admin.credential.cert(cred) });
    }
    enabled = true;
    logger.info('FCM initialized', { project: cred.project_id });
  } catch (e) {
    logger.error('firebase-admin require failed — run npm install', { error: e.message });
  }
}

/**
 * Send a high-priority data-only push to wake the device.
 * @param {string|string[]} tokens — single device token or array
 * @param {object} payload — fields you want in the data-only message
 */
async function sendIncomingCallPush(tokens, payload) {
  if (!enabled) return { ok: false, reason: 'disabled' };

  const targets = Array.isArray(tokens) ? tokens : [tokens];
  if (targets.length === 0) return { ok: false, reason: 'no_tokens' };

  // Convert all values to strings (FCM data payload requirement)
  const data = {};
  for (const [k, v] of Object.entries(payload)) {
    data[k] = (v == null) ? '' : String(v);
  }
  data.type = 'incoming_call';

  const message = {
    tokens: targets,
    data,
    android: {
      priority: 'high',
      ttl: 30_000, // 30s — match ring timeout
    },
    apns: {
      headers: { 'apns-priority': '10', 'apns-push-type': 'voip' },
      payload: { aps: { 'content-available': 1 } },
    },
  };

  try {
    const res = await admin.messaging().sendEachForMulticast(message);
    logger.info('FCM call push sent', { success: res.successCount, failure: res.failureCount });
    if (res.failureCount > 0) {
      res.responses.forEach((r, i) => {
        if (!r.success) logger.warn('FCM token failed', { token: targets[i].slice(0, 12), error: r.error?.message });
      });
    }
    return { ok: true, successCount: res.successCount, failureCount: res.failureCount };
  } catch (e) {
    logger.error('FCM send error', { error: e.message });
    return { ok: false, reason: e.message };
  }
}

module.exports = { init, sendIncomingCallPush, isEnabled: () => enabled };
