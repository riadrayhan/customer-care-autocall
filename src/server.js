require('dotenv').config();

const express      = require('express');
const http         = require('http');
const { Server }   = require('socket.io');
const cors         = require('cors');
const rateLimit    = require('express-rate-limit');
const path         = require('path');

const logger                        = require('./utils/logger');
const { setupSocketHandlers }       = require('./services/socketService');
const { authRoutes }                = require('./controllers/authController');
const { callRoutes, injectIo }      = require('./controllers/callController');
const { userRoutes }                = require('./controllers/userController');
const { adminRoutes }               = require('./controllers/adminController');
const { authMiddleware }            = require('./middleware/auth');
const callManager                   = require('./services/callManager');
const pushService                   = require('./services/pushService');

// Initialise FCM (no-op if credentials missing)
pushService.init();

// ── App ───────────────────────────────────────────────────────────────────────
const app        = express();
const httpServer = http.createServer(app);

// ── Socket.io ─────────────────────────────────────────────────────────────────
const io = new Server(httpServer, {
  cors        : { origin: '*', methods: ['GET', 'POST'] },
  transports  : ['websocket', 'polling'],
  pingTimeout : 20_000,
  pingInterval: 10_000,
});

injectIo(io);

// ── Middlewares ───────────────────────────────────────────────────────────────
app.use(cors({ origin: '*' }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, '../public')));

// Rate limit: max 60 req/min per IP on all API routes
app.use('/api', rateLimit({
  windowMs : 60_000,
  max      : 60,
  message  : { error: 'Too many requests, slow down.' },
}));

// Tighter limit on login endpoint
app.use('/api/auth/login', rateLimit({
  windowMs : 60_000,
  max      : 10,
  message  : { error: 'Too many login attempts.' },
}));

// ── Routes ────────────────────────────────────────────────────────────────────
app.use('/api/auth',  authRoutes);
app.use('/api/calls', authMiddleware, callRoutes);
app.use('/api/users', authMiddleware, userRoutes);
app.use('/api/admins', authMiddleware, adminRoutes);

/** GET /health — Render health check */
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', uptime: Math.floor(process.uptime()), ...callManager.getStats() });
});

/** GET /api/ice-servers — Flutter fetches this on startup
 *  Priority:
 *    1. METERED_API_KEY → fetch fresh credentials from Metered (cached 1h)
 *    2. TURN_URL/USERNAME/CREDENTIAL static env vars
 *    3. STUN-only fallback
 */
let _meteredCache = { servers: null, ts: 0 };
const METERED_TTL_MS = 60 * 60 * 1000; // 1 hour

async function fetchMeteredIceServers() {
  if (_meteredCache.servers && Date.now() - _meteredCache.ts < METERED_TTL_MS) {
    return _meteredCache.servers;
  }
  const apiKey = process.env.METERED_API_KEY;
  const subdomain = process.env.METERED_SUBDOMAIN || 'customerapp';
  if (!apiKey) return null;
  try {
    const url = `https://${subdomain}.metered.live/api/v1/turn/credentials?apiKey=${apiKey}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const servers = await res.json();
    _meteredCache = { servers, ts: Date.now() };
    logger.info('Metered TURN credentials refreshed', { count: servers.length });
    return servers;
  } catch (e) {
    logger.error('Metered TURN fetch failed', { error: e.message });
    return null;
  }
}

app.get('/api/ice-servers', async (_req, res) => {
  const metered = await fetchMeteredIceServers();
  if (metered && metered.length > 0) {
    return res.json({ iceServers: metered });
  }
  const servers = [
    { urls: process.env.STUN_URL_1 || 'stun:stun.l.google.com:19302' },
    { urls: process.env.STUN_URL_2 || 'stun:stun1.l.google.com:19302' },
  ];
  if (process.env.TURN_URL) servers.push({
    urls      : process.env.TURN_URL,
    username  : process.env.TURN_USERNAME,
    credential: process.env.TURN_CREDENTIAL,
  });
  res.json({ iceServers: servers });
});

/** GET /api/docs — quick event reference */
app.get('/api/docs', (_req, res) => {
  res.json({
    version: '2.0.0',
    socketEvents: {
      client_to_server: [
        'register_user { userId }',
        'register_admin { adminId?, name? }',
        'initiate_call { userId, message?, callerName?, autoMessage? }',
        'bulk_call { userIds[], message?, autoMessage? }',
        'call_answer { callId }',
        'call_reject { callId }',
        'webrtc_offer { callId, sdp }',
        'webrtc_answer { callId, sdp }',
        'ice_candidate { callId, candidate }',
        'ice_restart { callId }',
        'end_call { callId, reason? }',
        'retry_call { callId }',
        'get_stats',
        'get_calls',
        'get_history { userId?, limit?, status? }',
        'get_retry_queue',
        'broadcast_message { message }',
        'ping',
      ],
      server_to_client: [
        'registered',
        'admin_registered',
        'incoming_call { callId, callerName, message, retryCount, ts }',
        'call_ringing { callId, userId }',
        'call_queued { callId, userId, retryCount }',
        'call_answered { callId, userId, answeredAt }',
        'call_accepted { callId, message }',
        'call_ended { callId, duration }',
        'call_missed { callId, userId, reason }',
        'call_rejected { callId, userId, canRetry }',
        'call_cancelled { callId }',
        'call_retry_scheduled { callId, userId, attempt }',
        'call_failed { callId, userId, reason }',
        'webrtc_offer { callId, sdp }',
        'webrtc_answer { callId, sdp }',
        'ice_candidate { callId, candidate }',
        'ice_restart { callId }',
        'user_online { userId, ts }',
        'user_offline { userId, ts }',
        'stats_update',
        'calls_list',
        'call_history',
        'retry_queue',
        'system_message { message, ts }',
        'server_ping { ts }',
        'pong { ts }',
        'error_event { error }',
        'broadcast_sent { count }',
      ],
    },
    restEndpoints: [
      'POST /api/auth/login',
      'GET  /api/auth/me',
      'POST /api/auth/refresh',
      'GET  /api/ice-servers',
      'GET  /api/users',
      'GET  /api/users/online',
      'GET  /api/users/emi-due?daysAhead=1',
      'POST /api/users',
      'GET  /api/users/:id',
      'GET  /api/users/:id/call-history',
      'PATCH /api/users/:id',
      'DELETE /api/users/:id',
      'POST /api/calls/initiate',
      'POST /api/calls/bulk',
      'POST /api/calls/emi-auto-call',
      'GET  /api/calls/active',
      'GET  /api/calls/history',
      'GET  /api/calls/retry-queue',
      'GET  /api/calls/:callId',
      'POST /api/calls/:callId/end',
      'POST /api/calls/:callId/retry',
      'GET  /health',
    ],
  });
});

// ── Global error handler ──────────────────────────────────────────────────────
app.use((err, _req, res, _next) => {
  logger.error('Unhandled error', { message: err.message, stack: err.stack });
  res.status(err.status || 500).json({ error: err.message || 'Internal server error' });
});

// ── Socket handlers ───────────────────────────────────────────────────────────
setupSocketHandlers(io);

// ── Start ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => {
  logger.info(`AutoCall Backend v2 started`, { port: PORT, env: process.env.NODE_ENV || 'development' });
  logger.info(`Docs: http://localhost:${PORT}/api/docs`);
});

// ── Graceful shutdown — flush JSON DBs ────────────────────────────────────────
const userStore  = require('./utils/userStore');
const adminStore = require('./utils/adminStore');
function shutdown(signal) {
  logger.info(`${signal} received — flushing data and shutting down`);
  try { userStore._db.flushSync(); } catch {}
  try { adminStore._db.flushSync(); } catch {}
  httpServer.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000).unref();
}
process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

module.exports = { app, io };
