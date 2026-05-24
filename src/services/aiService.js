/**
 * aiService — LLM chat completions with Groq as the primary provider and
 * OpenAI as automatic fallback on error / missing key.
 *
 * Both providers expose an OpenAI-compatible /v1/chat/completions endpoint,
 * so the same request body works for either.
 */
'use strict';

const logger = require('../utils/logger');

const GROQ_URL   = 'https://api.groq.com/openai/v1/chat/completions';
const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';

const GROQ_KEY    = process.env.GROQ_API_KEY    || '';
const GROQ_MODEL  = process.env.GROQ_MODEL      || 'llama-3.3-70b-versatile';
const OPENAI_KEY  = process.env.OPENAI_API_KEY  || '';
const OPENAI_MODEL = process.env.OPENAI_MODEL   || 'gpt-4o-mini';

async function postJson(url, key, body, timeoutMs = 15_000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    const text = await r.text();
    if (!r.ok) throw new Error(`HTTP ${r.status}: ${text.slice(0, 240)}`);
    return JSON.parse(text);
  } finally {
    clearTimeout(t);
  }
}

/**
 * Chat completion with provider fallback.
 * @param {{role:'system'|'user'|'assistant', content:string}[]} messages
 * @param {{temperature?:number, maxTokens?:number}} opts
 * @returns {Promise<string>} assistant reply text
 */
async function chat(messages, opts = {}) {
  const temperature = opts.temperature ?? 0.5;
  const max_tokens  = opts.maxTokens   ?? 220;

  if (GROQ_KEY) {
    try {
      const r = await postJson(GROQ_URL, GROQ_KEY, {
        model: GROQ_MODEL, messages, temperature, max_tokens,
      });
      const txt = r?.choices?.[0]?.message?.content?.trim();
      if (txt) return txt;
      throw new Error('empty Groq response');
    } catch (e) {
      logger.warn('Groq chat failed, falling back to OpenAI', { error: e.message });
    }
  }

  if (OPENAI_KEY) {
    const r = await postJson(OPENAI_URL, OPENAI_KEY, {
      model: OPENAI_MODEL, messages, temperature, max_tokens,
    });
    const txt = r?.choices?.[0]?.message?.content?.trim();
    if (txt) return txt;
    throw new Error('empty OpenAI response');
  }

  throw new Error('No AI provider configured (set GROQ_API_KEY or OPENAI_API_KEY)');
}

module.exports = { chat };
