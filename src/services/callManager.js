/**
 * CallManager v2
 * EventEmitter3, retry queue, call history, room-based WebRTC, stats
 */
const EventEmitter = require('eventemitter3');
const { v4: uuidv4 } = require('uuid');
const logger        = require('../utils/logger');
const userStore     = require('../utils/userStore');
const pushService   = require('./pushService');

const RING_TIMEOUT_MS = 30_000;
const MAX_RETRIES     = 3;
const RETRY_DELAY_MS  = 60_000;
const HISTORY_LIMIT   = 500;

const STATUS = {
  QUEUED: 'queued', RINGING: 'ringing', ACTIVE: 'active',
  ENDED: 'ended', MISSED: 'missed', REJECTED: 'rejected', FAILED: 'failed',
};

class CallManager extends EventEmitter {
  constructor() {
    super();
    this.userSockets  = new Map();
    this.socketToUser = new Map();
    this.adminSockets = new Map();
    this.pendingCalls = new Map();
    this.activeCalls  = new Map();
    this.callHistory  = [];
    this.retryQueue   = new Map();
    this._ringTimers  = new Map();
  }

  // ── Registration ────────────────────────────────────────────────────────────

  registerUser(userId, socketId) {
    const old = this.userSockets.get(userId);
    if (old && old !== socketId) this.socketToUser.delete(old);
    this.userSockets.set(userId, socketId);
    this.socketToUser.set(socketId, userId);
    logger.info('User registered', { userId, socketId });
    this.emit('user:online', { userId });
    this._drainRetryQueue(userId);
  }

  registerAdmin(socketId, info = {}) {
    this.adminSockets.set(socketId, { adminId: info.adminId || socketId, name: info.name || 'Admin' });
    logger.info('Admin connected', { socketId, ...info });
    this.emit('admin:connected', { socketId });
  }

  removeSocket(socketId) {
    const userId = this.socketToUser.get(socketId);
    if (userId) {
      this.userSockets.delete(userId);
      this.socketToUser.delete(socketId);
      logger.info('User disconnected', { userId });
      this.emit('user:offline', { userId });
      const missed = this._cancelRingingForUser(userId, 'user_disconnected');
      if (missed) this.emit('call:missed', missed);
    }
    if (this.adminSockets.has(socketId)) {
      this.adminSockets.delete(socketId);
      logger.info('Admin disconnected', { socketId });
      this.emit('admin:disconnected', { socketId });
    }
    return userId || null;
  }

  // ── Call lifecycle ───────────────────────────────────────────────────────────

  initiateCall({ userId, adminSocketId, message, callerName, autoMessage }) {
    const user = userStore.getById(userId);
    let finalMsg = message || 'Sir apnar EMI date kal sesh hobe, druto EMI pay koren.';
    if (autoMessage && user) finalMsg = userStore.buildMessage(user);

    const callId = uuidv4();
    const record = {
      callId, userId, adminSocketId,
      callerName: callerName || 'Customer Support',
      message: finalMsg,
      status: STATUS.RINGING,
      retryCount: 0,
      createdAt: new Date().toISOString(),
      answeredAt: null, endedAt: null, duration: null, failReason: null,
    };

    if (this.isUserOnline(userId)) {
      this.pendingCalls.set(callId, record);
      this._startRingTimer(callId);
      logger.info('Call ringing', { callId, userId });
      this.emit('call:ringing', record);
    } else {
      record.status = STATUS.QUEUED;
      this._enqueueRetry(record);
      logger.info('User offline — call queued', { callId, userId });
      this.emit('call:queued', record);
      // Also try to wake the device via FCM if push is configured
      this._tryWakePush(record);
    }
    return record;
  }

  answerCall(callId) {
    const call = this.pendingCalls.get(callId);
    if (!call) return null;
    this._clearRingTimer(callId);
    call.status = STATUS.ACTIVE;
    call.answeredAt = new Date().toISOString();
    this.pendingCalls.delete(callId);
    this.activeCalls.set(callId, call);
    logger.info('Call answered', { callId });
    this.emit('call:answered', call);
    return call;
  }

  rejectCall(callId) {
    const call = this.pendingCalls.get(callId);
    if (!call) return null;
    this._clearRingTimer(callId);
    call.status = STATUS.REJECTED;
    call.endedAt = new Date().toISOString();
    call.failReason = 'rejected_by_user';
    this.pendingCalls.delete(callId);
    this._archiveCall(call);
    logger.info('Call rejected', { callId });
    this.emit('call:rejected', call);
    return call;
  }

  endCall(callId, reason = 'normal') {
    const call = this.activeCalls.get(callId) || this.pendingCalls.get(callId);
    if (!call) return null;
    this._clearRingTimer(callId);
    call.status = STATUS.ENDED;
    call.endedAt = new Date().toISOString();
    call.failReason = reason !== 'normal' ? reason : null;
    call.duration = call.answeredAt
      ? Math.round((new Date(call.endedAt) - new Date(call.answeredAt)) / 1000) : 0;
    this.activeCalls.delete(callId);
    this.pendingCalls.delete(callId);
    this._archiveCall(call);
    logger.info('Call ended', { callId, duration: call.duration });
    this.emit('call:ended', call);
    return call;
  }

  scheduleRetry(callRecord) {
    if (callRecord.retryCount >= MAX_RETRIES) {
      logger.warn('Max retries reached', { callId: callRecord.callId });
      this.emit('call:max_retries', callRecord);
      return false;
    }
    const cloned = {
      ...callRecord, callId: uuidv4(),
      status: STATUS.QUEUED, createdAt: new Date().toISOString(),
      answeredAt: null, endedAt: null, duration: null, failReason: null,
      retryCount: (callRecord.retryCount || 0) + 1,
    };
    setTimeout(() => {
      if (this.isUserOnline(cloned.userId)) {
        cloned.status = STATUS.RINGING;
        this.pendingCalls.set(cloned.callId, cloned);
        this._startRingTimer(cloned.callId);
        this.emit('call:ringing', cloned);
      } else {
        this._enqueueRetry(cloned);
        this.emit('call:queued', cloned);
      }
    }, RETRY_DELAY_MS);
    logger.info('Retry scheduled', { attempt: cloned.retryCount, delay: RETRY_DELAY_MS });
    this.emit('call:retry_scheduled', cloned);
    return true;
  }

  // ── Internal helpers ─────────────────────────────────────────────────────────

  _tryWakePush(record) {
    if (!pushService.isEnabled()) return;
    const tokens = userStore.getFcmTokens(record.userId);
    if (tokens.length === 0) return;
    pushService.sendIncomingCallPush(tokens, {
      callId: record.callId,
      callerName: record.callerName,
      message: record.message,
      retryCount: record.retryCount,
    }).catch(e => logger.warn('Wake push failed', { error: e.message }));
  }

  _startRingTimer(callId) {
    const t = setTimeout(() => {
      const c = this.pendingCalls.get(callId);
      if (c && c.status === STATUS.RINGING) this._missCall(callId, 'ring_timeout');
    }, RING_TIMEOUT_MS);
    this._ringTimers.set(callId, t);
  }

  _clearRingTimer(callId) {
    const t = this._ringTimers.get(callId);
    if (t) { clearTimeout(t); this._ringTimers.delete(callId); }
  }

  _missCall(callId, reason = 'missed') {
    const call = this.pendingCalls.get(callId);
    if (!call) return null;
    this._clearRingTimer(callId);
    call.status = STATUS.MISSED;
    call.endedAt = new Date().toISOString();
    call.failReason = reason;
    this.pendingCalls.delete(callId);
    this._archiveCall(call);
    logger.info('Call missed', { callId, reason });
    this.emit('call:missed', call);
    return call;
  }

  _cancelRingingForUser(userId, reason) {
    for (const [callId, call] of this.pendingCalls) {
      if (call.userId === userId) return this._missCall(callId, reason);
    }
    return null;
  }

  _enqueueRetry(record) {
    if (!this.retryQueue.has(record.userId)) this.retryQueue.set(record.userId, []);
    this.retryQueue.get(record.userId).push(record);
  }

  _drainRetryQueue(userId) {
    const q = this.retryQueue.get(userId);
    if (!q || q.length === 0) return;
    logger.info('Draining retry queue', { userId, count: q.length });
    const next = q.shift();
    if (q.length === 0) this.retryQueue.delete(userId);
    if (next) {
      next.status = STATUS.RINGING;
      next.retryCount += 1;
      this.pendingCalls.set(next.callId, next);
      this._startRingTimer(next.callId);
      this.emit('call:ringing', next);
    }
  }

  _archiveCall(call) {
    this.callHistory.unshift({ ...call });
    if (this.callHistory.length > HISTORY_LIMIT) this.callHistory.pop();
    userStore.addCallHistory(call.userId, {
      callId: call.callId, status: call.status,
      duration: call.duration, startedAt: call.createdAt, endedAt: call.endedAt,
    });
  }

  // ── Lookups ──────────────────────────────────────────────────────────────────

  getUserSocket(userId)   { return this.userSockets.get(userId); }
  getUserBySocket(sid)    { return this.socketToUser.get(sid); }
  isUserOnline(userId)    { return this.userSockets.has(userId); }
  getCall(callId)         { return this.activeCalls.get(callId) || this.pendingCalls.get(callId); }
  getActiveCalls()        { return [...this.activeCalls.values()]; }
  getPendingCalls()       { return [...this.pendingCalls.values()]; }

  getRetryQueue() {
    const out = [];
    for (const [userId, q] of this.retryQueue) out.push({ userId, count: q.length, calls: q });
    return out;
  }

  getHistory({ userId, limit = 50, status } = {}) {
    let h = this.callHistory;
    if (userId) h = h.filter(c => c.userId === userId);
    if (status) h = h.filter(c => c.status === status);
    return h.slice(0, limit);
  }

  getStats() {
    const h = this.callHistory;
    const answered = h.filter(c => c.status === 'ended' && c.duration > 0).length;
    const avgDur = answered
      ? Math.round(h.filter(c => c.duration > 0).reduce((s, c) => s + c.duration, 0) / answered) : 0;
    return {
      onlineUsers : this.userSockets.size,
      activeAdmins: this.adminSockets.size,
      activeCalls : this.activeCalls.size,
      pendingCalls: this.pendingCalls.size,
      retryQueued : [...this.retryQueue.values()].reduce((s, q) => s + q.length, 0),
      history: {
        total    : h.length,
        answered,
        missed   : h.filter(c => c.status === 'missed').length,
        rejected : h.filter(c => c.status === 'rejected').length,
        avgDurationSec: avgDur,
      },
    };
  }
}

module.exports = new CallManager();
