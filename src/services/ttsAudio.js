/**
 * ttsAudio — text-to-speech for the voice agent.
 *
 * Primary:  OpenAI TTS (`/v1/audio/speech`, model `tts-1` / `tts-1-hd`,
 *           voice `shimmer` by default — a warm, sweet female voice that
 *           handles Bangla / English / Hindi well).
 * Fallback: Google Translate TTS via our local /api/tts proxy.
 *
 * Output: 8 kHz mono signed-16 PCM (Int16Array). Telephony G.711 encoding
 * happens later, after we know which codec the PBX selected.
 *
 * Requires `ffmpeg` on PATH. Set FFMPEG_PATH env to override.
 */
'use strict';

const { spawn } = require('child_process');
const g711      = require('./muLaw');
const logger    = require('../utils/logger');

const TARGET_RATE = 8000;
const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';

const OPENAI_KEY       = process.env.OPENAI_API_KEY  || '';
const OPENAI_TTS_URL   = 'https://api.openai.com/v1/audio/speech';
const OPENAI_TTS_MODEL = process.env.OPENAI_TTS_MODEL || 'tts-1';
const OPENAI_TTS_VOICE = process.env.OPENAI_TTS_VOICE || 'shimmer';
const OPENAI_TTS_SPEED = Number(process.env.OPENAI_TTS_SPEED || 0.95);

function mp3ToPcm8k(mp3Buffer) {
  return new Promise((resolve, reject) => {
    const ff = spawn(FFMPEG, [
      '-hide_banner', '-loglevel', 'error',
      '-f', 'mp3', '-i', 'pipe:0',
      '-f', 's16le', '-acodec', 'pcm_s16le',
      '-ac', '1', '-ar', String(TARGET_RATE),
      'pipe:1',
    ], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });

    const chunks = [];
    const errs   = [];
    ff.stdout.on('data', c => chunks.push(c));
    ff.stderr.on('data', c => errs.push(c.toString()));
    ff.on('error', err => reject(new Error('ffmpeg spawn failed: ' + err.message)));
    ff.on('close', code => {
      if (code !== 0) return reject(new Error(`ffmpeg exit ${code}: ${errs.join('').slice(-300)}`));
      const pcm = Buffer.concat(chunks);
      const samples = pcm.length >>> 1;
      const out = new Int16Array(samples);
      for (let i = 0, j = 0; i < samples; i++, j += 2) out[i] = pcm.readInt16LE(j);
      resolve(out);
    });
    ff.stdin.end(mp3Buffer);
  });
}

async function fetchOpenAiTts(text) {
  if (!OPENAI_KEY) throw new Error('OPENAI_API_KEY not set');
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 20_000);
  try {
    const r = await fetch(OPENAI_TTS_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${OPENAI_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: OPENAI_TTS_MODEL,
        voice: OPENAI_TTS_VOICE,
        input: text,
        response_format: 'mp3',
        speed: OPENAI_TTS_SPEED,
      }),
      signal: ctrl.signal,
    });
    if (!r.ok) {
      const errTxt = await r.text();
      throw new Error(`OpenAI TTS HTTP ${r.status}: ${errTxt.slice(0, 200)}`);
    }
    return Buffer.from(await r.arrayBuffer());
  } finally {
    clearTimeout(t);
  }
}

async function fetchGoogleTts(text, lang, port) {
  const url = `http://127.0.0.1:${port}/api/tts?text=${encodeURIComponent(text)}&lang=${encodeURIComponent(lang)}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`TTS upstream HTTP ${r.status}`);
  const ctype = r.headers.get('content-type') || '';
  const mp3 = Buffer.from(await r.arrayBuffer());
  if (!mp3.length) throw new Error('TTS returned empty body');
  const looksLikeMp3 = mp3[0] === 0xff || mp3.subarray(0, 3).toString('ascii') === 'ID3';
  if (!ctype.includes('audio') && !looksLikeMp3) {
    throw new Error(`TTS returned non-audio (${ctype}): ${mp3.subarray(0, 120).toString('utf8')}`);
  }
  return mp3;
}

async function ttsToPcm(text, lang = 'bn', port = process.env.PORT || 3000) {
  if (!text || !text.trim()) throw new Error('text required');

  let mp3, source;
  if (OPENAI_KEY) {
    try {
      mp3 = await fetchOpenAiTts(text);
      source = `openai:${OPENAI_TTS_MODEL}/${OPENAI_TTS_VOICE}`;
    } catch (e) {
      logger.warn('OpenAI TTS failed, falling back to Google', { error: e.message });
    }
  }
  if (!mp3) {
    mp3 = await fetchGoogleTts(text, lang, port);
    source = 'google-translate';
  }

  const pcm = await mp3ToPcm8k(mp3);
  if (!pcm.length) throw new Error('ffmpeg decoded to 0 samples');
  logger.info('TTS prepared', {
    chars: text.length, lang, source,
    samples8k: pcm.length, durationMs: Math.round(pcm.length / 8),
  });
  return pcm;
}

/** Convenience: TTS → G.711 encoded buffer for the given payload type. */
async function ttsToG711(text, lang, payloadType = 0, port) {
  const pcm = await ttsToPcm(text, lang, port);
  return g711.encodeBufferFor(payloadType, pcm);
}

module.exports = { ttsToPcm, ttsToG711, ttsToMuLaw: ttsToG711, TARGET_RATE };
