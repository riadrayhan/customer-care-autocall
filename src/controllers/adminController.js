/**
 * adminController.js — admin user CRUD (superadmin only)
 */
const express = require('express');
const adminStore = require('../utils/adminStore');
const { requireRole } = require('../middleware/auth');
const logger = require('../utils/logger');

const router = express.Router();

router.use(requireRole('superadmin'));

/** GET /api/admins */
router.get('/', (_req, res) => {
  res.json(adminStore.getAll());
});

/** POST /api/admins  Body: { username, password, name?, role? } */
router.post('/', async (req, res) => {
  const { username, password, name, role } = req.body || {};
  if (!username || !password)
    return res.status(400).json({ error: 'username and password required' });
  if (password.length < 6)
    return res.status(400).json({ error: 'password must be at least 6 characters' });
  if (role && !['superadmin', 'agent'].includes(role))
    return res.status(400).json({ error: 'role must be superadmin|agent' });
  try {
    const a = await adminStore.create({ username, password, name, role });
    logger.info('Admin created', { username, role: a.role, by: req.admin.username });
    res.status(201).json(a);
  } catch (e) {
    res.status(409).json({ error: e.message });
  }
});

/** DELETE /api/admins/:id */
router.delete('/:id', (req, res) => {
  if (req.params.id === req.admin.id)
    return res.status(400).json({ error: 'Cannot delete yourself' });
  if (!adminStore.delete(req.params.id))
    return res.status(404).json({ error: 'Admin not found' });
  logger.info('Admin deleted', { id: req.params.id, by: req.admin.username });
  res.json({ ok: true });
});

module.exports = { adminRoutes: router };
