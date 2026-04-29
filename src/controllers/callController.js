/**
 * callController v2
 * REST API for admin panel.
 * All state mutations go through callManager — same as socket events.
 */
const express     = require('express');
const callManager = require('../services/callManager');
const userStore   = require('../utils/userStore');
const logger      = require('../utils/logger');

const router = express.Router();
let _io = null;
const injectIo = io => { _io = io; };

// ── Per-admin rate limit (sliding window) ─────────────────────────────────────
// Max N call-initiations per admin per minute, to prevent abuse / runaway loops.
const CALL_RATE_LIMIT  = Number(process.env.CALL_RATE_LIMIT  || 30); // calls
const CALL_RATE_WINDOW = Number(process.env.CALL_RATE_WINDOW || 60_000); // ms
const _adminCallTimes = new Map(); // adminId → number[] (timestamps)

function rateLimitOk(adminId) {
  const now = Date.now();
  const arr = (_adminCallTimes.get(adminId) || []).filter(t => now - t < CALL_RATE_WINDOW);
  if (arr.length >= CALL_RATE_LIMIT) {
    _adminCallTimes.set(adminId, arr);
    return false;
  }
  arr.push(now);
  _adminCallTimes.set(adminId, arr);
  return true;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function pushToUser(userId, event, data) {
  if (!_io) return;
  const sid = callManager.getUserSocket(userId);
  if (sid) _io.to(sid).emit(event, data);
}

// ── Routes ────────────────────────────────────────────────────────────────────

/**
 * POST /api/calls/initiate
 * Body: { userId, message?, callerName?, autoMessage? }
 */
router.post('/initiate', (req, res) => {
  const { userId, message, callerName, autoMessage } = req.body || {};
  if (!userId) return res.status(400).json({ error: 'userId required' });
  if (!userStore.getById(userId)) return res.status(404).json({ error: 'User not found' });
  if (!rateLimitOk(req.admin.id))
    return res.status(429).json({ error: `Rate limit: max ${CALL_RATE_LIMIT} calls/min` });

  const call = callManager.initiateCall({
    userId, message, callerName,
    autoMessage: autoMessage || false,
    adminSocketId: `rest:${req.admin.id}`,
  });

  res.json({ ok: true, callId: call.callId, status: call.status });
});

/**
 * POST /api/calls/bulk
 * Body: { userIds[], message?, autoMessage? }
 * Initiate calls to multiple users (e.g. all EMI-due users).
 */
router.post('/bulk', (req, res) => {
  const { userIds, message, autoMessage } = req.body || {};
  if (!Array.isArray(userIds) || userIds.length === 0)
    return res.status(400).json({ error: 'userIds[] required' });

  const results = userIds.map(userId => {
    if (!userStore.getById(userId)) return { userId, error: 'User not found' };
    const call = callManager.initiateCall({
      userId, message, autoMessage: autoMessage !== false,
      adminSocketId: `rest:${req.admin.id}`,
    });
    return { userId, callId: call.callId, status: call.status };
  });

  logger.info('Bulk call initiated', { count: results.length, by: req.admin.username });
  res.json({ ok: true, count: results.length, results });
});

/**
 * POST /api/calls/emi-auto-call
 * One-click: call ALL users with EMI due today or overdue.
 */
router.post('/emi-auto-call', (req, res) => {
  const { daysAhead = 1 } = req.body || {};
  const due = userStore.getDueUsers(Number(daysAhead));

  if (due.length === 0) return res.json({ ok: true, message: 'No EMI-due users found', count: 0 });

  const results = due.map(u => {
    const call = callManager.initiateCall({
      userId: u.id, autoMessage: true,
      adminSocketId: `rest:${req.admin.id}`,
    });
    return { userId: u.id, name: u.name, callId: call.callId, status: call.status };
  });

  logger.info('EMI auto-call fired', { count: results.length, by: req.admin.username });
  res.json({ ok: true, count: results.length, results });
});

/**
 * POST /api/calls/:callId/end
 */
router.post('/:callId/end', (req, res) => {
  const call = callManager.endCall(req.params.callId, req.body?.reason || 'admin_ended');
  if (!call) return res.status(404).json({ error: 'Call not found' });
  pushToUser(call.userId, 'call_ended', { callId: call.callId });
  res.json({ ok: true, call });
});

/**
 * POST /api/calls/:callId/retry
 */
router.post('/:callId/retry', (req, res) => {
  const hist = callManager.getHistory({ limit: 500 });
  const original = hist.find(c => c.callId === req.params.callId);
  if (!original) return res.status(404).json({ error: 'Call not found in history' });
  const ok = callManager.scheduleRetry({ ...original, adminSocketId: `rest:${req.admin.id}` });
  res.json({ ok, callId: req.params.callId });
});

/**
 * GET /api/calls/active
 */
router.get('/active', (_req, res) => {
  res.json({
    active : callManager.getActiveCalls(),
    pending: callManager.getPendingCalls(),
    stats  : callManager.getStats(),
  });
});

/**
 * GET /api/calls/history?userId=&status=&limit=
 */
router.get('/history', (req, res) => {
  const { userId, status, limit } = req.query;
  res.json(callManager.getHistory({ userId, status, limit: Number(limit) || 50 }));
});

/**
 * GET /api/calls/retry-queue
 */
router.get('/retry-queue', (_req, res) => {
  res.json(callManager.getRetryQueue());
});

/**
 * GET /api/calls/:callId
 */
router.get('/:callId', (req, res) => {
  const call = callManager.getCall(req.params.callId)
    || callManager.getHistory({ limit: 500 }).find(c => c.callId === req.params.callId);
  if (!call) return res.status(404).json({ error: 'Call not found' });
  res.json(call);
});

module.exports = { callRoutes: router, injectIo };
