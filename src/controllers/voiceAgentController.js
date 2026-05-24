/**
 * voiceAgentController — REST API that drives the server-side SIP UA
 * to place outbound voice-agent calls to phone numbers via the office PBX
 * (cloudpbx.kotha.com.bd). TTS audio is streamed over RTP as PCMU.
 *
 * Endpoints:
 *   GET  /api/voice-agent/status                 → registration + active call
 *   POST /api/voice-agent/register               → force REGISTER refresh
 *   POST /api/voice-agent/call    { number, text, lang?, repeat? }
 *   POST /api/voice-agent/speak   { text, lang?, repeat? }   (during live call)
 *   POST /api/voice-agent/hangup
 */
'use strict';

const express   = require('express');
const router    = express.Router();
const { SipAgent } = require('../services/sipAgent');
const RtpStream    = require('../services/rtpStream');
const { ttsToPcm } = require('../services/ttsAudio');
const g711      = require('../services/muLaw');
const aiService = require('../services/aiService');
const sttService = require('../services/sttService');
const logger    = require('../utils/logger');

let agent = null;          // SipAgent singleton
let rtp   = null;          // RtpStream for active call
let call  = null;          // SIP Call
let lastError = null;
// Live transcript of the current/last inbound dialog — surfaced in /status
// so the admin panel can show what the AI agent is hearing & saying.
let dialogTranscript = [];   // [{ ts, role:'agent'|'caller'|'system', text }]
let dialogActive    = false;
let lastInboundFrom = null;
let lastInboundAt   = null;

function pushDialog(role, text) {
  if (!text) return;
  dialogTranscript.push({ ts: Date.now(), role, text });
  if (dialogTranscript.length > 200) dialogTranscript = dialogTranscript.slice(-200);
}

// ── Inbound dialog config ────────────────────────────────────────────────────
const INBOUND_DID = process.env.INBOUND_DID || '09666753953';
const INBOUND_LANG = process.env.INBOUND_TTS_LANG || 'bn';
const AI_BUSINESS_NAME = process.env.AI_BUSINESS_NAME || 'sahajmobile.com';
const AI_TOPIC = process.env.AI_TOPIC || 'EMI loan for mobile phones at sahajmobile.com';
const INBOUND_GREETING = process.env.INBOUND_TTS_TEXT
  || `আসসালামু আলাইকুম। আপনি ${AI_BUSINESS_NAME} এর কাস্টমার সাপোর্টে যোগাযোগ করেছেন। `
   + 'মোবাইল ফোনের ইএমআই লোন সম্পর্কে আপনাকে সাহায্য করতে পারি। বলুন, কীভাবে সাহায্য করতে পারি?';

// VAD tuning (telephony, 8 kHz µ/A-law)
const FRAME_MS         = 20;
const FRAME_SAMPLES    = 160;                    // 20 ms @ 8 kHz
const SPEECH_RMS       = 700;                    // above this = voice
const SILENCE_RMS      = 500;                    // below this = silence
const SILENCE_END_MS   = 900;                    // silence after speech ⇒ utterance end
const MIN_UTTER_MS     = 350;                    // ignore shorter blips
const MAX_UTTER_MS     = 14_000;                 // safety cap
const NO_SPEECH_MS     = 12_000;                 // hang up after this much silence at start of turn
const MAX_TURNS        = 20;

function sipConfig() {
  return {
    host:         process.env.SIP_HOST         || 'cloudpbx.kotha.com.bd',
    port:         Number(process.env.SIP_PORT  || 5060),
    extension:    process.env.SIP_EXTENSION    || '1073124',
    authUser:     process.env.SIP_AUTH_USER    || process.env.SIP_EXTENSION || '1073124',
    password:     process.env.SIP_PASSWORD     || 'S8gj*SMDNcms',
    displayName:  process.env.SIP_DISPLAY_NAME || 'Niru',
    realm:        process.env.SIP_REALM        || process.env.SIP_HOST || 'cloudpbx.kotha.com.bd',
    localPort:    Number(process.env.SIP_LOCAL_PORT || 5070),
    expires:      Number(process.env.SIP_EXPIRES || 600),
  };
}

async function startAgent() {
  if (agent) return agent;
  const cfg = sipConfig();
  agent = new SipAgent(cfg);
  agent.on('registered',   () => logger.info('VoiceAgent SIP registered'));
  agent.on('unregistered', () => logger.info('VoiceAgent SIP unregistered'));
  agent.on('incomingCall', inboundCall => {
    handleIncomingCall(inboundCall).catch(e => {
      logger.error('VoiceAgent inbound handler failed', { error: e.message });
      try { inboundCall.reject(500, 'Server Error'); } catch {}
    });
  });
  try {
    await agent.start();
    lastError = null;
  } catch (e) {
    lastError = e.message;
    logger.error('VoiceAgent SIP start failed', { error: e.message });
  }
  return agent;
}

async function stopAgent() {
  if (call) { try { await call.hangup(); } catch {} call = null; }
  if (rtp)  { try { rtp.close(); } catch {} rtp = null; }
  if (agent) { try { await agent.stop(); } catch {} agent = null; }
}

async function placeCall({ number, text, lang, repeat }) {
  if (!agent || !agent.registered) throw new Error('SIP not registered');
  if (call) throw new Error('A call is already active');

  // 1) Prepare TTS as raw 8 kHz PCM. We'll G.711-encode it after we learn
  //    which codec the PBX selected in its 200 OK SDP.
  const pcm = await ttsToPcm(text || '', lang || 'bn');

  // 2) Bind RTP socket so we have a port to advertise in the SDP offer.
  rtp = new RtpStream({
    remoteHost: agent.remoteIp,    // overwritten by latching once PBX sends RTP
    remotePort: 0,
    payloadType: 0,                // updated after answer
  });
  await rtp.bind();
  const localRtpPort = rtp.localPort;

  // 3) Place the SIP INVITE (offers BOTH PCMU and PCMA by default).
  call = await agent.invite(number, { rtpLocalPort: localRtpPort });

  const onAnswered = ({ remoteRtp }) => {
    logger.info('VoiceAgent answered', { number, remoteRtp });
    if (!remoteRtp) {
      logger.error('No remote RTP info in SDP — cannot stream audio');
      return;
    }
    const pt = remoteRtp.payloadType ?? 0;
    rtp.remoteHost  = remoteRtp.host;
    rtp.remotePort  = remoteRtp.port;
    rtp.payloadType = pt;
    rtp.silenceByte = g711.silenceByteFor(pt);
    const audioBuf = g711.encodeBufferFor(pt, pcm);
    logger.info('VoiceAgent streaming', { codec: remoteRtp.codec, pt, audioBytes: audioBuf.length });

    // Tiny silence preamble (one or two packets) so the very first audio frame
    // isn't clipped while the encoder/network warms up. NAT pinhole is already
    // open by now thanks to the ringback RTP we've been receiving.
    rtp.appendSilence(60);
    const times = Math.max(1, Number(repeat) || 1);
    for (let i = 0; i < times; i++) {
      rtp.queue(audioBuf);
      if (i < times - 1) rtp.appendSilence(700);
    }
    rtp.appendSilence(200);
    rtp.once('finished', () => {
      logger.info('VoiceAgent TTS finished — hanging up', rtp.stats());
      call?.hangup().catch(() => {});
    });
  };

  call.on('ringing', () => logger.info('VoiceAgent ringing', { number }));
  call.on('answered', onAnswered);
  // Safety net: if the call answered before this listener was attached
  // (extremely fast PBX), trigger the handler manually.
  if (call.state === 'live' && call.remoteRtp) {
    onAnswered({ remoteRtp: call.remoteRtp });
  }
  call.on('failed', e => {
    logger.warn('VoiceAgent call failed', e);
    lastError = e.reason;
    try { rtp?.close(); } catch {}
    rtp = null; call = null;
  });
  call.on('ended', e => {
    logger.info('VoiceAgent call ended', e);
    try { rtp?.close(); } catch {}
    rtp = null; call = null;
  });

  return { callId: call.callId, number };
}

async function speakDuringCall({ text, lang, repeat }) {
  if (!call || call.state !== 'live') throw new Error('No live call');
  const pcm = await ttsToPcm(text || '', lang || 'bn');
  const pt = rtp.payloadType ?? 0;
  const audioBuf = g711.encodeBufferFor(pt, pcm);
  const times = Math.max(1, Number(repeat) || 1);
  rtp.appendSilence(200);
  for (let i = 0; i < times; i++) {
    rtp.queue(audioBuf);
    if (i < times - 1) rtp.appendSilence(700);
  }
}

// ─── Inbound: auto-answer + AI conversation ──────────────────────────────────

function systemPrompt() {
  return [
    `You are a friendly customer-support voice agent for ${AI_BUSINESS_NAME}.`,
    `Your job is to talk with customers about ${AI_TOPIC}.`,
    'Speak naturally and concisely (1–3 short sentences per turn) — your reply will be spoken aloud over the phone.',
    'Detect the user\'s language from their words and ALWAYS reply in the same language (Bangla, English, or Hindi).',
    'Topics you can help with: EMI eligibility, monthly installment amounts, required documents (NID, salary slip, photo), down-payment options, late-payment consequences, how to apply, and store locations.',
    'If you do not know something, say so politely and suggest the customer visit sahajmobile.com or call back during business hours.',
    'Do NOT make up exact prices, interest rates or model availability — give general guidance and ask them to confirm on the website.',
    'If the customer says goodbye or wants to end the call, reply briefly and end with the token <END> on the last line.',
  ].join(' ');
}

/** RMS of an Int16Array frame. */
function rms(frame) {
  let sum = 0;
  for (let i = 0; i < frame.length; i++) sum += frame[i] * frame[i];
  return Math.sqrt(sum / frame.length);
}

/** Concatenate an array of Int16Array into one. */
function concatInt16(chunks, totalLen) {
  const out = new Int16Array(totalLen);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  return out;
}

/**
 * Listen to incoming RTP audio, detect end-of-utterance with energy VAD,
 * and resolve with the captured Int16Array PCM. Resolves with `null` if
 * no speech is detected within NO_SPEECH_MS.
 */
function captureUtterance(rtpStream) {
  return new Promise((resolve) => {
    let frameBuf = new Int16Array(0);
    const chunks = [];
    let totalSamples = 0;
    let speechStartMs = 0;
    let lastVoiceMs = 0;
    let speaking = false;
    const startedAt = Date.now();
    let finished = false;

    const noSpeechTimer = setTimeout(() => done(null), NO_SPEECH_MS);

    function done(result) {
      if (finished) return;
      finished = true;
      clearTimeout(noSpeechTimer);
      rtpStream.off('audio', onAudio);
      resolve(result);
    }

    function onAudio(pcm) {
      // Re-frame to fixed 20 ms windows for stable RMS.
      const merged = new Int16Array(frameBuf.length + pcm.length);
      merged.set(frameBuf, 0);
      merged.set(pcm, frameBuf.length);
      let off = 0;
      while (off + FRAME_SAMPLES <= merged.length) {
        const frame = merged.subarray(off, off + FRAME_SAMPLES);
        processFrame(frame);
        off += FRAME_SAMPLES;
        if (finished) return;
      }
      frameBuf = merged.slice(off);
    }

    function processFrame(frame) {
      const e = rms(frame);
      const now = Date.now();
      if (!speaking) {
        if (e > SPEECH_RMS) {
          speaking = true;
          speechStartMs = now;
          lastVoiceMs   = now;
          chunks.push(new Int16Array(frame));
          totalSamples += frame.length;
        }
      } else {
        chunks.push(new Int16Array(frame));
        totalSamples += frame.length;
        if (e > SILENCE_RMS) lastVoiceMs = now;
        const sinceVoice = now - lastVoiceMs;
        const utterDur   = now - speechStartMs;
        if (utterDur >= MAX_UTTER_MS ||
            (sinceVoice >= SILENCE_END_MS && utterDur >= MIN_UTTER_MS)) {
          done(concatInt16(chunks, totalSamples));
        }
      }
    }

    rtpStream.on('audio', onAudio);
  });
}

/** Render `text` via TTS, encode it, and queue it on the active RTP stream.
 *  Resolves when playback (queue drained) completes. */
async function speak(text, lang) {
  if (!text || !text.trim() || !rtp || !call) return;
  let pcm;
  try {
    pcm = await ttsToPcm(text, lang || INBOUND_LANG);
  } catch (e) {
    logger.warn('TTS failed', { error: e.message });
    return;
  }
  const pt = rtp.payloadType ?? 0;
  const audioBuf = g711.encodeBufferFor(pt, pcm);
  rtp.appendSilence(100);
  rtp.queue(audioBuf);
  rtp.appendSilence(120);
  await new Promise(resolve => {
    if (!rtp) return resolve();
    rtp.once('finished', resolve);
    // Safety timeout so we don't hang forever if the queue stalls.
    setTimeout(resolve, Math.max(2000, Math.round(pcm.length / 8) + 1500));
  });
}

async function handleIncomingCall(inboundCall) {
  if (call) {
    logger.warn('VoiceAgent inbound rejected: already busy', { from: inboundCall.fromNumber });
    inboundCall.reject(486, 'Busy Here');
    return;
  }

  logger.info('VoiceAgent incoming call', {
    from: inboundCall.fromNumber, to: inboundCall.toNumber, callId: inboundCall.callId,
  });
  call = inboundCall;

  if (!inboundCall.remoteRtp) {
    logger.error('Inbound INVITE missing remote SDP — rejecting');
    inboundCall.reject(488, 'Not Acceptable Here');
    call = null;
    return;
  }

  // Bind RTP using the codec the PBX offered.
  const pt = (inboundCall.remoteRtp.payloadType === 8) ? 8 : 0;
  rtp = new RtpStream({
    remoteHost: inboundCall.remoteRtp.host,
    remotePort: inboundCall.remoteRtp.port,
    payloadType: pt,
  });
  await rtp.bind();
  rtp.silenceByte = g711.silenceByteFor(pt);

  // 180 Ringing → 200 OK with our SDP answer.
  inboundCall.ringing();
  let ended = false;
  inboundCall.once('terminated', () => {
    ended = true;
    try { rtp?.close(); } catch {}
    rtp = null; call = null;
  });
  inboundCall.accept({ rtpLocalPort: rtp.localPort });

  // Run the dialog loop on a tick so 'answered' has fully propagated.
  setImmediate(() => runDialog(inboundCall).catch(e => {
    logger.error('Dialog loop crashed', { error: e.message });
    try { inboundCall.hangup(); } catch {}
  }));
}

async function runDialog(inboundCall) {
  dialogTranscript = [];
  dialogActive = true;
  lastInboundFrom = inboundCall.fromNumber;
  lastInboundAt   = Date.now();
  pushDialog('system', `Incoming call from ${inboundCall.fromNumber || 'unknown'} — AI agent answering`);
  const history = [
    { role: 'system', content: systemPrompt() },
  ];

  // Greeting first.
  await speak(INBOUND_GREETING, INBOUND_LANG);
  history.push({ role: 'assistant', content: INBOUND_GREETING });
  pushDialog('agent', INBOUND_GREETING);

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    if (!call || call.state !== 'live') return;

    // Listen.
    const utterance = await captureUtterance(rtp);
    if (!call || call.state !== 'live') return;
    if (!utterance) {
      logger.info('Dialog: no speech detected — ending');
      pushDialog('system', 'No speech detected — ending call');
      await speak('ধন্যবাদ। আবার যোগাযোগ করার জন্য sahajmobile.com ভিজিট করুন।', INBOUND_LANG);
      break;
    }
    const durMs = Math.round(utterance.length / 8);
    logger.info('Dialog: captured utterance', { ms: durMs, samples: utterance.length });

    // Transcribe.
    let transcript = '';
    try {
      transcript = await sttService.transcribePcm(utterance, INBOUND_LANG);
    } catch (e) {
      logger.error('STT failed', { error: e.message });
    }
    transcript = (transcript || '').trim();
    logger.info('Dialog: user said', { text: transcript });
    if (!transcript) {
      pushDialog('system', '(unintelligible audio)');
      await speak('দুঃখিত, আপনার কথা স্পষ্ট শুনতে পাইনি। আবার বলবেন কি?', INBOUND_LANG);
      continue;
    }
    pushDialog('caller', transcript);
    history.push({ role: 'user', content: transcript });

    // LLM reply.
    let reply = '';
    try {
      reply = await aiService.chat(history, { temperature: 0.4, maxTokens: 180 });
    } catch (e) {
      logger.error('AI chat failed', { error: e.message });
      reply = 'দুঃখিত, এই মুহূর্তে সিস্টেমে সমস্যা হচ্ছে। অনুগ্রহ করে পরে আবার চেষ্টা করুন।';
    }

    const endFlag = /<END>/i.test(reply);
    const cleanReply = reply.replace(/<END>/ig, '').trim();
    history.push({ role: 'assistant', content: cleanReply });
    logger.info('Dialog: agent reply', { text: cleanReply, end: endFlag });
    pushDialog('agent', cleanReply);

    await speak(cleanReply, INBOUND_LANG);
    if (endFlag) break;
  }

  pushDialog('system', 'Call ended');
  dialogActive = false;
  // Polite wrap-up + hang up.
  try { await inboundCall.hangup(); } catch {}
}

// ─── Routes ──────────────────────────────────────────────────────────────────

router.get('/status', (_req, res) => {
  const sip = agent ? agent.status() : { registered: false, lastError };
  const aiConfigured = !!(process.env.GROQ_API_KEY || process.env.OPENAI_API_KEY);
  const inboundReady = !!(sip.registered && agent && agent.listenerCount('incomingCall') > 0);
  res.json({
    sip,
    rtp:  rtp ? rtp.stats() : null,
    call: call ? call.summary() : null,
    inbound: {
      did: INBOUND_DID,
      ready: inboundReady,
      aiConfigured,
      lastCallFrom: lastInboundFrom,
      lastCallAt:   lastInboundAt,
      dialogActive,
      transcript: dialogTranscript,
    },
    lastError,
  });
});

router.post('/register', async (_req, res) => {
  try {
    if (!agent) await startAgent();
    else        await agent._register();
    res.json({ ok: true, status: agent?.status() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/call', async (req, res) => {
  const { number, text, lang, repeat } = req.body || {};
  if (!number) return res.status(400).json({ error: 'number required' });
  if (!text)   return res.status(400).json({ error: 'text required' });
  try {
    const r = await placeCall({ number, text, lang, repeat });
    res.json({ ok: true, ...r });
  } catch (e) {
    logger.error('VoiceAgent placeCall error', { error: e.message });
    res.status(500).json({ error: e.message });
  }
});

router.post('/speak', async (req, res) => {
  const { text, lang, repeat } = req.body || {};
  if (!text) return res.status(400).json({ error: 'text required' });
  try {
    await speakDuringCall({ text, lang, repeat });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/hangup', async (_req, res) => {
  try {
    if (call) await call.hangup();
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = { voiceAgentRoutes: router, startAgent, stopAgent };
