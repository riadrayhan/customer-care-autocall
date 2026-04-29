/**
 * userStore.js — file-backed customer database
 *
 * Persists to data/users.json (creates with seed data on first run).
 * In production swap with MongoDB/Postgres — keep the same API.
 *
 * Each user has:
 *   id, name, phone, email, emiDate, loanAmount, outstanding,
 *   callHistory: CallHistoryEntry[]
 *   lastCalledAt: ISO string | null
 *   callCount: number
 */
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const JsonDb = require('./jsonDb');

// ── Seed data ─────────────────────────────────────────────────────────────────
const SEED = [
  { id: 'user-001', name: 'Rahim Uddin',   phone: '+8801711111111', email: 'rahim@example.com',
    emiDate: '2026-04-30', loanAmount: 50000, outstanding: 15000,
    callHistory: [], lastCalledAt: null, callCount: 0 },
  { id: 'user-002', name: 'Karim Ahmed',   phone: '+8801722222222', email: 'karim@example.com',
    emiDate: '2026-04-29', loanAmount: 30000, outstanding: 8000,
    callHistory: [], lastCalledAt: null, callCount: 0 },
  { id: 'user-003', name: 'Fatema Begum',  phone: '+8801733333333', email: 'fatema@example.com',
    emiDate: '2026-05-01', loanAmount: 20000, outstanding: 5000,
    callHistory: [], lastCalledAt: null, callCount: 0 },
  { id: 'user-004', name: 'Jalal Hossain', phone: '+8801744444444', email: 'jalal@example.com',
    emiDate: '2026-04-28', loanAmount: 75000, outstanding: 25000,
    callHistory: [], lastCalledAt: null, callCount: 0 },
  { id: 'user-005', name: 'Nasrin Akter',  phone: '+8801755555555', email: 'nasrin@example.com',
    emiDate: '2026-05-10', loanAmount: 15000, outstanding: 3500,
    callHistory: [], lastCalledAt: null, callCount: 0 },
];

const DB_FILE = process.env.USERS_DB_FILE
  || path.join(__dirname, '..', '..', 'data', 'users.json');

const db = new JsonDb(DB_FILE, { users: SEED });
if (!Array.isArray(db.data.users)) db.data.users = SEED;

// ── Helpers ───────────────────────────────────────────────────────────────────
function buildMessage(user) {
  const days = daysUntil(user.emiDate);
  const amount = (user.outstanding || 0).toLocaleString();
  if (days === null)
    return `Sir apnar EMI date kal sesh hobe, druto EMI pay koren.`;
  if (days < 0)
    return `Sir apnar ${amount} taka EMI overdue hoye geche. Onugroho kore ekhoni payment korben.`;
  if (days === 0)
    return `Sir apnar ${amount} taka EMI aaj sesh hobe. Druto EMI pay koren.`;
  if (days === 1)
    return `Sir apnar ${amount} taka EMI date kal sesh hobe, druto EMI pay koren.`;
  return `Sir apnar ${amount} taka EMI date ${days} din baki ache. Samoy moto pay koren.`;
}

function daysUntil(dateStr) {
  if (!dateStr) return null;
  const now = new Date(); now.setHours(0,0,0,0);
  const due = new Date(dateStr);
  if (isNaN(due.getTime())) return null;
  return Math.round((due - now) / 86_400_000);
}

// ── Public API ────────────────────────────────────────────────────────────────
const store = {
  getAll() { return db.data.users; },

  getById(id) { return db.data.users.find(u => u.id === id) || null; },

  create({ name, phone, email, emiDate, loanAmount }) {
    const u = {
      id: `user-${uuidv4().slice(0,8)}`,
      name, phone, email: email || null,
      emiDate: emiDate || null,
      loanAmount: Number(loanAmount) || 0,
      outstanding: Number(loanAmount) || 0,
      callHistory: [], lastCalledAt: null, callCount: 0,
    };
    db.data.users.push(u);
    db.save();
    return u;
  },

  update(id, patch) {
    const idx = db.data.users.findIndex(u => u.id === id);
    if (idx === -1) return null;
    const { id: _ignored, ...safe } = patch || {};
    db.data.users[idx] = { ...db.data.users[idx], ...safe };
    db.save();
    return db.data.users[idx];
  },

  delete(id) {
    const idx = db.data.users.findIndex(u => u.id === id);
    if (idx === -1) return false;
    db.data.users.splice(idx, 1);
    db.save();
    return true;
  },

  /** Add an FCM device token (deduplicated). Returns true if newly added. */
  addFcmToken(userId, token) {
    if (!token) return false;
    const u = store.getById(userId);
    if (!u) return false;
    if (!Array.isArray(u.fcmTokens)) u.fcmTokens = [];
    if (u.fcmTokens.includes(token)) return false;
    u.fcmTokens.push(token);
    // Cap to last 5 tokens (multiple devices, but bounded)
    if (u.fcmTokens.length > 5) u.fcmTokens.shift();
    db.save();
    return true;
  },

  removeFcmToken(userId, token) {
    const u = store.getById(userId);
    if (!u || !Array.isArray(u.fcmTokens)) return false;
    const idx = u.fcmTokens.indexOf(token);
    if (idx === -1) return false;
    u.fcmTokens.splice(idx, 1);
    db.save();
    return true;
  },

  getFcmTokens(userId) {
    const u = store.getById(userId);
    return (u && Array.isArray(u.fcmTokens)) ? [...u.fcmTokens] : [];
  },

  /** Append a call history entry */
  addCallHistory(userId, entry) {
    const u = store.getById(userId);
    if (!u) return;
    u.callHistory.unshift(entry);
    if (u.callHistory.length > 100) u.callHistory.pop();
    u.lastCalledAt = entry.startedAt;
    u.callCount = (u.callCount || 0) + 1;
    db.save();
  },

  /** Users with EMI due in ≤ daysAhead days (default today + tomorrow) */
  getDueUsers(daysAhead = 1) {
    return db.data.users
      .filter(u => {
        const d = daysUntil(u.emiDate);
        return d !== null && d <= daysAhead;
      })
      .map(u => ({ ...u, daysRemaining: daysUntil(u.emiDate), autoMessage: buildMessage(u) }));
  },

  buildMessage,
  daysUntil,
  _db: db,
};

module.exports = store;
