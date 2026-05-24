const express = require('express');
const bcrypt  = require('bcryptjs');
const jwt     = require('jsonwebtoken');
const logger  = require('../utils/logger');
const adminStore = require('../utils/adminStore');

const router = express.Router();

const sign = admin => jwt.sign(
  { id: admin.id, username: admin.username, role: admin.role, name: admin.name },
  process.env.JWT_SECRET || 'dev_secret',
  { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
);

/** POST /api/auth/login */
router.post('/login', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password)
    return res.status(400).json({ error: 'username and password required' });

  const admin = await adminStore.verify(username, password);
  if (!admin)
    return res.status(401).json({ error: 'Invalid credentials' });

  logger.info('Admin login', { username, role: admin.role });
  res.json({
    token: sign(admin),
    admin: { id: admin.id, username: admin.username, name: admin.name, role: admin.role },
  });
});

/** GET /api/auth/me */
router.get('/me', (req, res) => {
  const header = req.headers['authorization'] || '';
  const token  = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ ok: false });
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'dev_secret');
    res.json({ ok: true, admin: decoded });
  } catch { res.status(401).json({ ok: false }); }
});

/** POST /api/auth/refresh — extend token by 8 h */
router.post('/refresh', (req, res) => {
  const header = req.headers['authorization'] || '';
  const token  = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Token required' });
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'dev_secret', { ignoreExpiration: true });
    const admin = adminStore.findById(decoded.id);
    if (!admin) return res.status(401).json({ error: 'Admin not found' });
    res.json({ token: sign(admin) });
  } catch { res.status(401).json({ error: 'Invalid token' }); }
});

module.exports = { authRoutes: router };
