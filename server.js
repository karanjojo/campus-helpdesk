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
  apiKey: process.env.LLM_API_KEY || '',
  model: process.env.LLM_MODEL || '',
  baseUrl: (process.env.LLM_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, ''),
  geminiBaseUrl: (
    process.env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta'
  ).replace(/\/+$/, ''),
  ollamaUrl: (process.env.OLLAMA_URL || 'http://localhost:11434').replace(/\/+$/, ''),
  ollamaModel: process.env.OLLAMA_MODEL || 'llama3.2',
  jsonMode: process.env.LLM_JSON_MODE !== 'false',
  timeoutMs: Number(process.env.LLM_TIMEOUT_MS) || 20000,
};

const MAX_MESSAGE_LENGTH = 500;
const HISTORY_TURNS = 6; // last ~6 messages (3 exchanges) so follow-ups work
const TEMPERATURE = 0.2; // low temperature -> fewer hallucinations

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
6. Respond ONLY as JSON: {"answer": string, "category": one of [Academics, Examinations, Placements, Hostel, Library, Administration, Events, Other], "grounded": boolean}. "grounded" is true only if the answer came directly from the knowledge base.

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

/** Call the Google Gemini REST API. */
async function callGemini(messages) {
  const model = CONFIG.model || 'gemini-2.5-flash';
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

  const res = await fetchWithTimeout(
    url,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
    CONFIG.timeoutMs
  );

  const data = await readJson(res);
  if (!res.ok) {
    throw new Error(providerError('Gemini', res.status, data));
  }
  const parts = data?.candidates?.[0]?.content?.parts || [];
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

  const res = await fetchWithTimeout(
    url,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${CONFIG.apiKey}`,
      },
      body: JSON.stringify(body),
    },
    CONFIG.timeoutMs
  );

  const data = await readJson(res);
  if (!res.ok) {
    throw new Error(providerError('OpenAI-compatible API', res.status, data));
  }
  const text = data?.choices?.[0]?.message?.content;
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

  const res = await fetchWithTimeout(
    url,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
    CONFIG.timeoutMs
  );

  const data = await readJson(res);
  if (!res.ok) {
    throw new Error(providerError('Ollama', res.status, data));
  }
  const text = data?.message?.content;
  if (!text || !text.trim()) throw new Error('The local model returned an empty response.');
  return text.trim();
}

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
 * Dispatch to the configured provider.
 * @param {Array<{role: string, content: string}>} messages
 * @returns {Promise<string>} the raw model text
 */
async function callLLM(messages) {
  switch (CONFIG.provider) {
    case 'gemini':
      return callGemini(messages);
    case 'openai':
    case 'openai-compatible':
      return callOpenAI(messages);
    case 'ollama':
      return callOllama(messages);
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
// Routes
// ---------------------------------------------------------------------------

app.use(cors());
app.use(express.json({ limit: '64kb' }));
app.use(express.static(PUBLIC_DIR));

/** Liveness probe. */
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    provider: CONFIG.provider,
    model: CONFIG.model || (CONFIG.provider === 'ollama' ? CONFIG.ollamaModel : ''),
    knowledgeCategories: Object.keys(KNOWLEDGE).length,
    hasApiKey: Boolean(CONFIG.apiKey),
    timestamp: new Date().toISOString(),
  });
});

/** Public, non-secret runtime info for the frontend banner. */
app.get('/api/config', (req, res) => {
  res.json({
    provider: CONFIG.provider,
    model: CONFIG.model || (CONFIG.provider === 'ollama' ? CONFIG.ollamaModel : ''),
    aiEnabled: Boolean(CONFIG.apiKey) || CONFIG.provider === 'ollama',
  });
});

/**
 * POST /api/chat
 * body: { message: string, history: [{role, content}] }
 * returns: { answer, category, grounded }
 */
app.post('/api/chat', async (req, res) => {
  const { message, history } = req.body || {};

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
  if (!CONFIG.apiKey && CONFIG.provider !== 'ollama') {
    return res.status(503).json({
      answer:
        'The assistant is unavailable right now, please try again. (The server has not been configured with an API key.)',
      category: 'Other',
      grounded: false,
      error: 'missing_api_key',
    });
  }

  try {
    // --- 3. Build prompt + call the model ---------------------------------
    const messages = buildPrompt(history, cleanMessage);
    const raw = await callLLM(messages);

    // --- 4. Parse the model output ----------------------------------------
    const { answer, category, grounded } = parseModelOutput(raw);

    return res.json({
      answer,
      category,
      grounded,
      provider: CONFIG.provider,
      model: CONFIG.model || (CONFIG.provider === 'ollama' ? CONFIG.ollamaModel : ''),
    });
  } catch (err) {
    // Never leak a stack trace or the API key to the client.
    const aborted = err && (err.name === 'AbortError' || /abort/i.test(err.message || ''));
    console.error('[chat] LLM call failed:', aborted ? 'timeout' : err.message);
    return res.status(502).json({
      answer:
        'The assistant is unavailable right now, please try again in a moment.',
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

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`\n  AI Campus Helpdesk - Presidency University`);
    console.log(`  ------------------------------------------`);
    console.log(`  Server running at  http://localhost:${PORT}`);
    console.log(`  LLM provider:     ${CONFIG.provider}`);
    console.log(`  Model:             ${CONFIG.model || CONFIG.ollamaModel}`);
    console.log(`  API key loaded:    ${CONFIG.apiKey ? 'yes' : 'NO  <-- set LLM_API_KEY in .env'}`);
    console.log(`  Knowledge entries: ${Object.keys(KNOWLEDGE).length}\n`);
  });
}

// Export for tests / reuse.
module.exports = { app, buildPrompt, parseModelOutput, callLLM, KNOWLEDGE };
