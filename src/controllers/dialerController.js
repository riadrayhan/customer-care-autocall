/**
 * dialerController
 * ────────────────────────────────────────────────────────────────────────────
 * REST API for managing SIM-based outbound calls (real cellular calls placed
 * by an Android phone with a SIM, controlled remotely by this server).
 *
 * Auth: protected by authMiddleware in server.js (same as /api/calls).
 */
const express       = require('express');
const dialerManager = require('../services/dialerManager');
const userStore     = require('../utils/userStore');
const logger        = require('../utils/logger');

const router = express.Router();

let _io = null;
const injectIo = io => { _io = io; };

// ── Per-admin rate limit (sliding window) ─────────────────────────────────────
const DIAL_RATE_LIMIT  = Number(process.env.SIM_DIAL_RATE_LIMIT  || 60);   // dials
const DIAL_RATE_WINDOW = Number(process.env.SIM_DIAL_RATE_WINDOW || 60_000); // ms
const _adminDialTimes = new Map();

function rateLimitOk(adminId, n = 1) {
  const now = Date.now();
  const arr = (_adminDialTimes.get(adminId) || []).filter(t => now - t < DIAL_RATE_WINDOW);
  if (arr.length + n > DIAL_RATE_LIMIT) {
    _adminDialTimes.set(adminId, arr);
    return false;
  }
  for (let i = 0; i < n; i++) arr.push(now);
  _adminDialTimes.set(adminId, arr);
  return true;
}

// Very loose normalization — strip whitespace / dashes / parentheses.
// We let the phone OS do the real validation.
function normalizePhone(input) {
  if (!input) return null;
  const cleaned = String(input).replace(/[\s\-()]/g, '').trim();
  if (!/^\+?\d{4,16}$/.test(cleaned)) return null;
  return cleaned;
}

// ── Routes ────────────────────────────────────────────────────────────────────

/**
 * POST /api/sim-calls/dispatch
 * Body: { phoneNumber | userId, message?, dialerId? }
 * Sends one number to a connected dialer phone (round-robin if no dialerId).
 */
router.post('/dispatch', (req, res) => {
  const { phoneNumber, userId, message, dialerId } = req.body || {};
  if (!rateLimitOk(req.admin.id))
    return res.status(429).json({ error: `Rate limit: max ${DIAL_RATE_LIMIT} dials/min` });

  let phone = normalizePhone(phoneNumber);
  let resolvedUserId = userId || null;
  if (!phone && userId) {
    const u = userStore.getById(userId);
    if (!u) return res.status(404).json({ error: 'User not found' });
    phone = normalizePhone(u.phone || u.phoneNumber || u.mobile);
  }
  if (!phone) return res.status(400).json({ error: 'Valid phoneNumber required' });

  if (dialerManager.getStats().dialersOnline === 0) {
    // Still allow queueing — call will go out when a dialer connects.
    logger.warn('No dialer online — job will be queued');
  }

  const job = dialerManager.dispatch({
    phoneNumber   : phone,
    userId        : resolvedUserId,
    adminId       : req.admin.id,
    message       : message || null,
    targetDialerId: dialerId || null,
  });
  res.json({ ok: true, jobId: job.jobId, state: job.state });
});

/**
 * POST /api/sim-calls/bulk
 * Body: { phoneNumbers?: string[], userIds?: string[], message?, dialerId? }
 * Queue many numbers — dialers will consume them as they go idle.
 */
router.post('/bulk', (req, res) => {
  const { phoneNumbers, userIds, message, dialerId } = req.body || {};

  const phones = [];
  if (Array.isArray(phoneNumbers)) {
    for (const p of phoneNumbers) {
      const norm = normalizePhone(p);
      if (norm) phones.push({ phone: norm, userId: null });
    }
  }
  if (Array.isArray(userIds)) {
    for (const id of userIds) {
      const u = userStore.getById(id);
      if (!u) continue;
      const norm = normalizePhone(u.phone || u.phoneNumber || u.mobile);
      if (norm) phones.push({ phone: norm, userId: id });
    }
  }
  if (phones.length === 0)
    return res.status(400).json({ error: 'phoneNumbers[] or userIds[] required (with valid phones)' });

  if (!rateLimitOk(req.admin.id, phones.length))
    return res.status(429).json({ error: `Rate limit would be exceeded (max ${DIAL_RATE_LIMIT}/min)` });

  const jobs = phones.map(({ phone, userId }) => dialerManager.dispatch({
    phoneNumber: phone,
    userId,
    adminId    : req.admin.id,
    message    : message || null,
    targetDialerId: dialerId || null,
  }));
  logger.info('Bulk SIM-dial dispatched', { count: jobs.length, by: req.admin.username });
  res.json({ ok: true, count: jobs.length, jobs: jobs.map(j => ({ jobId: j.jobId, phone: j.phoneNumber })) });
});

/**
 * POST /api/sim-calls/:jobId/cancel
 */
router.post('/:jobId/cancel', (req, res) => {
  const job = dialerManager.cancelJob(req.params.jobId, req.body?.reason || 'cancelled');
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json({ ok: true, job });
});

/** GET /api/sim-calls/dialers — list connected dialer phones */
router.get('/dialers', (_req, res) => {
  res.json({ dialers: dialerManager.listDialers(), stats: dialerManager.getStats() });
});

/** GET /api/sim-calls/queue */
router.get('/queue', (_req, res) => {
  res.json({ queue: dialerManager.listQueue(), active: dialerManager.listActive() });
});

/** GET /api/sim-calls/history?limit=&dialerId=&state= */
router.get('/history', (req, res) => {
  const { limit, dialerId, state } = req.query;
  res.json(dialerManager.listHistory({ limit, dialerId, state }));
});

module.exports = { dialerRoutes: router, injectIo };
