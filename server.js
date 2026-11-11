/**
 * AI Campus Helpdesk - backend server
 * ------------------------------------
 * Architecture:
 *   Browser (static frontend in /public)  ->  Express backend  ->  LLM provider
 *
 * The LLM API key is read from the environment (.env) and NEVER sent to the
 * browser. All model calls happen here, server-side.
 *
 * The model is grounded by injecting `knowledge.json` into the system prompt.
 * A low temperature plus an explicit "unknown query" rule keeps the assistant
 * from inventing dates, emails, phone numbers, timings or percentages.
 * On top of the prompt, `verifyGrounding()` re-checks the answer server-side:
 * any concrete fact (email, phone, date, percentage, link, number) that does
 * not appear in the knowledge base is reported back as an unverified claim.
 */

'use strict';

require('dotenv').config();

const path = require('path');
const fs = require('fs');
const express = require('express');
const cors = require('cors');

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const CONFIG = {
  provider: (process.env.LLM_PROVIDER || 'gemini').toLowerCase(),
  apiKey: (process.env.LLM_API_KEY || '').trim(),
  model: process.env.LLM_MODEL || '',
  fallbackModel: process.env.LLM_FALLBACK_MODEL || '',
  baseUrl: (process.env.LLM_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, ''),
  geminiBaseUrl: (
    process.env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta'
  ).replace(/\/+$/, ''),
  ollamaUrl: (process.env.OLLAMA_URL || 'http://localhost:11434').replace(/\/+$/, ''),
  ollamaModel: process.env.OLLAMA_MODEL || 'llama3.2',
  jsonMode: process.env.LLM_JSON_MODE !== 'false',
  timeoutMs: Number(process.env.LLM_TIMEOUT_MS) || 20000,
  maxRetries: Number(process.env.LLM_MAX_RETRIES) || 2,
};

/** Placeholder values shipped in .env.example - treated as "no key configured". */
const PLACEHOLDER_KEYS = ['PASTE_YOUR_GEMINI_API_KEY_HERE', 'your-api-key-here'];

/** True when a usable API key is configured (Ollama needs no key). */
function hasApiKey() {
  if (CONFIG.provider === 'ollama') return true;
  return Boolean(CONFIG.apiKey) && !PLACEHOLDER_KEYS.includes(CONFIG.apiKey);
}

const MAX_MESSAGE_LENGTH = 500;
const HISTORY_TURNS = 6; // last ~6 messages (3 exchanges) so follow-ups work
const SESSION_MAX_MESSAGES = 12;
const SESSION_TTL_MS = 60 * 60 * 1000; // drop idle sessions after an hour
const TEMPERATURE = 0.2; // low temperature -> fewer hallucinations

/** How long to stay on the fallback model before re-probing the primary. */
const FALLBACK_HOLD_MS = Number(process.env.LLM_FALLBACK_HOLD_MS) || 10 * 60 * 1000;

/** Simple in-process rate limit: max N chat requests per IP per minute. */
const RATE_LIMIT = { windowMs: 60_000, max: Number(process.env.RATE_LIMIT_PER_MIN) || 30 };
const rateBuckets = new Map();

/**
 * Provider quota handling.
 *
 * The Gemini free tier allows only a handful of requests per minute. When the
 * provider says "retry in 20s", hammering it again straight away would burn the
 * quota and make things worse, so the server enters a short cooldown and
 * answers new questions with a friendly "busy" message instead.
 */
const QUOTA = {
  /** Never wait longer than this for a retry inside a single request. */
  maxInlineRetryWaitMs: Number(process.env.LLM_MAX_INLINE_RETRY_WAIT_MS) || 3000,
  /** Longest cooldown we will hold after a 429. */
  maxCooldownMs: Number(process.env.LLM_MAX_COOLDOWN_MS) || 30000,
};
let providerCooldownUntil = 0;
let providerCooldownSeconds = 0;

const ALLOWED_CATEGORIES = [
  'Academics',
  'Attendance',
  'Examinations',
  'Placements',
  'Library',
  'Hostel',
  'Administration',
  'Events',
  'Other',
];

// ---------------------------------------------------------------------------
// Knowledge base (the ONLY source of truth for the assistant)
// ---------------------------------------------------------------------------

const KNOWLEDGE_PATH = path.join(__dirname, 'knowledge.json');

function loadKnowledge() {
  try {
    const raw = fs.readFileSync(KNOWLEDGE_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') {
      throw new Error('knowledge.json is not an object');
    }
    return parsed;
  } catch (err) {
    console.error('[knowledge] Failed to load knowledge.json:', err.message);
    // Fall back to an empty base so the server still boots and answers safely.
    return {};
  }
}

const KNOWLEDGE = loadKnowledge();

/** Flatten the knowledge object into a single "Category: text" block. */
function formatKnowledge(knowledge) {
  return Object.entries(knowledge)
    .map(([category, fact]) => `- ${category}: ${fact}`)
    .join('\n');
}

/** The whole knowledge base as one lowercase blob, used for fact verification. */
const KNOWLEDGE_CORPUS = formatKnowledge(KNOWLEDGE).toLowerCase();

/** The model actually in use, falling back to a sensible default per provider. */
function effectiveModel() {
  if (CONFIG.provider === 'ollama') return CONFIG.ollamaModel;
  if (MODEL_STATE && MODEL_STATE.active) return MODEL_STATE.active;
  if (CONFIG.model) return CONFIG.model;
  return CONFIG.provider === 'openai' ? 'gpt-4o-mini' : 'gemini-3.8-flash';
}

// ---------------------------------------------------------------------------
// Prompt construction
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT_TEMPLATE = `You are the AI Campus Helpdesk for Presidency University. You help students with questions about academics, attendance, examinations, placements, hostel, library, administration and events.

RULES:
1. Answer ONLY using the KNOWLEDGE BASE below. Understand the student's intent even if they use informal wording, typos, or different words than the knowledge base.
2. If the answer is not in the knowledge base (for example an exact exam date, a specific phone number, email, fee, timing, or percentage), say clearly that this specific information is not available in the data you have, then suggest the most relevant office or channel from the knowledge base.
3. NEVER invent dates, numbers, names, emails, phone numbers, locations or policies.
4. If the question is unrelated to the university, politely say you can only help with university queries.
5. Be friendly, concise (2-4 sentences), and clear. Use a short bullet list only if it genuinely helps.
6. Respond ONLY as JSON: {"answer": string, "category": one of [Academics, Attendance, Examinations, Placements, Hostel, Library, Administration, Events, Other], "grounded": boolean}. "grounded" is true only if the answer came directly from the knowledge base.

KNOWLEDGE BASE:
{{knowledge}}`;

/**
 * Build the full message array sent to the LLM.
 * @param {Array<{role: string, content: string}>} history - prior turns
 * @param {string} userMessage - the new student question
 * @returns {Array<{role: string, content: string}>}
 */
function buildPrompt(history, userMessage) {
  const systemPrompt = SYSTEM_PROMPT_TEMPLATE.replace(
    '{{knowledge}}',
    formatKnowledge(KNOWLEDGE)
  );

  const messages = [{ role: 'system', content: systemPrompt }];

  // Keep only the most recent turns so the context stays small and cheap.
  const trimmed = Array.isArray(history) ? history.slice(-HISTORY_TURNS) : [];
  for (const turn of trimmed) {
    if (!turn || typeof turn.content !== 'string') continue;
    if (turn.role !== 'user' && turn.role !== 'assistant') continue;
    messages.push({ role: turn.role, content: turn.content.slice(0, 2000) });
  }

  messages.push({ role: 'user', content: userMessage });
  return messages;
}

// ---------------------------------------------------------------------------
// Grounding verification (server-side anti-hallucination check)
// ---------------------------------------------------------------------------

/**
 * Concrete facts the knowledge base can never legitimately contain.
 * The supplied knowledge base has no dates, emails, phone numbers, percentages
 * or links, so any of these appearing in an answer is an unverified claim.
 */
const CLAIM_PATTERNS = [
  { label: 'email address', re: /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g },
  { label: 'phone number', re: /\+?\d[\d\s().-]{7,}\d/g },
  { label: 'percentage', re: /\b\d{1,3}(?:\.\d+)?\s*%/g },
  {
    label: 'date',
    re: /\b\d{1,2}[\s./-](?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*[\s./-]\d{2,4}\b/gi,
  },
  { label: 'time', re: /\b\d{1,2}:\d{2}\s*(?:am|pm)?\b/gi },
  { label: 'link', re: /\bhttps?:\/\/\S+/gi },
  { label: 'number', re: /\b\d[\d,.]*\b/g },
];

/**
 * Re-check an answer against the knowledge base.
 *
 * The model already self-reports `grounded`, but a self-report is not a
 * guarantee. This pass looks for concrete facts (numbers, emails, dates, ...)
 * in the answer and verifies each one actually appears in the knowledge base.
 * Anything that does not is returned as a flag so the UI can warn the student.
 *
 * @param {string} answer
 * @returns {{grounded: boolean, flags: Array<{label: string, value: string}>}}
 */
function verifyGrounding(answer) {
  const flags = [];
  if (!answer) return { grounded: false, flags };

  // Strip markdown list numbering ("1.", "2)") so bullets are not read as facts.
  const text = answer.replace(/^\s*\d+[.)]\s+/gm, '').replace(/`/g, '');

  // Specific patterns first, so the generic "number" check can skip digits that
  // were already reported as part of a date, time or percentage.
  const specific = CLAIM_PATTERNS.filter((p) => p.label !== 'number');
  const generic = CLAIM_PATTERNS.find((p) => p.label === 'number');
  const consumed = [];

  for (const { label, re } of specific) {
    for (const raw of text.match(re) || []) {
      const value = raw.trim();
      if (!value) continue;
      // A fact is acceptable when it can be found verbatim in the knowledge base.
      if (KNOWLEDGE_CORPUS.includes(value.toLowerCase())) continue;
      if (!flags.some((f) => f.label === label && f.value === value)) {
        flags.push({ label, value });
        consumed.push(value.toLowerCase());
      }
    }
  }

  // Generic: any bare number the knowledge base cannot vouch for.
  for (const raw of text.match(generic.re) || []) {
    const value = raw.trim();
    if (!value) continue;
    if (KNOWLEDGE_CORPUS.includes(value.toLowerCase())) continue;
    // Already reported as part of a date / time / percentage.
    if (consumed.some((c) => c.includes(value.toLowerCase()))) continue;
    if (!flags.some((f) => f.label === 'number' && f.value === value)) {
      flags.push({ label: 'number', value });
    }
  }

  return { grounded: flags.length === 0, flags };
}

// ---------------------------------------------------------------------------
// LLM provider adapters
// ---------------------------------------------------------------------------

/** fetch with a hard timeout, so a hung provider can never hang the API. */
async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Read a response body as JSON, falling back to text. */
async function readJson(res) {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

/** Turn a provider error payload into a short, safe message (no secrets). */
function providerError(name, status, data) {
  const detail =
    data?.error?.message ||
    data?.message ||
    (typeof data?.raw === 'string' ? data.raw.slice(0, 200) : '');
  return `${name} request failed (HTTP ${status})${detail ? `: ${detail}` : ''}`;
}

/**
 * How long the provider asked us to wait before retrying.
 * Google returns this in the error body ("Please retry in 20.6s.") and
 * sometimes in a `Retry-After` header. Returns 0 when no hint is available.
 */
function retryAfterSeconds(status, headers, data) {
  const header = headers && headers.get && headers.get('retry-after');
  if (header) {
    const secs = Number(header);
    if (Number.isFinite(secs) && secs >= 0) return secs;
    const date = Date.parse(header);
    if (!Number.isNaN(date)) return Math.max(0, Math.round((date - Date.now()) / 1000));
  }
  const message = `${(data && (data.error?.message || data.message)) || ''}`;
  const match = message.match(/retry in ([\d.]+)\s*s/i);
  if (match) return Math.ceil(Number(match[1]));
  // Free-tier quota errors name the metric; assume a short cooldown.
  if (status === 429) return 20;
  return 0;
}

/**
 * Perform the provider HTTP call.
 *
 * A dropped keep-alive connection surfaces as a generic network error rather
 * than an HTTP status. It must be retried - otherwise the request hangs until
 * the timeout and the student sees an error for no good reason. A timeout is
 * retried as well, but it is reported separately so the API can still
 * distinguish "timed out" from "provider rejected".
 */
async function providerFetch(name, url, body, headers) {
  let res;
  try {
    res = await fetchWithTimeout(
      url,
      { method: 'POST', headers, body: JSON.stringify(body) },
      CONFIG.timeoutMs
    );
  } catch (err) {
    const aborted = err && (err.name === 'AbortError' || /abort/i.test(err.message || ''));
    const wrapped = new Error(
      `${name} request failed: ${(err && err.message) || 'network error'}`
    );
    wrapped.retriable = true;
    wrapped.aborted = aborted;
    throw wrapped;
  }

  const data = await readJson(res);
  if (!res.ok) {
    const err = new Error(providerError(name, res.status, data));
    // 429 (rate limited) and 5xx (server busy) are usually transient.
    err.retriable = res.status === 429 || res.status >= 500;
    err.status = res.status;
    if (res.status === 429) {
      const seconds = retryAfterSeconds(res.status, res.headers, data);
      err.retryAfterSeconds = seconds;
      err.quota = true;
      // Start a cooldown so we stop burning quota with doomed retries.
      const cooldownMs = Math.min(seconds * 1000, QUOTA.maxCooldownMs);
      providerCooldownUntil = Math.max(providerCooldownUntil, Date.now() + cooldownMs);
      providerCooldownSeconds = Math.ceil(cooldownMs / 1000);
    }
    throw err;
  }
  return data;
}

/**
 * Run a provider call with a small retry budget.
 *
 * Only transient failures (429 / 5xx / network errors) are retried, and never
 * when the provider asked us to wait longer than we are willing to block a
 * student for - in that case we surface a "busy" answer straight away.
 */
async function withRetry(label, fn) {
  let lastError;
  for (let attempt = 0; attempt <= CONFIG.maxRetries; attempt += 1) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastError = err;

      // A quota error is never retried inline: the provider asked us to wait
      // and retrying would only burn more of the quota. The cooldown below
      // handles it, and the student gets a clear "try again in N seconds".
      if (err && err.quota) {
        err.rateLimited = true;
        throw err;
      }

      const retriable = err && err.retriable === true;
      if (!retriable || attempt === CONFIG.maxRetries) break;

      const backoff = 800 * 2 ** attempt;
      console.warn(`[llm] ${label} transient failure; retrying in ${backoff}ms`);
      await sleep(backoff);
    }
  }
  throw lastError;
}

/**
 * The Gemini model currently in use.
 *
 * Free-tier API keys have a per-model quota. When the preferred model is
 * quota-blocked (HTTP 429) or unavailable (HTTP 404), the server transparently
 * falls back to a secondary model so the student still gets an answer. The
 * fallback is sticky, but the primary model is re-probed after a while.
 */
const MODEL_STATE = {
  active: null, // model id currently in use
  fallbackUntil: 0, // do not re-probe the primary before this time
};

function primaryModel() {
  return CONFIG.model || 'gemini-3.8-flash';
}

function fallbackModel() {
  return CONFIG.fallbackModel || '';
}

/** The model to use for the next request. */
function currentModel() {
  if (MODEL_STATE.active && Date.now() < MODEL_STATE.fallbackUntil) {
    return MODEL_STATE.active;
  }
  // Re-probe the primary model.
  MODEL_STATE.active = null;
  MODEL_STATE.fallbackUntil = 0;
  return primaryModel();
}

/** Remember that the primary model is unusable for a while. */
function degradeModel(reason) {
  const alt = fallbackModel();
  if (!alt || alt === MODEL_STATE.active) return;
  MODEL_STATE.active = alt;
  MODEL_STATE.fallbackUntil = Date.now() + FALLBACK_HOLD_MS;
  console.warn(
    `[llm] primary model unavailable (${reason}); using fallback model "${alt}" for ${Math.round(
      FALLBACK_HOLD_MS / 1000
    )}s`
  );
}

/** Call the Google Gemini REST API. */
async function callGemini(messages) {
  const model = currentModel();
  const url = `${CONFIG.geminiBaseUrl}/models/${encodeURIComponent(
    model
  )}:generateContent?key=${encodeURIComponent(CONFIG.apiKey)}`;

  const system = messages.find((m) => m.role === 'system');
  const contents = messages
    .filter((m) => m.role !== 'system')
    .map((m) => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }],
    }));

  const body = {
    contents,
    generationConfig: {
      temperature: TEMPERATURE,
      maxOutputTokens: 800,
    },
  };
  if (system) body.systemInstruction = { parts: [{ text: system.content }] };
  if (CONFIG.jsonMode) body.generationConfig.responseMimeType = 'application/json';

  let data;
  try {
    data = await providerFetch('Gemini', url, body, {
      'Content-Type': 'application/json',
    });
  } catch (err) {
    // Quota exhausted (429) or model retired (404): try the fallback model
    // once before giving up.
    if (err && (err.status === 429 || err.status === 404) && fallbackModel()) {
      degradeModel(`HTTP ${err.status}`);
      return callGemini(messages);
    }
    throw err;
  }

  const parts = (data && data.candidates && data.candidates[0] && data.candidates[0].content &&
    data.candidates[0].content.parts) || [];
  const text = parts.map((p) => p.text || '').join('').trim();
  if (!text) throw new Error('Gemini returned an empty response.');
  return text;
}

/** Call any OpenAI-compatible chat-completions API (OpenAI, Groq, OpenRouter...). */
async function callOpenAI(messages) {
  const model = CONFIG.model || 'gpt-4o-mini';
  const url = `${CONFIG.baseUrl}/chat/completions`;

  const body = {
    model,
    messages,
    temperature: TEMPERATURE,
    max_tokens: 800,
  };
  if (CONFIG.jsonMode) body.response_format = { type: 'json_object' };

  const data = await providerFetch('OpenAI-compatible API', url, body, {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${CONFIG.apiKey}`,
  });

  const text = data && data.choices && data.choices[0] && data.choices[0].message &&
    data.choices[0].message.content;
  if (!text || !text.trim()) throw new Error('The model returned an empty response.');
  return text.trim();
}

/** Call a locally running Ollama model. */
async function callOllama(messages) {
  const url = `${CONFIG.ollamaUrl}/api/chat`;
  const body = {
    model: CONFIG.ollamaModel,
    messages,
    stream: false,
    options: { temperature: TEMPERATURE },
  };
  if (CONFIG.jsonMode) body.format = 'json';

  const data = await providerFetch('Ollama', url, body, {
    'Content-Type': 'application/json',
  });

  const text = data && data.message && data.message.content;
  if (!text || !text.trim()) throw new Error('The local model returned an empty response.');
  return text.trim();
}

/**
 * Dispatch to the configured provider.
 * @param {Array<{role: string, content: string}>} messages
 * @returns {Promise<string>} the raw model text
 */
async function callLLM(messages) {
  switch (CONFIG.provider) {
    case 'gemini':
      return withRetry('gemini', () => callGemini(messages));
    case 'openai':
    case 'openai-compatible':
      return withRetry('openai', () => callOpenAI(messages));
    case 'ollama':
      return withRetry('ollama', () => callOllama(messages));
    default:
      throw new Error(
        `Unknown LLM_PROVIDER "${CONFIG.provider}". Use one of: gemini, openai, ollama.`
      );
  }
}

// ---------------------------------------------------------------------------
// Output parsing
// ---------------------------------------------------------------------------

/**
 * Parse the model output defensively.
 * The model is asked for JSON, but models sometimes wrap it in ```json fences
 * or add a sentence around it. If parsing fails we fall back to using the raw
 * text as the answer, tagged as category "Other" and not grounded.
 *
 * @param {string} raw
 * @returns {{answer: string, category: string, grounded: boolean}}
 */
function parseModelOutput(raw) {
  const fallback = {
    answer: (raw || '').trim() || 'Sorry, I could not generate an answer. Please try again.',
    category: 'Other',
    grounded: false,
  };
  if (!raw || typeof raw !== 'string') return fallback;

  let text = raw.trim();
  // Strip markdown code fences: ```json ... ``` or ``` ... ```
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) text = fence[1].trim();

  // Find the outermost JSON object.
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return fallback;

  let parsed;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return fallback;
  }
  if (!parsed || typeof parsed !== 'object') return fallback;

  const answer =
    typeof parsed.answer === 'string' && parsed.answer.trim()
      ? parsed.answer.trim()
      : fallback.answer;

  let category = typeof parsed.category === 'string' ? parsed.category.trim() : '';
  if (!ALLOWED_CATEGORIES.includes(category)) {
    // Case-insensitive rescue attempt, e.g. "placement" -> "Placements"
    const match = ALLOWED_CATEGORIES.find(
      (c) => c.toLowerCase() === category.toLowerCase()
    );
    category = match || 'Other';
  }

  const grounded = parsed.grounded === true;

  return { answer, category, grounded };
}

// ---------------------------------------------------------------------------
// Conversation sessions (in-memory, no database - out of scope by design)
// ---------------------------------------------------------------------------

const sessions = new Map();

/** Fetch (and refresh) a session record. */
function getSession(id) {
  if (!id) return null;
  const key = String(id).slice(0, 64);
  const existing = sessions.get(key);
  if (existing) {
    existing.updatedAt = Date.now();
    return existing;
  }
  const created = { id: key, history: [], updatedAt: Date.now() };
  sessions.set(key, created);
  return created;
}

/** Drop sessions that have been idle for longer than the TTL. */
function pruneSessions() {
  const cutoff = Date.now() - SESSION_TTL_MS;
  for (const [key, value] of sessions) {
    if (value.updatedAt < cutoff) sessions.delete(key);
  }
}
setInterval(pruneSessions, 5 * 60 * 1000).unref?.();

// ---------------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------------

function rateLimit(req, res, next) {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  const bucket = rateBuckets.get(ip);
  if (!bucket || now - bucket.start > RATE_LIMIT.windowMs) {
    rateBuckets.set(ip, { start: now, count: 1 });
    return next();
  }
  bucket.count += 1;
  if (bucket.count > RATE_LIMIT.max) {
    const retryAfter = Math.ceil((bucket.start + RATE_LIMIT.windowMs - now) / 1000);
    res.set('Retry-After', String(retryAfter));
    return res.status(429).json({
      answer: 'You are sending questions very quickly. Please wait a moment and try again.',
      category: 'Other',
      grounded: false,
      error: 'rate_limited',
    });
  }
  return next();
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

app.use(cors());
app.use(express.json({ limit: '64kb' }));
app.use(
  express.static(PUBLIC_DIR, {
    etag: true,
    setHeaders(res, filePath) {
      // The shell must never be stale; assets can be cached.
      if (filePath.endsWith('index.html')) res.setHeader('Cache-Control', 'no-cache');
    },
  })
);

/** Liveness probe. */
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    provider: CONFIG.provider,
    model: effectiveModel(),
    knowledgeCategories: Object.keys(KNOWLEDGE).length,
    hasApiKey: hasApiKey(),
    cooldownSeconds: cooldownRemainingSeconds(),
    timestamp: new Date().toISOString(),
  });
});

/** Public, non-secret runtime info for the frontend banner. */
app.get('/api/config', (req, res) => {
  res.json({
    provider: CONFIG.provider,
    model: effectiveModel(),
    aiEnabled: hasApiKey(),
    maxMessageLength: MAX_MESSAGE_LENGTH,
    categories: Object.keys(KNOWLEDGE),
    cooldownSeconds: cooldownRemainingSeconds(),
  });
});

/** The knowledge base, so the UI can show the real categories and sources. */
app.get('/api/knowledge', (req, res) => {
  res.json({
    knowledge: KNOWLEDGE,
    categories: Object.keys(KNOWLEDGE),
    source: 'knowledge.json',
  });
});

/** Restore a stored conversation (used to survive a page reload). */
app.get('/api/session/:id', (req, res) => {
  const session = getSession(req.params.id);
  res.json({ sessionId: session.id, history: session.history });
});

/** Forget a stored conversation - this is what "Clear Chat" calls. */
app.delete('/api/session/:id', (req, res) => {
  const session = sessions.get(String(req.params.id).slice(0, 64));
  if (session) session.history = [];
  res.json({ ok: true, sessionId: req.params.id, history: [] });
});

/** Seconds left on the provider cooldown, 0 when the provider is healthy. */
function cooldownRemainingSeconds() {
  if (providerCooldownUntil <= Date.now()) return 0;
  return Math.ceil((providerCooldownUntil - Date.now()) / 1000);
}

/**
 * POST /api/chat
 * body: { message: string, history?: [{role, content}], sessionId?: string }
 * returns: { answer, category, grounded, flags }
 */
app.post('/api/chat', rateLimit, async (req, res) => {
  const { message, history, sessionId } = req.body || {};

  // --- 1. Validate input ---------------------------------------------------
  if (typeof message !== 'string' || !message.trim()) {
    return res.status(400).json({
      answer: 'Please type a question so I can help you.',
      category: 'Other',
      grounded: false,
      error: 'empty_message',
    });
  }
  const cleanMessage = message.trim();
  if (cleanMessage.length > MAX_MESSAGE_LENGTH) {
    return res.status(400).json({
      answer: `That message is a bit long (${cleanMessage.length} characters). Please keep it under ${MAX_MESSAGE_LENGTH} characters.`,
      category: 'Other',
      grounded: false,
      error: 'message_too_long',
    });
  }

  // --- 2. Guard: no key configured ----------------------------------------
  if (!hasApiKey()) {
    return res.status(503).json({
      answer:
        'The assistant is unavailable right now, please try again. (The server has not been configured with an API key.)',
      category: 'Other',
      grounded: false,
      error: 'missing_api_key',
    });
  }

  // --- 3. Guard: the provider is cooling down after a quota error ----------
  const cooldown = cooldownRemainingSeconds();
  if (cooldown > 0) {
    res.set('Retry-After', String(cooldown));
    return res.status(429).json({
      answer: `The assistant is busy handling other questions right now. Please try again in about ${cooldown} second${cooldown === 1 ? '' : 's'}.`,
      category: 'Other',
      grounded: false,
      error: 'rate_limited',
      retryAfterSeconds: cooldown,
    });
  }

  try {
    // --- 4. Work out which history to use ---------------------------------
    // The client may send its own history; otherwise we use the stored session.
    const session = sessionId ? getSession(sessionId) : null;
    let contextHistory;
    if (Array.isArray(history) && history.length) {
      contextHistory = history;
    } else if (session) {
      contextHistory = session.history;
    } else {
      contextHistory = [];
    }

    // --- 5. Build prompt + call the model ---------------------------------
    const messages = buildPrompt(contextHistory, cleanMessage);
    const raw = await callLLM(messages);

    // --- 6. Parse + verify the model output -------------------------------
    const { answer, category, grounded: modelClaimed } = parseModelOutput(raw);
    const verification = verifyGrounding(answer);
    const grounded = modelClaimed && verification.grounded;

    // --- 7. Persist the turn so follow-ups keep their context ------------
    if (session) {
      session.history.push({ role: 'user', content: cleanMessage });
      session.history.push({ role: 'assistant', content: answer });
      if (session.history.length > SESSION_MAX_MESSAGES) {
        session.history = session.history.slice(-SESSION_MAX_MESSAGES);
      }
      session.updatedAt = Date.now();
    }

    return res.json({
      answer,
      category,
      grounded,
      flags: verification.flags,
      provider: CONFIG.provider,
      model: effectiveModel(),
    });
  } catch (err) {
    // Never leak a stack trace or the API key to the client.
    const aborted =
      err && (err.aborted === true || err.name === 'AbortError' || /abort/i.test(err.message || ''));
    const quota = err && err.quota === true;
    console.error(
      '[chat] LLM call failed:',
      aborted ? 'timeout' : quota ? 'provider quota exceeded' : err.message
    );

    if (quota) {
      const cooldown = cooldownRemainingSeconds();
      res.set('Retry-After', String(cooldown));
      return res.status(429).json({
        answer: `The assistant is busy handling other questions right now. Please try again in about ${cooldown} second${cooldown === 1 ? '' : 's'}.`,
        category: 'Other',
        grounded: false,
        error: 'rate_limited',
        retryAfterSeconds: cooldown,
      });
    }

    return res.status(502).json({
      answer: 'The assistant is unavailable right now, please try again in a moment.',
      category: 'Other',
      grounded: false,
      error: aborted ? 'timeout' : 'llm_error',
    });
  }
});

// Fallback for unknown routes -> serve the frontend shell.
app.use((req, res, next) => {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ error: 'not_found' });
  }
  next();
});

/**
 * Friendly error handler.
 * Catches malformed JSON bodies (and any other server error) so the client
 * always receives a readable JSON payload instead of an HTML stack trace.
 */
app.use((err, req, res, next) => {
  const isBadBody = err && (err.type === 'entity.parse.failed' || err instanceof SyntaxError);
  console.warn('[server] Request error:', isBadBody ? 'malformed JSON body' : err.message);
  if (res.headersSent) return next(err);
  return res.status(isBadBody ? 400 : 500).json({
    answer: 'The assistant is unavailable right now, please try again.',
    category: 'Other',
    grounded: false,
    error: isBadBody ? 'invalid_request' : 'server_error',
  });
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`\n  AI Campus Helpdesk - Presidency University`);
    console.log(`  ------------------------------------------`);
    console.log(`  Server running at  http://localhost:${PORT}`);
    console.log(`  LLM provider:     ${CONFIG.provider}`);
    console.log(`  Model:             ${effectiveModel()}`);
    console.log(`  API key loaded:    ${hasApiKey() ? 'yes' : 'NO  <-- set LLM_API_KEY in .env'}`);
    console.log(`  Knowledge entries: ${Object.keys(KNOWLEDGE).length}\n`);
  });
}

// Export for tests / reuse.
module.exports = {
  app,
  buildPrompt,
  parseModelOutput,
  verifyGrounding,
  callLLM,
  KNOWLEDGE,
};
