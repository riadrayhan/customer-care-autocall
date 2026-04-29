/**
 * socketService v2
 * ────────────────────────────────────────────────────────────────────────────
 * • Subscribes to CallManager EventEmitter (decoupled)
 * • Room-based WebRTC: every call gets room `call:<callId>`
 * • ICE restart support
 * • bulk_call event — fire to multiple users at once
 * • Input validation on every event
 * • Heartbeat ping every 15 s
 *
 * SIGNALING FLOW:
 *  Admin ──initiate_call──▶ Server ──incoming_call──▶ Flutter
 *  Flutter ──call_answer──▶ Server ──call_answered──▶ Admin
 *  Both peers join room call:<callId>
 *  Admin ──webrtc_offer──▶ room ──▶ Flutter
 *  Flutter ──webrtc_answer──▶ room ──▶ Admin
 *  ◀══ ICE candidates relayed both ways through room ══▶
 *  Either side ──end_call──▶ room broadcast call_ended
 */

const callManager = require('./callManager');
const logger      = require('../utils/logger');

const validate = (socket, data, fields) => {
  for (const f of fields) {
    if (!data || data[f] == null) {
      socket.emit('error_event', { error: `Missing required field: ${f}` });
      return false;
    }
  }
  return true;
};

const callRoom  = id => `call:${id}`;
const ADMIN_ROOM = 'admins';

function setupSocketHandlers(io) {

  // ── Bind CallManager events → Socket.io ────────────────────────────────────

  callManager.on('call:ringing', call => {
    const sid = callManager.getUserSocket(call.userId);
    if (sid) io.to(sid).emit('incoming_call', {
      callId: call.callId, callerName: call.callerName,
      message: call.message, retryCount: call.retryCount, ts: call.createdAt,
    });
    io.to(ADMIN_ROOM).emit('call_ringing', { callId: call.callId, userId: call.userId });
    io.to(ADMIN_ROOM).emit('stats_update', callManager.getStats());
  });

  callManager.on('call:queued', call => {
    io.to(ADMIN_ROOM).emit('call_queued', {
      callId: call.callId, userId: call.userId,
      retryCount: call.retryCount, msg: 'User offline – queued',
    });
  });

  callManager.on('call:answered', call => {
    io.to(ADMIN_ROOM).emit('call_answered', {
      callId: call.callId, userId: call.userId, answeredAt: call.answeredAt,
    });
    io.to(ADMIN_ROOM).emit('stats_update', callManager.getStats());
  });

  callManager.on('call:missed', call => {
    io.to(ADMIN_ROOM).emit('call_missed', {
      callId: call.callId, userId: call.userId, reason: call.failReason,
    });
    const sid = callManager.getUserSocket(call.userId);
    if (sid) io.to(sid).emit('call_cancelled', { callId: call.callId });
    io.to(ADMIN_ROOM).emit('stats_update', callManager.getStats());
  });

  callManager.on('call:rejected', call => {
    io.to(ADMIN_ROOM).emit('call_rejected', {
      callId: call.callId, userId: call.userId, canRetry: call.retryCount < 3,
    });
    io.to(ADMIN_ROOM).emit('stats_update', callManager.getStats());
  });

  callManager.on('call:ended', call => {
    io.to(callRoom(call.callId)).emit('call_ended', {
      callId: call.callId, duration: call.duration,
    });
    io.to(ADMIN_ROOM).emit('stats_update', callManager.getStats());
  });

  callManager.on('call:retry_scheduled', call => {
    io.to(ADMIN_ROOM).emit('call_retry_scheduled', {
      callId: call.callId, userId: call.userId, attempt: call.retryCount,
    });
  });

  callManager.on('call:max_retries', call => {
    io.to(ADMIN_ROOM).emit('call_failed', {
      callId: call.callId, userId: call.userId, reason: 'max_retries_reached',
    });
  });

  callManager.on('user:online', ({ userId }) => {
    io.to(ADMIN_ROOM).emit('user_online', { userId, ts: Date.now() });
    io.to(ADMIN_ROOM).emit('stats_update', callManager.getStats());
  });

  callManager.on('user:offline', ({ userId }) => {
    io.to(ADMIN_ROOM).emit('user_offline', { userId, ts: Date.now() });
    io.to(ADMIN_ROOM).emit('stats_update', callManager.getStats());
  });

  // ── Per-socket handlers ───────────────────────────────────────────────────

  io.on('connection', socket => {
    logger.info('Socket connected', { socketId: socket.id });

    // Registration
    socket.on('register_user', (data = {}) => {
      if (!validate(socket, data, ['userId'])) return;
      callManager.registerUser(data.userId, socket.id);
      socket.join(`user:${data.userId}`);
      socket.emit('registered', { ok: true, userId: data.userId, socketId: socket.id });
    });

    // FCM token registration (for wake-up push when offline)
    socket.on('register_fcm_token', (data = {}) => {
      if (!validate(socket, data, ['userId', 'token'])) return;
      const userStore = require('../utils/userStore');
      if (!userStore.getById(data.userId)) {
        return socket.emit('error_event', { error: 'User not found' });
      }
      const added = userStore.addFcmToken(data.userId, data.token);
      socket.emit('fcm_token_registered', { ok: true, added });
    });

    socket.on('unregister_fcm_token', (data = {}) => {
      if (!validate(socket, data, ['userId', 'token'])) return;
      const userStore = require('../utils/userStore');
      const removed = userStore.removeFcmToken(data.userId, data.token);
      socket.emit('fcm_token_unregistered', { ok: true, removed });
    });

    socket.on('register_admin', (data = {}) => {
      callManager.registerAdmin(socket.id, { adminId: data.adminId, name: data.name });
      socket.join(ADMIN_ROOM);
      socket.emit('admin_registered', { ok: true, socketId: socket.id, stats: callManager.getStats() });
    });

    // Call initiation
    socket.on('initiate_call', (data = {}) => {
      if (!validate(socket, data, ['userId'])) return;
      callManager.initiateCall({
        userId: data.userId, adminSocketId: socket.id,
        message: data.message, callerName: data.callerName,
        autoMessage: data.autoMessage || false,
      });
    });

    socket.on('bulk_call', (data = {}) => {
      if (!Array.isArray(data.userIds) || data.userIds.length === 0)
        return socket.emit('error_event', { error: 'userIds[] required' });
      const results = data.userIds.map(userId =>
        callManager.initiateCall({ userId, adminSocketId: socket.id, message: data.message, autoMessage: true })
      );
      socket.emit('bulk_call_initiated', { count: results.length });
    });

    // Answer / reject
    socket.on('call_answer', (data = {}) => {
      if (!validate(socket, data, ['callId'])) return;
      const call = callManager.answerCall(data.callId);
      if (!call) return socket.emit('error_event', { error: 'Call not found', callId: data.callId });

      // Join call room
      socket.join(callRoom(data.callId));
      // Also add admin socket to call room
      const adminSid = call.adminSocketId;
      if (adminSid && adminSid.length === 20) {   // real socket id, not 'rest:xxx'
        io.to(adminSid).socketsJoin(callRoom(data.callId));
      }

      socket.emit('call_accepted', { callId: data.callId, message: call.message });
    });

    socket.on('call_reject', (data = {}) => {
      if (!validate(socket, data, ['callId'])) return;
      callManager.rejectCall(data.callId);
    });

    // WebRTC signaling (all go through call room)
    socket.on('webrtc_offer', (data = {}) => {
      if (!validate(socket, data, ['callId', 'sdp'])) return;
      // Ensure the sending admin is in the call room so it receives the
      // peer's webrtc_answer / ice_candidate replies.
      socket.join(callRoom(data.callId));
      socket.to(callRoom(data.callId)).emit('webrtc_offer', { callId: data.callId, sdp: data.sdp });
    });

    socket.on('webrtc_answer', (data = {}) => {
      if (!validate(socket, data, ['callId', 'sdp'])) return;
      socket.join(callRoom(data.callId));
      socket.to(callRoom(data.callId)).emit('webrtc_answer', { callId: data.callId, sdp: data.sdp });
    });

    socket.on('ice_candidate', (data = {}) => {
      if (!validate(socket, data, ['callId', 'candidate'])) return;
      socket.join(callRoom(data.callId));
      socket.to(callRoom(data.callId)).emit('ice_candidate', { callId: data.callId, candidate: data.candidate });
    });

    socket.on('ice_restart', (data = {}) => {
      if (!validate(socket, data, ['callId'])) return;
      socket.to(callRoom(data.callId)).emit('ice_restart', { callId: data.callId });
      logger.info('ICE restart', { callId: data.callId, from: socket.id });
    });

    // End call
    socket.on('end_call', (data = {}) => {
      if (!validate(socket, data, ['callId'])) return;
      callManager.endCall(data.callId, data.reason || 'normal');
      socket.leave(callRoom(data.callId));
    });

    // Retry
    socket.on('retry_call', (data = {}) => {
      if (!validate(socket, data, ['callId'])) return;
      const hist = callManager.getHistory({ limit: 500 });
      const original = hist.find(c => c.callId === data.callId);
      if (!original) return socket.emit('error_event', { error: 'Call not found in history' });
      const ok = callManager.scheduleRetry({ ...original, adminSocketId: socket.id });
      socket.emit('retry_scheduled', { ok, callId: data.callId });
    });

    // Admin queries
    socket.on('get_stats',       ()     => socket.emit('stats_update', callManager.getStats()));
    socket.on('get_calls',       ()     => socket.emit('calls_list', { active: callManager.getActiveCalls(), pending: callManager.getPendingCalls() }));
    socket.on('get_history',     (d={}) => socket.emit('call_history', callManager.getHistory({ userId: d.userId, limit: d.limit || 50, status: d.status })));
    socket.on('get_retry_queue', ()     => socket.emit('retry_queue', callManager.getRetryQueue()));

    // Broadcast system message to all connected users
    socket.on('broadcast_message', (data = {}) => {
      if (!validate(socket, data, ['message'])) return;
      const sids = [...callManager.userSockets.values()];
      sids.forEach(sid => io.to(sid).emit('system_message', { message: data.message, ts: new Date().toISOString() }));
      socket.emit('broadcast_sent', { count: sids.length });
    });

    // Heartbeat
    socket.on('ping', () => socket.emit('pong', { ts: Date.now() }));

    // Disconnect
    socket.on('disconnect', reason => {
      logger.info('Socket disconnected', { socketId: socket.id, reason });
      callManager.removeSocket(socket.id);
    });
  });

  // Server-side heartbeat every 15 s
  setInterval(() => io.emit('server_ping', { ts: Date.now() }), 15_000);
}

module.exports = { setupSocketHandlers };
