/**
 * sttService — speech-to-text with Groq Whisper primary and OpenAI Whisper fallback.
 * Both providers accept multipart/form-data with `file` + `model`.
 *
 * Input: Int16Array PCM @ 8 kHz mono.  We wrap it in a WAV container and POST.
 */
'use strict';

const logger = require('../utils/logger');

const GROQ_URL   = 'https://api.groq.com/openai/v1/audio/transcriptions';
const OPENAI_URL = 'https://api.openai.com/v1/audio/transcriptions';

const GROQ_KEY       = process.env.GROQ_API_KEY      || '';
const GROQ_STT_MODEL = process.env.GROQ_STT_MODEL    || 'whisper-large-v3';
const OPENAI_KEY     = process.env.OPENAI_API_KEY    || '';
const OPENAI_STT_MODEL = process.env.OPENAI_STT_MODEL || 'whisper-1';

/** Wrap raw 16-bit signed PCM mono samples into a RIFF/WAVE buffer. */
function pcmToWav(pcm, sampleRate = 8000) {
  const bytesPerSample = 2;
  const dataSize = pcm.length * bytesPerSample;
  const buf = Buffer.alloc(44 + dataSize);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);                  // PCM fmt chunk size
  buf.writeUInt16LE(1, 20);                   // audio format = PCM
  buf.writeUInt16LE(1, 22);                   // channels
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * bytesPerSample, 28); // byte rate
  buf.writeUInt16LE(bytesPerSample, 32);      // block align
  buf.writeUInt16LE(16, 34);                  // bits per sample
  buf.write('data', 36);
  buf.writeUInt32LE(dataSize, 40);
  for (let i = 0; i < pcm.length; i++) buf.writeInt16LE(pcm[i], 44 + i * 2);
  return buf;
}

async function transcribeOnce(url, key, model, wav, language, timeoutMs = 20_000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const form = new FormData();
    form.append('file', new Blob([wav], { type: 'audio/wav' }), 'audio.wav');
    form.append('model', model);
    if (language) form.append('language', language);
    form.append('response_format', 'json');
    const r = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}` },
      body: form,
      signal: ctrl.signal,
    });
    const text = await r.text();
    if (!r.ok) throw new Error(`HTTP ${r.status}: ${text.slice(0, 240)}`);
    const j = JSON.parse(text);
    return (j.text || '').trim();
  } finally {
    clearTimeout(t);
  }
}

/**
 * @param {Int16Array} pcm 8 kHz mono signed-16 samples
 * @param {string} [language] ISO code, e.g. 'bn', 'en'
 * @returns {Promise<string>} transcript ('' if silence)
 */
async function transcribePcm(pcm, language) {
  if (!pcm || pcm.length === 0) return '';
  const wav = pcmToWav(pcm, 8000);

  if (GROQ_KEY) {
    try {
      return await transcribeOnce(GROQ_URL, GROQ_KEY, GROQ_STT_MODEL, wav, language);
    } catch (e) {
      logger.warn('Groq STT failed, falling back to OpenAI', { error: e.message });
    }
  }
  if (OPENAI_KEY) {
    return await transcribeOnce(OPENAI_URL, OPENAI_KEY, OPENAI_STT_MODEL, wav, language);
  }
  throw new Error('No STT provider configured (set GROQ_API_KEY or OPENAI_API_KEY)');
}

module.exports = { transcribePcm, pcmToWav };
