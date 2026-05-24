/**
 * sipAgent — minimal SIP UA over UDP.
 *
 * Capabilities:
 *  • REGISTER (with digest auth, periodic refresh)
 *  • Outbound INVITE → ACK → BYE flow (with digest auth on 401/407)
 *  • Handles inbound BYE (sends 200 OK)
 *  • Single concurrent call (MVP — extend the dialogs map for multi-call)
 *
 * This is a focused implementation, not a full RFC 3261 stack. It handles
 * the cases needed to place an outbound voice-agent call against a hosted
 * Asterisk-class PBX (cloudpbx.kotha.com.bd). NAT traversal relies on
 * ;rport (RFC 3581) and downstream RTP latching.
 */
'use strict';

const dgram        = require('dgram');
const dns          = require('dns').promises;
const os           = require('os');
const crypto       = require('crypto');
const EventEmitter = require('events');
const logger       = require('../utils/logger');

const CRLF = '\r\n';
const VERSION = 'SIP/2.0';
const USER_AGENT = 'AutoCall-VoiceAgent/1.0';

const md5    = s => crypto.createHash('md5').update(s).digest('hex');
const rndHex = n => crypto.randomBytes(n).toString('hex');

function genBranch() { return 'z9hG4bK-' + rndHex(8); }
function genTag()    { return rndHex(5); }

function pickLocalIPv4() {
  if (process.env.SIP_LOCAL_IP) return process.env.SIP_LOCAL_IP;
  const ifs = os.networkInterfaces();
  const candidates = [];
  for (const [name, list] of Object.entries(ifs)) {
    for (const x of list || []) {
      if (x.family !== 'IPv4' || x.internal) continue;
      if (x.address.startsWith('169.254.')) continue; // APIPA
      if (/vEthernet|VirtualBox|VMware|WSL|Hyper-V|Loopback|Bluetooth/i.test(name)) continue;
      candidates.push(x.address);
    }
  }
  // Prefer common LAN ranges
  const lan = candidates.find(a => /^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a));
  return lan || candidates[0] || '127.0.0.1';
}

/**
 * Discover the local IPv4 the OS would use to reach `remoteHost`.
 * Uses a connected UDP socket trick — no packets are sent.
 */
function discoverLocalIpFor(remoteHost, remotePort = 5060) {
  return new Promise((resolve) => {
    const s = dgram.createSocket('udp4');
    let done = false;
    const finish = (addr) => { if (done) return; done = true; try { s.close(); } catch {} resolve(addr); };
    s.on('error', () => finish(null));
    try {
      s.connect(remotePort, remoteHost, (err) => {
        if (err) return finish(null);
        try { finish(s.address().address); } catch { finish(null); }
      });
    } catch { finish(null); }
  });
}

function parseQuotedParams(s) {
  // Parses `realm="x", nonce="y", qop=auth, …` into an object.
  const out = {};
  s.replace(/(\w[\w-]*)=(?:"([^"]*)"|([^,\s]+))/g, (_, k, q, u) => {
    out[k.toLowerCase()] = q !== undefined ? q : u;
  });
  return out;
}

function parseMessage(raw) {
  const text = raw.toString('utf8');
  const sep = text.indexOf(CRLF + CRLF);
  const headPart = sep >= 0 ? text.slice(0, sep) : text;
  const body     = sep >= 0 ? text.slice(sep + 4) : '';
  const lines = headPart.split(CRLF);
  const start = lines.shift() || '';
  const m = { headers: {}, body };
  if (start.startsWith(VERSION + ' ')) {
    const sp = start.indexOf(' ', VERSION.length + 1);
    m.statusCode = parseInt(start.slice(VERSION.length + 1, sp), 10);
    m.reason     = start.slice(sp + 1);
  } else {
    const parts = start.split(' ');
    m.method = parts[0];
    m.uri    = parts[1];
  }
  let curKey = null;
  for (const raw of lines) {
    if (!raw) continue;
    if (/^\s/.test(raw) && curKey) { m.headers[curKey] += ' ' + raw.trim(); continue; }
    const ci = raw.indexOf(':');
    if (ci < 0) continue;
    const k = raw.slice(0, ci).trim().toLowerCase();
    const v = raw.slice(ci + 1).trim();
    curKey = k;
    if (m.headers[k] === undefined) m.headers[k] = v;
    else m.headers[k] = Array.isArray(m.headers[k]) ? [...m.headers[k], v] : [m.headers[k], v];
  }
  return m;
}

function buildDigest({ user, password, method, uri, challengeHeader }) {
  // challengeHeader e.g.  Digest realm="…", nonce="…", algorithm=MD5, qop="auth"
  const idx = challengeHeader.toLowerCase().indexOf('digest');
  const body = idx >= 0 ? challengeHeader.slice(idx + 6).trim() : challengeHeader;
  const p = parseQuotedParams(body);
  const realm = p.realm || '';
  const nonce = p.nonce || '';
  const algorithm = p.algorithm || 'MD5';
  const ha1 = md5(`${user}:${realm}:${password}`);
  const ha2 = md5(`${method}:${uri}`);
  let qop = p.qop;
  if (qop && qop.includes(',')) qop = qop.split(',').map(x => x.trim()).includes('auth') ? 'auth' : qop.split(',')[0].trim();
  const cnonce = rndHex(8);
  const nc = '00000001';
  const response = qop
    ? md5(`${ha1}:${nonce}:${nc}:${cnonce}:${qop}:${ha2}`)
    : md5(`${ha1}:${nonce}:${ha2}`);
  let h = `Digest username="${user}", realm="${realm}", nonce="${nonce}", uri="${uri}", response="${response}", algorithm=${algorithm}`;
  if (p.opaque) h += `, opaque="${p.opaque}"`;
  if (qop)      h += `, qop=${qop}, nc=${nc}, cnonce="${cnonce}"`;
  return h;
}

// ─── SIP Agent ───────────────────────────────────────────────────────────────

class SipAgent extends EventEmitter {
  constructor(cfg) {
    super();
    this.cfg = {
      host:         cfg.host,
      port:         cfg.port         || 5060,
      extension:    cfg.extension,
      authUser:     cfg.authUser     || cfg.extension,
      password:     cfg.password,
      displayName:  cfg.displayName  || cfg.extension,
      realm:        cfg.realm        || cfg.host,
      localPort:    Number(cfg.localPort || process.env.SIP_LOCAL_PORT || 5070),
      localIp:      cfg.localIp      || pickLocalIPv4(),
      expires:      Number(cfg.expires || 600),
    };
    this.socket = null;
    this.remoteIp = null;
    this.registered = false;
    this.registerTimer = null;
    this.cseq = { REGISTER: 1, INVITE: 1, BYE: 1, ACK: 1 };
    this.callIdRegister = `${rndHex(8)}@${this.cfg.localIp}`;
    this.activeCall = null;        // Call instance
    this.pending = new Map();      // key: callId+'|'+method → { resolve, reject, request }
    this.lastError = null;
  }

  async start() {
    this.remoteIp = (await dns.lookup(this.cfg.host)).address;
    logger.info('SIP resolve', { host: this.cfg.host, ip: this.remoteIp });
    // Re-discover local IP using the OS's routing table for the PBX.
    // Only override if user didn't pin SIP_LOCAL_IP explicitly.
    if (!process.env.SIP_LOCAL_IP) {
      const discovered = await discoverLocalIpFor(this.remoteIp, this.cfg.port);
      if (discovered && !discovered.startsWith('169.254.') && discovered !== '0.0.0.0') {
        if (discovered !== this.cfg.localIp) {
          logger.info('SIP local IP updated', { from: this.cfg.localIp, to: discovered });
          this.cfg.localIp = discovered;
          this.callIdRegister = `${rndHex(8)}@${this.cfg.localIp}`;
        }
      }
    }
    await this._bind();
    await this._register();
    this.registerTimer = setInterval(() => this._register().catch(e => {
      logger.warn('SIP re-REGISTER failed', { error: e.message });
    }), Math.max(60_000, this.cfg.expires * 500));
  }

  async stop() {
    if (this.registerTimer) clearInterval(this.registerTimer);
    if (this.activeCall) { try { await this.activeCall.hangup(); } catch {} }
    try { await this._register({ expires: 0 }); } catch {}
    try { this.socket?.close(); } catch {}
    this.socket = null;
    this.registered = false;
  }

  _bind() {
    return new Promise((resolve, reject) => {
      const sock = dgram.createSocket('udp4');
      sock.on('error', e => { logger.error('SIP socket error', { error: e.message }); });
      sock.on('message', (msg, rinfo) => this._onMessage(msg, rinfo));
      sock.bind(this.cfg.localPort, () => {
        const addr = sock.address();
        this.cfg.localPort = addr.port;
        this.socket = sock;
        logger.info('SIP bound', { addr: `${addr.address}:${addr.port}` });
        resolve();
      });
      sock.once('error', reject);
    });
  }

  // ─── outgoing ─────────────────────────────────────────────────────────────

  _send(msgText) {
    const buf = Buffer.from(msgText, 'utf8');
    this.socket.send(buf, this.cfg.port, this.remoteIp, err => {
      if (err) logger.warn('SIP send err', { error: err.message });
    });
    logger.debug('SIP →', { firstLine: msgText.split(CRLF)[0] });
  }

  _buildRequest({ method, uri, headers, body }) {
    const baseHeaders = {
      'Max-Forwards': '70',
      'User-Agent':   USER_AGENT,
      ...headers,
    };
    if (body) {
      baseHeaders['Content-Length'] = String(Buffer.byteLength(body, 'utf8'));
    } else {
      baseHeaders['Content-Length'] = '0';
    }
    const lines = [`${method} ${uri} ${VERSION}`];
    for (const [k, v] of Object.entries(baseHeaders)) {
      if (Array.isArray(v)) for (const item of v) lines.push(`${k}: ${item}`);
      else                  lines.push(`${k}: ${v}`);
    }
    return lines.join(CRLF) + CRLF + CRLF + (body || '');
  }

  _commonHeaders({ method, branch, callId, fromTag, toTag, cseqNum, contactUri, targetAor }) {
    const cfg = this.cfg;
    const via = `SIP/2.0/UDP ${cfg.localIp}:${cfg.localPort};rport;branch=${branch}`;
    const fromUri = `<sip:${cfg.extension}@${cfg.host}>`;
    const headers = {
      Via:       via,
      From:      `"${cfg.displayName}" ${fromUri};tag=${fromTag}`,
      To:        toTag ? `<${targetAor}>;tag=${toTag}` : `<${targetAor}>`,
      'Call-ID': callId,
      CSeq:      `${cseqNum} ${method}`,
      Contact:   `<sip:${cfg.extension}@${cfg.localIp}:${cfg.localPort}>`,
    };
    return headers;
  }

  // ─── REGISTER ────────────────────────────────────────────────────────────

  async _register({ expires } = {}) {
    const cfg = this.cfg;
    const exp = expires !== undefined ? expires : cfg.expires;
    const branch = genBranch();
    const fromTag = genTag();
    const cseqNum = this.cseq.REGISTER++;
    const targetAor = `sip:${cfg.extension}@${cfg.host}`;
    const uri = `sip:${cfg.host}`;

    const sendOne = (authHeader) => new Promise((resolve, reject) => {
      const headers = this._commonHeaders({
        method: 'REGISTER', branch: authHeader ? genBranch() : branch,
        callId: this.callIdRegister, fromTag, cseqNum: authHeader ? this.cseq.REGISTER++ : cseqNum,
        targetAor,
      });
      headers.Expires = String(exp);
      if (authHeader) headers.Authorization = authHeader;
      const msg = this._buildRequest({ method: 'REGISTER', uri, headers });
      const key = `${this.callIdRegister}|REGISTER`;
      this.pending.set(key, { resolve, reject, t0: Date.now() });
      this._send(msg);
      setTimeout(() => {
        if (this.pending.get(key)?.resolve === resolve) {
          this.pending.delete(key);
          reject(new Error('REGISTER timeout'));
        }
      }, 8000);
    });

    let resp = await sendOne(null);
    if (resp.statusCode === 401 || resp.statusCode === 407) {
      const challenge = resp.headers['www-authenticate'] || resp.headers['proxy-authenticate'];
      if (!challenge) throw new Error('Auth challenge missing header');
      const auth = buildDigest({
        user: cfg.authUser, password: cfg.password,
        method: 'REGISTER', uri, challengeHeader: Array.isArray(challenge) ? challenge[0] : challenge,
      });
      resp = await sendOne(auth);
    }
    if (resp.statusCode >= 200 && resp.statusCode < 300) {
      const becameRegistered = !this.registered;
      this.registered = exp > 0;
      this.lastError = null;
      logger.info('SIP REGISTER ok', { expires: exp });
      if (becameRegistered && exp > 0) this.emit('registered');
      if (exp === 0) this.emit('unregistered');
    } else {
      this.registered = false;
      this.lastError = `REGISTER ${resp.statusCode} ${resp.reason}`;
      logger.error('SIP REGISTER failed', { status: resp.statusCode, reason: resp.reason });
      throw new Error(this.lastError);
    }
  }

  // ─── INVITE / Call ───────────────────────────────────────────────────────

  async invite(targetNumber, { rtpLocalPort, codecs = [
      { pt: 0, name: 'PCMU', rate: 8000 },
      { pt: 8, name: 'PCMA', rate: 8000 },
    ] } = {}) {
    if (!this.registered) throw new Error('SIP not registered');
    if (this.activeCall) throw new Error('Another call is already active');
    const cfg = this.cfg;

    const call = new Call({
      agent: this,
      number: targetNumber,
      rtpLocalPort,
      codecs,
    });
    this.activeCall = call;
    call.once('terminated', () => { if (this.activeCall === call) this.activeCall = null; });
    // Kick off the INVITE transaction but do NOT await its final response —
    // otherwise the caller can't attach 'ringing'/'answered' listeners in time
    // and the 200 OK fires before anyone is listening.
    call._sendInvite().catch(err => {
      logger.warn('INVITE transaction error', { error: err.message });
    });
    return call;
  }

  // ─── inbound handling ────────────────────────────────────────────────────

  _onMessage(buf, rinfo) {
    let m;
    try { m = parseMessage(buf); } catch (e) { return; }
    logger.debug('SIP ←', { first: m.statusCode ? `${m.statusCode} ${m.reason}` : `${m.method} ${m.uri}` });

    const callId = m.headers['call-id'];
    if (!callId) return;

    if (m.statusCode) {
      // Response.
      const cseqHdr = m.headers.cseq || '';
      const method  = cseqHdr.split(/\s+/)[1];
      const key = `${callId}|${method}`;
      const p = this.pending.get(key);
      if (p) {
        // Interim responses: pass through but don't resolve until final.
        if (m.statusCode < 200) {
          if (this.activeCall && callId === this.activeCall.callId) {
            this.activeCall._onProvisional(m);
          }
          return;
        }
        this.pending.delete(key);
        p.resolve(m);
        return;
      }
      // Active-call response without pending (rare — out-of-order).
      if (this.activeCall && callId === this.activeCall.callId) {
        this.activeCall._onResponse(m);
      }
    } else {
      // Request.
      if (m.method === 'BYE') {
        this._respond(m, 200, 'OK');
        if (this.activeCall && callId === this.activeCall.callId) {
          this.activeCall._onRemoteBye();
        }
      } else if (m.method === 'INVITE') {
        this._onInvite(m, rinfo);
      } else if (m.method === 'OPTIONS') {
        this._respond(m, 200, 'OK');
      } else if (m.method === 'ACK') {
        if (this.activeCall && callId === this.activeCall.callId
            && typeof this.activeCall._onAck === 'function') {
          this.activeCall._onAck(m);
        }
      } else if (m.method === 'CANCEL') {
        // CANCEL the in-progress inbound INVITE.
        this._respond(m, 200, 'OK');
        if (this.activeCall && callId === this.activeCall.callId
            && typeof this.activeCall._onRemoteCancel === 'function') {
          this.activeCall._onRemoteCancel(m);
        }
      } else if (m.method === 'NOTIFY' || m.method === 'INFO') {
        this._respond(m, 200, 'OK');
      } else {
        this._respond(m, 405, 'Method Not Allowed');
      }
    }
  }

  _onInvite(req, rinfo) {
    const callId = req.headers['call-id'];
    // Duplicate INVITE retransmission for the in-progress inbound call:
    // resend the last response so the PBX stops retransmitting.
    if (this.activeCall && this.activeCall.callId === callId
        && this.activeCall instanceof InboundCall) {
      this.activeCall._resendLastResponse();
      return;
    }
    if (this.activeCall) {
      this._respond(req, 486, 'Busy Here');
      return;
    }
    // Immediately stop INVITE retransmissions.
    this._respond(req, 100, 'Trying');

    const call = new InboundCall({ agent: this, request: req, rinfo });
    this.activeCall = call;
    call.once('terminated', () => { if (this.activeCall === call) this.activeCall = null; });
    logger.info('SIP inbound INVITE', {
      from: call.fromNumber, to: call.toNumber, callId,
    });
    this.emit('incomingCall', call);
    // Listeners are usually attached synchronously, but in case none are,
    // auto-reject after a short grace so we don't leak.
    setImmediate(() => {
      if (call.state === 'inviting' && this.listenerCount('incomingCall') === 0) {
        call.reject(603, 'Decline');
      }
    });
  }

  _respond(req, code, reason, extraHeaders = {}) {
    const headers = {};
    for (const h of ['via','from','to','call-id','cseq']) {
      if (req.headers[h] !== undefined) headers[h.replace(/(^|-)\w/g, c => c.toUpperCase())] = req.headers[h];
    }
    headers['User-Agent'] = USER_AGENT;
    headers['Content-Length'] = '0';
    Object.assign(headers, extraHeaders);
    const lines = [`${VERSION} ${code} ${reason}`];
    for (const [k, v] of Object.entries(headers)) lines.push(`${k}: ${v}`);
    this._send(lines.join(CRLF) + CRLF + CRLF);
  }

  status() {
    return {
      registered: this.registered,
      lastError: this.lastError,
      localIp: this.cfg.localIp,
      localPort: this.cfg.localPort,
      remote: `${this.cfg.host}:${this.cfg.port} (${this.remoteIp})`,
      activeCall: this.activeCall ? this.activeCall.summary() : null,
    };
  }
}

// ─── Call ────────────────────────────────────────────────────────────────────

class Call extends EventEmitter {
  constructor({ agent, number, rtpLocalPort, codecs }) {
    super();
    this.agent = agent;
    this.number = number;
    this.rtpLocalPort = rtpLocalPort;
    this.codecs = codecs;
    this.callId = `${rndHex(8)}@${agent.cfg.localIp}`;
    this.fromTag = genTag();
    this.toTag = null;
    this.branchInvite = genBranch();
    this.cseqInvite = agent.cseq.INVITE++;
    this.targetAor = `sip:${number}@${agent.cfg.host}`;
    this.uri = this.targetAor;
    this.remoteSdp = null;
    this.remoteRtp = null;  // { host, port }
    this.startedAt = Date.now();
    this.state = 'inviting';   // inviting → ringing → live → ended
    this.duration = 0;
    this._inviteAuthTried = false;
    this._remoteRouteSet = false;
    this._remoteContact = null;
  }

  _buildSdp() {
    const ip = this.agent.cfg.localIp;
    const port = this.rtpLocalPort;
    const pts = this.codecs.map(c => c.pt).join(' ');
    const rtpmap = this.codecs.map(c => `a=rtpmap:${c.pt} ${c.name}/${c.rate}`).join(CRLF);
    return [
      'v=0',
      `o=- ${Date.now()} ${Date.now()} IN IP4 ${ip}`,
      's=AutoCall',
      `c=IN IP4 ${ip}`,
      't=0 0',
      `m=audio ${port} RTP/AVP ${pts} 101`,
      rtpmap,
      'a=rtpmap:101 telephone-event/8000',
      'a=fmtp:101 0-16',
      'a=ptime:20',
      'a=sendrecv',
    ].join(CRLF) + CRLF;
  }

  /**
   * Parse `m=audio <port> RTP/AVP <pt list>`, the first `c=IN IP4 <ip>`,
   * and `a=rtpmap:<pt> NAME/rate` from remote SDP. Returns:
   *   { host, port, payloadType, codec }
   * where payloadType is the FIRST static-G.711 codec the PBX accepted
   * (PCMU=0 or PCMA=8) — the one we should encode our outbound audio with.
   */
  _parseRemoteSdp(sdp) {
    const lines = sdp.split(/\r?\n/);
    let host = null, port = null, ptList = [];
    const rtpmap = {}; // pt → name
    for (const l of lines) {
      const c = l.match(/^c=IN IP4 (\S+)/);
      if (c && !host) host = c[1];
      const m = l.match(/^m=audio (\d+) RTP\/AVP (.+)$/);
      if (m && !port) {
        port = parseInt(m[1], 10);
        ptList = m[2].trim().split(/\s+/).map(x => parseInt(x, 10));
      }
      const rm = l.match(/^a=rtpmap:(\d+) ([A-Za-z0-9-]+)\/(\d+)/);
      if (rm) rtpmap[parseInt(rm[1], 10)] = rm[2].toUpperCase();
    }
    if (!host || !port) return null;
    // Pick the first G.711 PT the PBX listed; default to 0 (PCMU) if both absent.
    let payloadType = 0, codec = 'PCMU';
    const firstAudio = ptList.find(pt => pt === 0 || pt === 8 || (rtpmap[pt] && /PCMU|PCMA/.test(rtpmap[pt])));
    if (firstAudio !== undefined) {
      payloadType = firstAudio;
      codec = rtpmap[firstAudio] || (firstAudio === 8 ? 'PCMA' : 'PCMU');
    }
    return { host, port, payloadType, codec };
  }

  async _sendInvite(authHeader) {
    const agent = this.agent;
    const body = this._buildSdp();
    const headers = agent._commonHeaders({
      method: 'INVITE',
      branch: authHeader ? genBranch() : this.branchInvite,
      callId: this.callId,
      fromTag: this.fromTag,
      cseqNum: authHeader ? agent.cseq.INVITE++ : this.cseqInvite,
      targetAor: this.targetAor,
    });
    headers['Content-Type'] = 'application/sdp';
    headers.Allow = 'INVITE, ACK, CANCEL, BYE, OPTIONS, INFO';
    headers['Supported'] = 'replaces';
    if (authHeader) {
      // proxy vs www auth disambiguation: use Proxy-Authorization if we got 407, else Authorization.
      headers[this._lastAuthHeaderName || 'Authorization'] = authHeader;
    }
    const msg = agent._buildRequest({ method: 'INVITE', uri: this.uri, headers, body });
    const key = `${this.callId}|INVITE`;
    return new Promise((resolve, reject) => {
      agent.pending.set(key, {
        resolve: (resp) => this._handleInviteFinal(resp).then(resolve, reject),
        reject,
        t0: Date.now(),
      });
      agent._send(msg);
      setTimeout(() => {
        const p = agent.pending.get(key);
        if (p && p.t0 === undefined) return;
        if (p) {
          agent.pending.delete(key);
          if (this.state === 'inviting' || this.state === 'ringing') {
            this._fail('INVITE timeout');
          }
        }
      }, 30_000);
    });
  }

  async _handleInviteFinal(resp) {
    if (resp.statusCode === 401 || resp.statusCode === 407) {
      // ACK the failure response first (per RFC for non-2xx final INVITE responses).
      this._sendAckForNonOk(resp);
      if (this._inviteAuthTried) return this._fail(`auth retry failed: ${resp.statusCode}`);
      this._inviteAuthTried = true;
      const challenge = resp.headers['proxy-authenticate'] || resp.headers['www-authenticate'];
      if (!challenge) return this._fail('auth challenge missing header');
      this._lastAuthHeaderName = resp.statusCode === 407 ? 'Proxy-Authorization' : 'Authorization';
      const auth = buildDigest({
        user: this.agent.cfg.authUser,
        password: this.agent.cfg.password,
        method: 'INVITE', uri: this.uri,
        challengeHeader: Array.isArray(challenge) ? challenge[0] : challenge,
      });
      return this._sendInvite(auth);
    }
    if (resp.statusCode >= 200 && resp.statusCode < 300) {
      // Extract to-tag, remote SDP, remote Contact.
      const toHdr = resp.headers.to || '';
      const tagMatch = toHdr.match(/tag=([^;]+)/);
      if (tagMatch) this.toTag = tagMatch[1];
      this._remoteContact = resp.headers.contact || null;
      if (resp.body) {
        this.remoteSdp = resp.body;
        this.remoteRtp = this._parseRemoteSdp(resp.body);
        logger.debug('SIP answer SDP', { body: resp.body });
      }
      this._sendAckForOk(resp);
      this.state = 'live';
      logger.info('SIP call answered', { to: this.number, rtp: this.remoteRtp });
      this.emit('answered', { remoteRtp: this.remoteRtp, remoteSdp: this.remoteSdp });
      return;
    }
    // Final non-2xx, non-auth → ACK + fail.
    this._sendAckForNonOk(resp);
    this._fail(`${resp.statusCode} ${resp.reason}`);
  }

  _onProvisional(resp) {
    if (resp.statusCode === 180 || resp.statusCode === 183) {
      if (this.state !== 'ringing') {
        this.state = 'ringing';
        this.emit('ringing');
        logger.info('SIP ringing', { to: this.number });
      }
    }
  }

  _onResponse(resp) {
    // Catch-all for stray out-of-pending responses.
    if (resp.statusCode >= 200 && resp.statusCode < 300 && resp.body && !this.remoteRtp) {
      this.remoteSdp = resp.body;
      this.remoteRtp = this._parseRemoteSdp(resp.body);
    }
  }

  _onRemoteBye() {
    this.duration = Math.round((Date.now() - this.startedAt) / 1000);
    this.state = 'ended';
    logger.info('SIP call BYE from remote', { duration: this.duration });
    this.emit('ended', { reason: 'remote_bye', duration: this.duration });
    this.emit('terminated');
  }

  _fail(reason) {
    if (this.state === 'ended') return;
    this.state = 'ended';
    logger.warn('SIP call failed', { reason });
    this.emit('failed', { reason });
    this.emit('terminated');
  }

  _sendAckForNonOk(resp) {
    // For non-2xx final responses, ACK is part of the INVITE transaction:
    // same Via branch, same CSeq number, same Call-ID, To with tag from response.
    const agent = this.agent;
    const toHdr = resp.headers.to || `<${this.targetAor}>`;
    const headers = {
      Via:       resp.headers.via || `SIP/2.0/UDP ${agent.cfg.localIp}:${agent.cfg.localPort};rport;branch=${this.branchInvite}`,
      From:      resp.headers.from,
      To:        toHdr,
      'Call-ID': this.callId,
      CSeq:      `${this.cseqInvite} ACK`,
      'Max-Forwards': '70',
      'User-Agent':   USER_AGENT,
      'Content-Length': '0',
    };
    const lines = [`ACK ${this.uri} ${VERSION}`];
    for (const [k, v] of Object.entries(headers)) lines.push(`${k}: ${v}`);
    agent._send(lines.join(CRLF) + CRLF + CRLF);
  }

  _sendAckForOk(resp) {
    // For 2xx, ACK is a new transaction: fresh Via branch, target the remote Contact URI.
    const agent = this.agent;
    const contactUri = this._extractContactUri(resp.headers.contact) || this.uri;
    const toHdr = resp.headers.to;
    const fromHdr = resp.headers.from;
    const headers = {
      Via:       `SIP/2.0/UDP ${agent.cfg.localIp}:${agent.cfg.localPort};rport;branch=${genBranch()}`,
      From:      fromHdr,
      To:        toHdr,
      'Call-ID': this.callId,
      CSeq:      `${this.cseqInvite} ACK`,
      'Max-Forwards': '70',
      'User-Agent':   USER_AGENT,
      'Content-Length': '0',
    };
    const lines = [`ACK ${contactUri} ${VERSION}`];
    for (const [k, v] of Object.entries(headers)) lines.push(`${k}: ${v}`);
    agent._send(lines.join(CRLF) + CRLF + CRLF);
  }

  _extractContactUri(contact) {
    if (!contact) return null;
    const m = (Array.isArray(contact) ? contact[0] : contact).match(/<([^>]+)>/);
    return m ? m[1] : null;
  }

  async hangup() {
    if (this.state === 'ended') return;
    const wasLive = this.state === 'live';
    this.duration = Math.round((Date.now() - this.startedAt) / 1000);
    this.state = 'ended';

    if (wasLive) {
      // Send BYE.
      await this._sendBye();
    } else {
      // Send CANCEL for in-progress INVITE.
      this._sendCancel();
    }
    this.emit('ended', { reason: 'local_hangup', duration: this.duration });
    this.emit('terminated');
  }

  _sendCancel() {
    const agent = this.agent;
    const lines = [
      `CANCEL ${this.uri} ${VERSION}`,
      `Via: SIP/2.0/UDP ${agent.cfg.localIp}:${agent.cfg.localPort};rport;branch=${this.branchInvite}`,
      `From: "${agent.cfg.displayName}" <sip:${agent.cfg.extension}@${agent.cfg.host}>;tag=${this.fromTag}`,
      `To: <${this.targetAor}>`,
      `Call-ID: ${this.callId}`,
      `CSeq: ${this.cseqInvite} CANCEL`,
      'Max-Forwards: 70',
      `User-Agent: ${USER_AGENT}`,
      'Content-Length: 0',
    ];
    agent._send(lines.join(CRLF) + CRLF + CRLF);
  }

  async _sendBye(authHeader) {
    const agent = this.agent;
    const contactUri = this._extractContactUri(this._remoteContact) || this.uri;
    const cseqNum = agent.cseq.BYE++;
    const headers = {
      Via:       `SIP/2.0/UDP ${agent.cfg.localIp}:${agent.cfg.localPort};rport;branch=${genBranch()}`,
      From:      `"${agent.cfg.displayName}" <sip:${agent.cfg.extension}@${agent.cfg.host}>;tag=${this.fromTag}`,
      To:        `<${this.targetAor}>;tag=${this.toTag || ''}`,
      'Call-ID': this.callId,
      CSeq:      `${cseqNum} BYE`,
      'Max-Forwards': '70',
      'User-Agent':   USER_AGENT,
      'Content-Length': '0',
    };
    if (authHeader) headers[this._byeAuthHeaderName || 'Authorization'] = authHeader;
    const lines = [`BYE ${contactUri} ${VERSION}`];
    for (const [k, v] of Object.entries(headers)) lines.push(`${k}: ${v}`);
    const msg = lines.join(CRLF) + CRLF + CRLF;
    const key = `${this.callId}|BYE`;
    return new Promise((resolve) => {
      agent.pending.set(key, {
        resolve: async (resp) => {
          if ((resp.statusCode === 401 || resp.statusCode === 407) && !this._byeAuthTried) {
            this._byeAuthTried = true;
            const ch = resp.headers['proxy-authenticate'] || resp.headers['www-authenticate'];
            if (ch) {
              this._byeAuthHeaderName = resp.statusCode === 407 ? 'Proxy-Authorization' : 'Authorization';
              const auth = buildDigest({
                user: agent.cfg.authUser, password: agent.cfg.password,
                method: 'BYE', uri: contactUri,
                challengeHeader: Array.isArray(ch) ? ch[0] : ch,
              });
              await this._sendBye(auth);
            }
          }
          resolve();
        },
        reject: () => resolve(),
        t0: Date.now(),
      });
      agent._send(msg);
      setTimeout(() => { agent.pending.delete(key); resolve(); }, 5000);
    });
  }

  summary() {
    return {
      callId: this.callId,
      number: this.number,
      state: this.state,
      remoteRtp: this.remoteRtp,
      duration: this.duration || Math.round((Date.now() - this.startedAt) / 1000),
    };
  }
}

// ─── InboundCall ─────────────────────────────────────────────────────────────
// UAS side: we received an INVITE and will answer it.

function parseAorUser(header) {
  if (!header) return '';
  const m = String(header).match(/sips?:([^@>;\s]+)/i);
  return m ? m[1] : '';
}

class InboundCall extends EventEmitter {
  constructor({ agent, request, rinfo }) {
    super();
    this.agent     = agent;
    this.request   = request;
    this.rinfo     = rinfo;
    this.callId    = request.headers['call-id'];
    this.fromHdr   = request.headers.from;
    this.toHdr     = request.headers.to;
    this.viaHdr    = request.headers.via;
    this.cseqHdr   = request.headers.cseq;
    this.cseqNum   = parseInt((this.cseqHdr || '0').split(/\s+/)[0], 10) || 0;
    const fromTagM = String(this.fromHdr).match(/tag=([^;>\s]+)/);
    this.remoteTag = fromTagM ? fromTagM[1] : '';
    this.localTag  = genTag();
    this.fromNumber = parseAorUser(this.fromHdr);
    this.toNumber   = parseAorUser(this.toHdr);
    this.number    = this.fromNumber; // for parity with outbound Call
    this._remoteContact = request.headers.contact || null;

    this.remoteSdp = request.body || '';
    this.remoteRtp = this.remoteSdp ? this._parseRemoteSdp(this.remoteSdp) : null;

    this.startedAt = Date.now();
    this.state     = 'inviting'; // inviting → ringing → live → ended
    this.duration  = 0;
    this.rtpLocalPort = 0;
    this.codecs    = null;
    this._lastResponse = null;
  }

  // SDP parsing reused from outbound Call.
  _parseRemoteSdp(sdp) { return Call.prototype._parseRemoteSdp.call(this, sdp); }

  _buildAnswerSdp() {
    const ip   = this.agent.cfg.localIp;
    const port = this.rtpLocalPort;
    // Echo back the PT the PBX selected (or PCMU as fallback).
    const pt   = (this.remoteRtp && (this.remoteRtp.payloadType === 8 ? 8 : 0)) ?? 0;
    const name = pt === 8 ? 'PCMA' : 'PCMU';
    return [
      'v=0',
      `o=- ${Date.now()} ${Date.now()} IN IP4 ${ip}`,
      's=AutoCall',
      `c=IN IP4 ${ip}`,
      't=0 0',
      `m=audio ${port} RTP/AVP ${pt} 101`,
      `a=rtpmap:${pt} ${name}/8000`,
      'a=rtpmap:101 telephone-event/8000',
      'a=fmtp:101 0-16',
      'a=ptime:20',
      'a=sendrecv',
    ].join(CRLF) + CRLF;
  }

  ringing() {
    if (this.state !== 'inviting') return;
    this.state = 'ringing';
    this._respondToInvite(180, 'Ringing');
    this.emit('ringing');
  }

  accept({ rtpLocalPort, codecs }) {
    if (this.state === 'live' || this.state === 'ended') return;
    this.rtpLocalPort = rtpLocalPort;
    this.codecs = codecs || null;
    const body = this._buildAnswerSdp();
    this._respondToInvite(200, 'OK', body);
    this.state = 'live';
    logger.info('SIP inbound answered', {
      from: this.fromNumber, rtp: this.remoteRtp, localRtp: rtpLocalPort,
    });
    this.emit('answered', { remoteRtp: this.remoteRtp, remoteSdp: this.remoteSdp });
  }

  reject(code = 603, reason = 'Decline') {
    if (this.state === 'ended') return;
    this._respondToInvite(code, reason);
    this.state = 'ended';
    this.emit('failed', { reason: `rejected ${code} ${reason}` });
    this.emit('terminated');
  }

  async hangup() {
    if (this.state === 'ended') return;
    const wasLive = this.state === 'live';
    this.duration = Math.round((Date.now() - this.startedAt) / 1000);
    this.state = 'ended';
    if (wasLive) {
      await this._sendBye();
    } else {
      this._respondToInvite(486, 'Busy Here');
    }
    this.emit('ended', { reason: 'local_hangup', duration: this.duration });
    this.emit('terminated');
  }

  _resendLastResponse() {
    if (this._lastResponse) this.agent._send(this._lastResponse);
  }

  _respondToInvite(code, reason, body = '') {
    const req = this.request;
    let toHdr = req.headers.to || '';
    if (!/tag=/i.test(toHdr)) toHdr = `${toHdr};tag=${this.localTag}`;
    const headers = {
      Via:        req.headers.via,
      From:       req.headers.from,
      To:         toHdr,
      'Call-ID':  this.callId,
      CSeq:       req.headers.cseq,
      Contact:    `<sip:${this.agent.cfg.extension}@${this.agent.cfg.localIp}:${this.agent.cfg.localPort}>`,
      'User-Agent': USER_AGENT,
    };
    if (code >= 200 && code < 300) {
      headers.Allow = 'INVITE, ACK, CANCEL, BYE, OPTIONS, INFO';
    }
    if (body) {
      headers['Content-Type']   = 'application/sdp';
      headers['Content-Length'] = String(Buffer.byteLength(body, 'utf8'));
    } else {
      headers['Content-Length'] = '0';
    }
    const lines = [`${VERSION} ${code} ${reason}`];
    for (const [k, v] of Object.entries(headers)) lines.push(`${k}: ${v}`);
    const msg = lines.join(CRLF) + CRLF + CRLF + (body || '');
    this._lastResponse = msg;
    this.agent._send(msg);
  }

  _onAck(_m) {
    // Dialog confirmed — nothing else to do.
  }

  _onRemoteCancel(_m) {
    // Respond 487 to the original INVITE per RFC 3261.
    if (this.state === 'inviting' || this.state === 'ringing') {
      this._respondToInvite(487, 'Request Terminated');
    }
    this.state = 'ended';
    this.emit('failed', { reason: 'remote_cancel' });
    this.emit('terminated');
  }

  _onRemoteBye() {
    this.duration = Math.round((Date.now() - this.startedAt) / 1000);
    this.state = 'ended';
    logger.info('SIP inbound BYE from remote', { duration: this.duration });
    this.emit('ended', { reason: 'remote_bye', duration: this.duration });
    this.emit('terminated');
  }

  async _sendBye() {
    const agent = this.agent;
    const contactUri = this._extractContactUri(this._remoteContact)
      || `sip:${this.fromNumber}@${agent.cfg.host}`;
    const cseqNum = agent.cseq.BYE++;
    // For UAS, From = our local URI (with our tag), To = remote URI (with remote tag).
    const headers = {
      Via:       `SIP/2.0/UDP ${agent.cfg.localIp}:${agent.cfg.localPort};rport;branch=${genBranch()}`,
      From:      `<sip:${agent.cfg.extension}@${agent.cfg.host}>;tag=${this.localTag}`,
      To:        `<sip:${this.fromNumber}@${agent.cfg.host}>;tag=${this.remoteTag}`,
      'Call-ID': this.callId,
      CSeq:      `${cseqNum} BYE`,
      'Max-Forwards': '70',
      'User-Agent':   USER_AGENT,
      'Content-Length': '0',
    };
    const lines = [`BYE ${contactUri} ${VERSION}`];
    for (const [k, v] of Object.entries(headers)) lines.push(`${k}: ${v}`);
    const msg = lines.join(CRLF) + CRLF + CRLF;
    const key = `${this.callId}|BYE`;
    return new Promise((resolve) => {
      agent.pending.set(key, { resolve: () => resolve(), reject: () => resolve(), t0: Date.now() });
      agent._send(msg);
      setTimeout(() => { agent.pending.delete(key); resolve(); }, 5000);
    });
  }

  _extractContactUri(contact) {
    if (!contact) return null;
    const m = (Array.isArray(contact) ? contact[0] : contact).match(/<([^>]+)>/);
    return m ? m[1] : null;
  }

  summary() {
    return {
      callId: this.callId,
      direction: 'inbound',
      from: this.fromNumber,
      to: this.toNumber,
      number: this.fromNumber,
      state: this.state,
      remoteRtp: this.remoteRtp,
      duration: this.duration || Math.round((Date.now() - this.startedAt) / 1000),
    };
  }
}

module.exports = { SipAgent, InboundCall, pickLocalIPv4 };
