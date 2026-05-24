/**
 * rtpStream — single-direction RTP/AVP PCMU sender.
 *
 * • Binds a local UDP socket on a port from the configured pool.
 * • Sends 20 ms (160-sample) µ-law packets, paced by a setInterval timer.
 * • Latches the actual remote IP:port the first time we receive an RTP
 *   packet from the PBX, so subsequent packets target wherever the PBX is
 *   actually sending from — necessary when behind NAT.
 *
 * Use:
 *   const s = new RtpStream({ remoteHost, remotePort, payloadType: 0 });
 *   await s.bind();
 *   s.queue(muLawBuffer);   // any length, sliced into 20 ms packets
 *   s.on('finished', …);    // queue drained
 *   s.close();
 */
'use strict';

const dgram        = require('dgram');
const crypto       = require('crypto');
const EventEmitter = require('events');
const g711         = require('./muLaw');
const logger       = require('../utils/logger');

const PACKET_SAMPLES = 160;  // 20 ms @ 8 kHz
const PACKET_MS      = 20;

class RtpStream extends EventEmitter {
  constructor({ remoteHost, remotePort, payloadType = 0, localPortMin = 16000, localPortMax = 16100 }) {
    super();
    this.remoteHost = remoteHost;
    this.remotePort = remotePort;
    this.payloadType = payloadType;
    this.silenceByte = payloadType === 8 ? 0xd5 : 0xff;
    this.localPortMin = localPortMin;
    this.localPortMax = localPortMax;
    this.socket = null;
    this.localPort = 0;
    this.seq = Math.floor(Math.random() * 0xffff);
    this.timestamp = Math.floor(Math.random() * 0xffffffff);
    this.ssrc = crypto.randomBytes(4).readUInt32BE(0);
    this.queueBuf = Buffer.alloc(0);
    this.timer = null;
    this._startHr = 0n;        // hrtime when first packet went out
    this._packetsScheduled = 0; // how many packets we have promised to send
    this.bytesSent = 0;
    this.packetsSent = 0;
    this.bytesRecv = 0;
    this.latched = false;
    this.closed = false;
  }

  bind() {
    return new Promise((resolve, reject) => {
      const sock = dgram.createSocket('udp4');
      this.socket = sock;
      const tryPort = (p) => {
        if (p > this.localPortMax) return reject(new Error('No free RTP port'));
        sock.once('error', err => {
          if (err.code === 'EADDRINUSE') tryPort(p + 2); // RTP ports are even by convention
          else reject(err);
        });
        sock.bind(p, () => {
          this.localPort = p;
          sock.removeAllListeners('error');
          sock.on('error', e => { logger.warn('RTP socket error', { error: e.message }); });
          sock.on('message', (msg, rinfo) => this._onPacket(msg, rinfo));
          resolve(p);
        });
      };
      tryPort(this.localPortMin);
    });
  }

  _onPacket(msg, rinfo) {
    this.bytesRecv += msg.length;
    if (!this.latched && (rinfo.address !== this.remoteHost || rinfo.port !== this.remotePort)) {
      logger.info('RTP latch', { from: `${rinfo.address}:${rinfo.port}`, was: `${this.remoteHost}:${this.remotePort}` });
      this.remoteHost = rinfo.address;
      this.remotePort = rinfo.port;
    }
    this.latched = true;
    // Decode and emit incoming audio if anyone is listening.
    if (this.listenerCount('audio') > 0) this._emitDecoded(msg);
  }

  /** Strip the RTP header (incl. CSRC list + optional extension) and emit
   *  the payload as 8 kHz signed-16 PCM. Skips telephone-event (PT=101) and
   *  payloads whose PT doesn't match our negotiated G.711 codec. */
  _emitDecoded(msg) {
    if (msg.length < 12) return;
    const cc = msg[0] & 0x0f;
    const hasExt = (msg[0] & 0x10) !== 0;
    const pt = msg[1] & 0x7f;
    let off = 12 + cc * 4;
    if (hasExt) {
      if (msg.length < off + 4) return;
      const extLen = msg.readUInt16BE(off + 2);
      off += 4 + extLen * 4;
    }
    if (off >= msg.length) return;
    // Only decode the codec the dialog negotiated. Ignore DTMF / comfort noise.
    if (pt !== 0 && pt !== 8) return;
    const payload = msg.subarray(off);
    const pcm = g711.decodeBufferFor(pt, payload);
    this.emit('audio', pcm);
  }

  queue(muLawBuf) {
    this.queueBuf = Buffer.concat([this.queueBuf, muLawBuf]);
    this._ensureTimer();
  }

  /** Drop everything we haven't sent yet (used to interrupt TTS playback). */
  clearQueue() {
    this.queueBuf = Buffer.alloc(0);
  }

  /** Append silence (codec-appropriate) to keep RTP flowing — some carriers tear
   *  down the call if no packets arrive for ~10 s. */
  appendSilence(ms) {
    const n = Math.floor((ms / 1000) * 8000);
    const buf = Buffer.alloc(n, this.silenceByte);
    this.queue(buf);
  }

  _ensureTimer() {
    if (this.timer || this.closed) return;
    this._startHr = process.hrtime.bigint();
    this._packetsScheduled = 0;
    this._scheduleNext();
  }

  /**
   * Drift-corrected scheduler: anchors each packet to a fixed grid relative to
   * the stream's start time, so Windows' coarse 15ms timer resolution and GC
   * pauses can't make the audio pile up or gap. If we ever fall behind by more
   * than one packet, _tick fires immediately to catch up.
   */
  _scheduleNext() {
    if (this.closed) return;
    const targetNs = this._startHr + BigInt(this._packetsScheduled * PACKET_MS) * 1_000_000n;
    const nowNs = process.hrtime.bigint();
    let delayMs = Number((targetNs - nowNs) / 1_000_000n);
    if (delayMs < 0) delayMs = 0;
    this.timer = setTimeout(() => {
      this.timer = null;
      this._tick();
      this._packetsScheduled++;
      if (this.closed) return;
      // Catch-up loop: if we owe more packets, send them back-to-back.
      while (!this.closed && this.queueBuf.length >= PACKET_SAMPLES) {
        const owedNs = process.hrtime.bigint() - (this._startHr + BigInt(this._packetsScheduled * PACKET_MS) * 1_000_000n);
        if (owedNs <= 0n) break;
        this._tick();
        this._packetsScheduled++;
      }
      if (!this.timer) this._scheduleNext();
    }, delayMs);
  }

  _tick() {
    if (this.closed) return;
    if (this.queueBuf.length < PACKET_SAMPLES) {
      if (this.queueBuf.length > 0) {
        const pad = Buffer.alloc(PACKET_SAMPLES - this.queueBuf.length, this.silenceByte);
        this.queueBuf = Buffer.concat([this.queueBuf, pad]);
      } else {
        // Nothing to send — stop the scheduler and signal queue drained.
        if (this.timer) { clearTimeout(this.timer); this.timer = null; }
        this.emit('finished');
        return;
      }
    }
    const payload = this.queueBuf.subarray(0, PACKET_SAMPLES);
    this.queueBuf = this.queueBuf.subarray(PACKET_SAMPLES);
    this._sendPacket(payload);
  }

  _sendPacket(payload) {
    const header = Buffer.alloc(12);
    header[0] = 0x80;                               // V=2, P=0, X=0, CC=0
    header[1] = this.payloadType & 0x7f;            // M=0, PT
    header.writeUInt16BE(this.seq & 0xffff, 2);
    header.writeUInt32BE(this.timestamp >>> 0, 4);
    header.writeUInt32BE(this.ssrc >>> 0, 8);
    const pkt = Buffer.concat([header, payload]);
    this.socket.send(pkt, this.remotePort, this.remoteHost, err => {
      if (err) logger.warn('RTP send err', { error: err.message });
    });
    this.seq = (this.seq + 1) & 0xffff;
    this.timestamp = (this.timestamp + PACKET_SAMPLES) >>> 0;
    this.bytesSent += pkt.length;
    this.packetsSent++;
  }

  stats() {
    return {
      localPort: this.localPort,
      remote: `${this.remoteHost}:${this.remotePort}`,
      packetsSent: this.packetsSent,
      bytesSent: this.bytesSent,
      bytesRecv: this.bytesRecv,
      latched: this.latched,
      queueRemainingMs: Math.round(this.queueBuf.length / 8),
    };
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    try { this.socket.close(); } catch {}
  }
}

module.exports = RtpStream;
