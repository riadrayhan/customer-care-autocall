/**
 * adminStore.js — file-backed admin user database
 *
 * Persists to data/admins.json. On first run, creates a single super-admin
 * with username from env (ADMIN_USERNAME, default: "admin") and bcrypt-hashed
 * password (ADMIN_PASSWORD, default: "admin123" — CHANGE IN PRODUCTION).
 */
const path = require('path');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const JsonDb = require('./jsonDb');
const logger = require('./logger');

const DB_FILE = process.env.ADMINS_DB_FILE
  || path.join(__dirname, '..', '..', 'data', 'admins.json');

// Lazy-seed if file missing or empty
const initialUsername = process.env.ADMIN_USERNAME || 'admin';
const initialPassword = process.env.ADMIN_PASSWORD || 'admin123';

const seed = () => ([{
  id: 'admin-' + uuidv4().slice(0, 8),
  username: initialUsername,
  name: 'Super Admin',
  role: 'superadmin',
  hash: bcrypt.hashSync(initialPassword, 10),
  createdAt: new Date().toISOString(),
}]);

const db = new JsonDb(DB_FILE, { admins: [] });
if (!Array.isArray(db.data.admins) || db.data.admins.length === 0) {
  db.data.admins = seed();
  db.flushSync();
  logger.warn('Seed admin created — change password!', { username: initialUsername });
}

const store = {
  getAll() { return db.data.admins.map(a => ({ id: a.id, username: a.username, name: a.name, role: a.role })); },
  findByUsername(username) { return db.data.admins.find(a => a.username === username) || null; },
  findById(id)             { return db.data.admins.find(a => a.id === id) || null; },

  async verify(username, password) {
    const a = store.findByUsername(username);
    if (!a) return null;
    const ok = await bcrypt.compare(password, a.hash);
    return ok ? a : null;
  },

  async create({ username, password, name, role = 'agent' }) {
    if (store.findByUsername(username)) throw new Error('Username already exists');
    const a = {
      id: 'admin-' + uuidv4().slice(0, 8),
      username, name: name || username, role,
      hash: await bcrypt.hash(password, 10),
      createdAt: new Date().toISOString(),
    };
    db.data.admins.push(a);
    db.save();
    return { id: a.id, username: a.username, name: a.name, role: a.role };
  },

  delete(id) {
    const idx = db.data.admins.findIndex(a => a.id === id);
    if (idx === -1) return false;
    db.data.admins.splice(idx, 1);
    db.save();
    return true;
  },

  _db: db,
};

module.exports = store;
