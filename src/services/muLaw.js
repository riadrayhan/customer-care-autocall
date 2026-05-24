/**
 * G.711 codecs:
 *   • µ-law (PCMU, PT=0) — North America / Japan / Bangladesh mobile carriers
 *   • A-law (PCMA, PT=8) — Europe / most of Asia incl. many BD PBX systems
 *
 * Both convert 16-bit signed PCM samples to 8-bit telephony samples.
 */
'use strict';

// ─── µ-law ───────────────────────────────────────────────────────────────────
const MU_BIAS = 0x84;
const MU_CLIP = 32635;

function encodeMuLawSample(sample) {
  let sign = 0;
  if (sample < 0) { sample = -sample; sign = 0x80; }
  if (sample > MU_CLIP) sample = MU_CLIP;
  sample += MU_BIAS;
  let exponent = 7;
  for (let mask = 0x4000; (sample & mask) === 0 && exponent > 0; mask >>= 1) exponent--;
  const mantissa = (sample >> (exponent === 0 ? 4 : (exponent + 3))) & 0x0f;
  return (~(sign | (exponent << 4) | mantissa)) & 0xff;
}

function encodeMuLawBuffer(int16) {
  const out = Buffer.allocUnsafe(int16.length);
  for (let i = 0; i < int16.length; i++) out[i] = encodeMuLawSample(int16[i]);
  return out;
}

// ─── A-law ───────────────────────────────────────────────────────────────────
const A_CLIP = 32635;

function encodeALawSample(sample) {
  let sign = (~sample >> 8) & 0x80;
  if (!sign) sample = -sample;
  if (sample > A_CLIP) sample = A_CLIP;
  let compressed;
  if (sample >= 256) {
    let exponent = 7;
    for (let mask = 0x4000; (sample & mask) === 0; mask >>= 1) exponent--;
    const mantissa = (sample >> (exponent + 3)) & 0x0f;
    compressed = (exponent << 4) | mantissa;
  } else {
    compressed = sample >> 4;
  }
  return (compressed ^ sign ^ 0x55) & 0xff;
}

function encodeALawBuffer(int16) {
  const out = Buffer.allocUnsafe(int16.length);
  for (let i = 0; i < int16.length; i++) out[i] = encodeALawSample(int16[i]);
  return out;
}

// ─── Decoders (telephony byte → 16-bit signed PCM) ───────────────────────────

function decodeMuLawByte(u) {
  u = ~u & 0xff;
  const sign = u & 0x80;
  const exponent = (u >> 4) & 0x07;
  const mantissa = u & 0x0f;
  let sample = ((mantissa << 3) + MU_BIAS) << exponent;
  sample -= MU_BIAS;
  return sign ? -sample : sample;
}

function decodeALawByte(a) {
  a ^= 0x55;
  const sign = a & 0x80;
  const exponent = (a >> 4) & 0x07;
  const mantissa = a & 0x0f;
  let sample;
  if (exponent === 0) sample = (mantissa << 4) + 8;
  else                sample = ((mantissa << 4) + 0x108) << (exponent - 1);
  return sign ? sample : -sample;
}

function decodeMuLawBuffer(buf) {
  const out = new Int16Array(buf.length);
  for (let i = 0; i < buf.length; i++) out[i] = decodeMuLawByte(buf[i]);
  return out;
}

function decodeALawBuffer(buf) {
  const out = new Int16Array(buf.length);
  for (let i = 0; i < buf.length; i++) out[i] = decodeALawByte(buf[i]);
  return out;
}

function decodeBufferFor(payloadType, buf) {
  if (payloadType === 8) return decodeALawBuffer(buf);
  return decodeMuLawBuffer(buf);
}

// Silence byte for each codec (= encoding of PCM 0).
const SILENCE_MULAW = encodeMuLawSample(0); // 0xff
const SILENCE_ALAW  = encodeALawSample(0);  // 0xd5

function encodeBufferFor(payloadType, int16) {
  if (payloadType === 8) return encodeALawBuffer(int16);
  return encodeMuLawBuffer(int16); // default PT=0 PCMU
}

function silenceByteFor(payloadType) {
  return payloadType === 8 ? SILENCE_ALAW : SILENCE_MULAW;
}

module.exports = {
  // legacy µ-law API (kept for back-compat)
  encodeSample: encodeMuLawSample,
  encodeBuffer: encodeMuLawBuffer,
  // explicit codec helpers
  encodeMuLawBuffer,
  encodeALawBuffer,
  encodeBufferFor,
  decodeMuLawByte,
  decodeALawByte,
  decodeMuLawBuffer,
  decodeALawBuffer,
  decodeBufferFor,
  silenceByteFor,
  SILENCE_MULAW,
  SILENCE_ALAW,
};
