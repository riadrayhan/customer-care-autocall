const express     = require('express');
const callManager = require('../services/callManager');
const userStore   = require('../utils/userStore');

const router = express.Router();

const withStatus = u => ({ ...u, online: callManager.isUserOnline(u.id) });

/** GET /api/users */
router.get('/', (_req, res) => res.json(userStore.getAll().map(withStatus)));

/** GET /api/users/online */
router.get('/online', (_req, res) => {
  res.json(userStore.getAll().filter(u => callManager.isUserOnline(u.id)).map(withStatus));
});

/** GET /api/users/emi-due?daysAhead=1 */
router.get('/emi-due', (req, res) => {
  const days = Number(req.query.daysAhead ?? 1);
  res.json(userStore.getDueUsers(days).map(withStatus));
});

/** GET /api/users/:id */
router.get('/:id', (req, res) => {
  const u = userStore.getById(req.params.id);
  if (!u) return res.status(404).json({ error: 'User not found' });
  res.json(withStatus(u));
});

/** GET /api/users/:id/call-history */
router.get('/:id/call-history', (req, res) => {
  const u = userStore.getById(req.params.id);
  if (!u) return res.status(404).json({ error: 'User not found' });
  res.json({
    userId     : u.id,
    name       : u.name,
    callCount  : u.callCount,
    lastCalledAt: u.lastCalledAt,
    history    : u.callHistory,
  });
});

/** POST /api/users */
router.post('/', (req, res) => {
  const { name, phone } = req.body || {};
  if (!name || !phone) return res.status(400).json({ error: 'name and phone required' });
  res.status(201).json(userStore.create(req.body));
});

/** PATCH /api/users/:id */
router.patch('/:id', (req, res) => {
  const u = userStore.update(req.params.id, req.body);
  if (!u) return res.status(404).json({ error: 'User not found' });
  res.json(withStatus(u));
});

/** DELETE /api/users/:id */
router.delete('/:id', (req, res) => {
  if (!userStore.delete(req.params.id)) return res.status(404).json({ error: 'User not found' });
  res.json({ ok: true });
});

/**
 * POST /api/users/:id/fcm-token
 * Body: { token }
 * Register a device's FCM token so server can wake it for incoming calls.
 * NOTE: this endpoint is mounted under authMiddleware in server.js,
 *       so a Flutter client without an admin token cannot call it directly.
 *       For the Flutter client we expose the same registration via socket
 *       event `register_fcm_token` (no admin auth required, scoped to userId).
 */
router.post('/:id/fcm-token', (req, res) => {
  const { token } = req.body || {};
  if (!token) return res.status(400).json({ error: 'token required' });
  if (!userStore.getById(req.params.id)) return res.status(404).json({ error: 'User not found' });
  const added = userStore.addFcmToken(req.params.id, token);
  res.json({ ok: true, added });
});

/** DELETE /api/users/:id/fcm-token  Body: { token } */
router.delete('/:id/fcm-token', (req, res) => {
  const { token } = req.body || {};
  if (!token) return res.status(400).json({ error: 'token required' });
  const removed = userStore.removeFcmToken(req.params.id, token);
  res.json({ ok: true, removed });
});

module.exports = { userRoutes: router };
