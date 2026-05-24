/**
 * dialerManager
 * ─────────────────────────────────────────────────────────────────────────────
 * Manages "dialer" devices — Android phones with a SIM that place REAL
 * cellular (PSTN) calls on behalf of the backend. The phone's SIM balance
 * is what gets deducted; the backend just tells it which number to dial.
 *
 * A dialer registers over Socket.io with `register_dialer { dialerId, name }`.
 * The backend then dispatches numbers to dialers (round-robin by default,
 * or a specific dialerId can be targeted). The phone reports state changes
 * back via `sim_call_state { jobId, state, duration?, error? }`.
 *
 * This is independent of the existing WebRTC user-call flow.
 */
const EventEmitter = require('eventemitter3');
const { v4: uuidv4 } = require('uuid');
const logger = require('../utils/logger');

const JOB_TIMEOUT_MS = 90_000;   // dialer must report something within 90 s
const HISTORY_LIMIT  = 500;

const STATE = {
  QUEUED   : 'queued',     // accepted by server, not yet sent to a dialer
  DISPATCHED: 'dispatched',// sent to dialer, awaiting phone state
  DIALING  : 'dialing',    // phone is dialing
  RINGING  : 'ringing',    // remote line is ringing
  CONNECTED: 'connected',  // remote answered
  ENDED    : 'ended',      // normal hangup
  FAILED   : 'failed',     // could not place call / error
  NO_ANSWER: 'no_answer',
  BUSY     : 'busy',
  TIMEOUT  : 'timeout',
};

class DialerManager extends EventEmitter {
  constructor() {
    super();
    // socketId → { dialerId, name, state: 'idle'|'busy', lastSeen }
    this.dialers     = new Map();
    // dialerId → socketId
    this.dialerById  = new Map();
    // jobId → record
    this.activeJobs  = new Map();
    // FIFO of jobs waiting for an idle dialer
    this.queue       = [];
    this.history     = [];
    this._jobTimers  = new Map();
    this._rrCursor   = 0; // round-robin index
  }

  // ── Dialer registration ───────────────────────────────────────────────────
  registerDialer(socketId, { dialerId, name }) {
    const id = dialerId || `dialer-${socketId.slice(0, 6)}`;
    // If a dialerId was already bound to another socket, replace it.
    const oldSid = this.dialerById.get(id);
    if (oldSid && oldSid !== socketId) this.dialers.delete(oldSid);

    this.dialers.set(socketId, {
      dialerId : id,
      name     : name || id,
      state    : 'idle',
      lastSeen : Date.now(),
    });
    this.dialerById.set(id, socketId);
    logger.info('Dialer registered', { socketId, dialerId: id, name });
    this.emit('dialer:online', { socketId, dialerId: id, name });
    // Drain queue in case we were waiting on a dialer.
    this._drainQueue();
    return id;
  }

  removeSocket(socketId) {
    const info = this.dialers.get(socketId);
    if (!info) return null;
    this.dialers.delete(socketId);
    if (this.dialerById.get(info.dialerId) === socketId) {
      this.dialerById.delete(info.dialerId);
    }
    // Fail any active jobs assigned to this dialer.
    for (const [jobId, job] of this.activeJobs) {
      if (job.assignedSocketId === socketId) {
        this._completeJob(jobId, STATE.FAILED, { error: 'dialer_disconnected' });
      }
    }
    logger.info('Dialer disconnected', { socketId, dialerId: info.dialerId });
    this.emit('dialer:offline', { socketId, dialerId: info.dialerId });
    return info;
  }

  updateDialerState(socketId, state) {
    const info = this.dialers.get(socketId);
    if (!info) return;
    info.state    = state;
    info.lastSeen = Date.now();
    this.emit('dialer:state', { socketId, dialerId: info.dialerId, state });
    if (state === 'idle') this._drainQueue();
  }

  // ── Public API ────────────────────────────────────────────────────────────

  /**
   * Submit a number to dial.
   * @param {object} opts
   * @param {string} opts.phoneNumber   E.164 or local format
   * @param {string} [opts.userId]      optional linked user id for history
   * @param {string} [opts.adminId]     who submitted
   * @param {string} [opts.message]     auto-message (informational; phone-call only)
   * @param {string} [opts.targetDialerId]  pin to a specific dialer
   */
  dispatch({ phoneNumber, userId, adminId, message, targetDialerId }) {
    if (!phoneNumber) throw new Error('phoneNumber required');
    const job = {
      jobId       : uuidv4(),
      phoneNumber : String(phoneNumber).trim(),
      userId      : userId  || null,
      adminId     : adminId || null,
      message     : message || null,
      targetDialerId: targetDialerId || null,
      state       : STATE.QUEUED,
      createdAt   : new Date().toISOString(),
      assignedDialerId: null,
      assignedSocketId: null,
      dispatchedAt: null,
      connectedAt : null,
      endedAt     : null,
      duration    : null,
      error       : null,
    };
    this.queue.push(job);
    logger.info('SIM-dial job queued', { jobId: job.jobId, phone: job.phoneNumber });
    this.emit('job:queued', job);
    this._drainQueue();
    return job;
  }

  /** Report from the phone — state change for an active job. */
  reportState(socketId, { jobId, state, duration, error }) {
    const job = this.activeJobs.get(jobId);
    if (!job) {
      logger.warn('State report for unknown job', { jobId, state });
      return null;
    }
    if (job.assignedSocketId !== socketId) {
      logger.warn('State report from wrong socket', { jobId, socketId });
      return null;
    }
    if (!Object.values(STATE).includes(state)) {
      logger.warn('Unknown state', { jobId, state });
      return null;
    }

    job.state = state;
    this.emit('job:state', { ...job });

    if (state === STATE.CONNECTED && !job.connectedAt) {
      job.connectedAt = new Date().toISOString();
    }

    const terminal = [STATE.ENDED, STATE.FAILED, STATE.NO_ANSWER, STATE.BUSY, STATE.TIMEOUT];
    if (terminal.includes(state)) {
      this._completeJob(jobId, state, { duration, error });
    }
    return job;
  }

  /** Admin/system cancels a job. */
  cancelJob(jobId, reason = 'cancelled') {
    const job = this.activeJobs.get(jobId);
    if (job) {
      this._completeJob(jobId, STATE.FAILED, { error: reason });
      return job;
    }
    const idx = this.queue.findIndex(j => j.jobId === jobId);
    if (idx >= 0) {
      const [removed] = this.queue.splice(idx, 1);
      removed.state = STATE.FAILED;
      removed.error = reason;
      removed.endedAt = new Date().toISOString();
      this._archive(removed);
      this.emit('job:cancelled', removed);
      return removed;
    }
    return null;
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  _drainQueue() {
    if (this.queue.length === 0) return;

    // Walk queue and try to assign each job to an idle dialer.
    for (let i = 0; i < this.queue.length; ) {
      const job = this.queue[i];
      const sid = this._pickDialer(job.targetDialerId);
      if (!sid) { i++; continue; }
      this.queue.splice(i, 1);
      this._assign(job, sid);
    }
  }

  _pickDialer(targetDialerId) {
    if (targetDialerId) {
      const sid = this.dialerById.get(targetDialerId);
      if (!sid) return null;
      const info = this.dialers.get(sid);
      return info && info.state === 'idle' ? sid : null;
    }
    // Round-robin over idle dialers
    const idle = [...this.dialers.entries()].filter(([, v]) => v.state === 'idle');
    if (idle.length === 0) return null;
    const [sid] = idle[this._rrCursor % idle.length];
    this._rrCursor = (this._rrCursor + 1) % Math.max(idle.length, 1);
    return sid;
  }

  _assign(job, socketId) {
    const info = this.dialers.get(socketId);
    if (!info) {
      // Dialer vanished — requeue
      this.queue.unshift(job);
      return;
    }
    info.state = 'busy';
    job.assignedSocketId = socketId;
    job.assignedDialerId = info.dialerId;
    job.state = STATE.DISPATCHED;
    job.dispatchedAt = new Date().toISOString();
    this.activeJobs.set(job.jobId, job);
    const timer = setTimeout(() => {
      if (this.activeJobs.has(job.jobId)) {
        logger.warn('Dialer job timed out', { jobId: job.jobId });
        this._completeJob(job.jobId, STATE.TIMEOUT, { error: 'no_state_report' });
      }
    }, JOB_TIMEOUT_MS);
    this._jobTimers.set(job.jobId, timer);
    logger.info('Job dispatched', { jobId: job.jobId, dialerId: info.dialerId, phone: job.phoneNumber });
    this.emit('job:dispatched', { ...job });
  }

  _completeJob(jobId, finalState, { duration, error } = {}) {
    const job = this.activeJobs.get(jobId);
    if (!job) return;
    const timer = this._jobTimers.get(jobId);
    if (timer) clearTimeout(timer);
    this._jobTimers.delete(jobId);

    job.state    = finalState;
    job.endedAt  = new Date().toISOString();
    job.duration = duration != null ? Number(duration) :
      (job.connectedAt ? Math.round((new Date(job.endedAt) - new Date(job.connectedAt)) / 1000) : 0);
    if (error) job.error = error;

    this.activeJobs.delete(jobId);
    // Free up dialer
    const info = this.dialers.get(job.assignedSocketId);
    if (info) info.state = 'idle';

    this._archive(job);
    logger.info('Job completed', { jobId, finalState, duration: job.duration });
    this.emit('job:completed', { ...job });
    this._drainQueue();
  }

  _archive(job) {
    this.history.unshift({ ...job });
    if (this.history.length > HISTORY_LIMIT) this.history.pop();
  }

  // ── Lookups ───────────────────────────────────────────────────────────────

  listDialers() {
    return [...this.dialers.entries()].map(([sid, info]) => ({
      socketId : sid, ...info,
    }));
  }
  getDialerSocket(dialerId) { return this.dialerById.get(dialerId); }
  listQueue()               { return [...this.queue]; }
  listActive()              { return [...this.activeJobs.values()]; }
  listHistory({ limit = 50, dialerId, state } = {}) {
    let h = this.history;
    if (dialerId) h = h.filter(j => j.assignedDialerId === dialerId);
    if (state)    h = h.filter(j => j.state === state);
    return h.slice(0, Number(limit) || 50);
  }
  getStats() {
    return {
      dialersOnline: this.dialers.size,
      idleDialers  : [...this.dialers.values()].filter(d => d.state === 'idle').length,
      queued       : this.queue.length,
      active       : this.activeJobs.size,
      historyTotal : this.history.length,
    };
  }
}

module.exports = new DialerManager();
module.exports.STATE = STATE;
