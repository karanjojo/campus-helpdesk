/**
 * Nova - AI Campus Helpdesk (frontend)
 * ------------------------------------
 * The browser never talks to an LLM directly. It calls our own backend
 * (POST /api/chat), which holds the API key, injects the university knowledge
 * base into the system prompt and returns { answer, category, grounded, flags }.
 *
 * Everything in this file is presentation only - it never invents an answer.
 */
'use strict';

/* -------------------------------------------------------------------------
   Constants
   ------------------------------------------------------------------------- */
const MAX_LENGTH = 500;

/** Starter question sent when a help category is clicked. */
const TOPIC_QUESTIONS = {
  Academics: 'Whom should I contact for academic problems?',
  Attendance: 'What is the minimum attendance requirement?',
  Examinations: 'Where can I find the examination timetable?',
  Placements: 'Whom should I contact for placement training?',
  Hostel: 'How can I raise a hostel complaint?',
  Library: 'What are the timings and rules for accessing library resources?',
  Administration: 'Who do I contact for certificates and student records?',
  Events: 'Where are university event announcements published?',
};

/** The acceptance-test questions from the problem statement. */
const SUGGESTED_QUESTIONS = [
  'Whom should I contact for academic problems?',
  'Where can I find the examination timetable?',
  'Whom should I contact for placement training?',
  'How can I raise a hostel complaint?',
  'What is the exact date of my next examination?',
];

const WELCOME_MESSAGE =
  "Hello! I am <strong>Nova</strong>, Presidency University's AI agent. I can guide you across " +
  '<strong>Academics, Examinations, Placements, Hostel, Library, Administration</strong>, and ' +
  '<strong>Campus Events</strong>. Every answer I give comes from the official university ' +
  'knowledge base - if I do not have the exact detail, I will tell you which office to contact.';

/* -------------------------------------------------------------------------
   DOM references
   ------------------------------------------------------------------------- */
const els = {
  modal: document.getElementById('chat-modal'),
  messages: document.getElementById('chat-messages'),
  form: document.getElementById('chat-form'),
  input: document.getElementById('chat-input'),
  send: document.getElementById('nova-send'),
  clear: document.getElementById('nova-clear'),
  close: document.getElementById('nova-close'),
  category: document.getElementById('active-modal-category'),
  suggestions: document.getElementById('nova-suggestions'),
  modelPill: document.getElementById('nova-model-pill'),
  statusDot: document.getElementById('nova-status-dot'),
  promptText: document.getElementById('prompt-typing-text'),
};

/* -------------------------------------------------------------------------
   State
   ------------------------------------------------------------------------- */
const state = {
  /** Conversation sent to the backend: [{ role, content }] */
  history: [],
  /** True while a request is in flight. */
  busy: false,
  /** Session id so the server can restore context after a reload. */
  sessionId: readLocal('campus-helpdesk-session') || randomId(),
  /** Feedback map persisted locally: messageId -> 'yes' | 'no' */
  feedback: readJsonLocal('campus-helpdesk-feedback') || {},
  /** Whether the backend reported a usable LLM key. */
  aiEnabled: null,
};

/* -------------------------------------------------------------------------
   Small helpers
   ------------------------------------------------------------------------- */
function readLocal(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeLocal(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* private mode - the app still works, it just forgets between reloads */
  }
}

function readJsonLocal(key) {
  try {
    return JSON.parse(localStorage.getItem(key));
  } catch {
    return null;
  }
}

function writeJsonLocal(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* ignore */
  }
}

function randomId() {
  return 's-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
}

/** Escape text before injecting it into the DOM. */
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Render the small subset of markdown the model is asked to produce:
 * bullet lists, **bold** and paragraph breaks. The text is escaped first.
 */
function renderAnswer(text) {
  const safe = escapeHtml(text || '');
  const blocks = safe.split(/\n{2,}/);

  return blocks
    .map((block) => {
      const lines = block.split('\n');
      const html = [];
      let run = [];

      const flush = () => {
        if (!run.length) return;
        html.push(`<ul>${run.map((l) => `<li>${inline(l)}</li>`).join('')}</ul>`);
        run = [];
      };

      for (const line of lines) {
        const bullet = line.match(/^\s*[-*\u2022]\s+(.*)$/);
        if (bullet) {
          run.push(bullet[1]);
        } else {
          flush();
          html.push(`<p>${inline(line)}</p>`);
        }
      }
      flush();
      return html.join('');
    })
    .join('');
}

/** Inline markdown (bold + code) on already-escaped text. */
function inline(text) {
  return text
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code>$1</code>');
}

function scrollToBottom() {
  els.messages.scrollTop = els.messages.scrollHeight;
}

/* -------------------------------------------------------------------------
   Rendering
   ------------------------------------------------------------------------- */
function appendUserMessage(text) {
  const row = document.createElement('div');
  row.className = 'flex items-start justify-end gap-3';

  const bubble = document.createElement('div');
  bubble.className = 'bg-neutral-900 text-white p-3 rounded-lg max-w-[80%] leading-relaxed text-sm';
  bubble.textContent = text;

  row.appendChild(bubble);
  els.messages.appendChild(row);
  scrollToBottom();
}

/**
 * Append a Nova reply.
 * @param {string} html - already-rendered (escaped) answer markup
 * @param {{category?: string, grounded?: boolean, flags?: Array, id?: string, feedback?: boolean}} meta
 */
function appendBotMessage(html, meta = {}) {
  const row = document.createElement('div');
  row.className = 'flex items-start gap-3';

  const avatar = document.createElement('div');
  avatar.className =
    'w-7 h-7 rounded-full bg-orange-600 text-white flex items-center justify-center font-mono-custom text-xs flex-shrink-0 mt-0.5';
  avatar.setAttribute('aria-hidden', 'true');
  avatar.textContent = 'N';

  const col = document.createElement('div');
  col.className = 'flex flex-col gap-1.5 min-w-0';

  const bubble = document.createElement('div');
  bubble.className =
    'nova-answer bg-white p-3.5 rounded-lg border border-black/10 max-w-[85%] shadow-sm leading-relaxed text-neutral-800';
  bubble.innerHTML = html;
  col.appendChild(bubble);

  // --- meta chips: category, grounded source, unverified claims ---
  const chips = document.createElement('div');
  chips.className = 'flex flex-wrap items-center gap-1.5 font-mono-custom text-[10px]';

  if (meta.category) {
    const badge = document.createElement('span');
    badge.className =
      'px-1.5 py-0.5 rounded border border-orange-300 bg-orange-100 text-orange-800';
    badge.textContent = meta.category.toUpperCase();
    chips.appendChild(badge);
  }

  if (meta.grounded) {
    const src = document.createElement('span');
    src.className =
      'px-1.5 py-0.5 rounded border border-emerald-300 bg-emerald-50 text-emerald-800';
    src.textContent = 'SOURCE: UNIVERSITY KNOWLEDGE BASE';
    chips.appendChild(src);
  } else {
    const warn = document.createElement('span');
    warn.className = 'px-1.5 py-0.5 rounded border border-amber-300 bg-amber-50 text-amber-800';
    warn.textContent = 'NOT FROM KNOWLEDGE BASE';
    chips.appendChild(warn);
  }

  if (Array.isArray(meta.flags) && meta.flags.length) {
    const detail = meta.flags.map((f) => `${f.label}: ${f.value}`).join(', ');
    const flag = document.createElement('span');
    flag.className =
      'px-1.5 py-0.5 rounded border border-amber-400 bg-amber-100 text-amber-900';
    flag.textContent = 'COULD NOT VERIFY: ' + detail;
    flag.title = 'These details do not appear in knowledge.json. Confirm with the university.';
    chips.appendChild(flag);
  }

  if (chips.childElementCount) col.appendChild(chips);

  // --- feedback row ---
  if (meta.feedback !== false) {
    col.appendChild(buildFeedback(meta.id || String(Date.now())));
  }

  row.appendChild(avatar);
  row.appendChild(col);
  els.messages.appendChild(row);
  scrollToBottom();
  return row;
}

/** Build the "Was this answer helpful? Yes / No" row. */
function buildFeedback(messageId) {
  const row = document.createElement('div');
  row.className =
    'nova-feedback flex items-center gap-2 font-mono-custom text-[10px] text-neutral-500';

  const label = document.createElement('span');
  label.textContent = 'WAS THIS ANSWER HELPFUL?';
  row.appendChild(label);

  const yes = document.createElement('button');
  yes.type = 'button';
  yes.textContent = 'YES';
  yes.setAttribute('aria-label', 'Yes, this answer was helpful');

  const no = document.createElement('button');
  no.type = 'button';
  no.textContent = 'NO';
  no.setAttribute('aria-label', 'No, this answer was not helpful');

  const thanks = document.createElement('span');
  thanks.textContent = 'Thanks for the feedback!';
  thanks.className = 'text-emerald-700';

  const saved = state.feedback[messageId];
  if (saved) {
    (saved === 'yes' ? yes : no).setAttribute('aria-pressed', 'true');
    row.appendChild(thanks);
  }

  const apply = (value) => {
    yes.setAttribute('aria-pressed', String(value === 'yes'));
    no.setAttribute('aria-pressed', String(value === 'no'));
    state.feedback[messageId] = value;
    writeJsonLocal('campus-helpdesk-feedback', state.feedback);
    if (!thanks.isConnected) row.appendChild(thanks);
  };

  yes.addEventListener('click', () => apply('yes'));
  no.addEventListener('click', () => apply('no'));

  row.appendChild(yes);
  row.appendChild(no);
  return row;
}

/** Show the "Nova is thinking" indicator. */
function showTyping() {
  const row = document.createElement('div');
  row.id = 'nova-typing';
  row.className = 'flex items-start gap-3';

  const avatar = document.createElement('div');
  avatar.className =
    'w-7 h-7 rounded-full bg-orange-600 text-white flex items-center justify-center font-mono-custom text-xs flex-shrink-0 mt-0.5';
  avatar.setAttribute('aria-hidden', 'true');
  avatar.textContent = 'N';

  const bubble = document.createElement('div');
  bubble.className =
    'bg-white p-3.5 rounded-lg border border-black/10 shadow-sm flex items-center';
  const dots = document.createElement('div');
  dots.className = 'nova-dots';
  dots.innerHTML = '<span></span><span></span><span></span>';
  bubble.appendChild(dots);

  row.appendChild(avatar);
  row.appendChild(bubble);
  els.messages.appendChild(row);
  scrollToBottom();
}

function hideTyping() {
  const node = document.getElementById('nova-typing');
  if (node) node.remove();
}

/* -------------------------------------------------------------------------
   Chat flow
   ------------------------------------------------------------------------- */

/**
 * Send a question to the backend and render Nova's reply.
 * @param {string} text
 */
async function sendMessage(text) {
  const message = (text ?? els.input.value).trim();
  if (!message || state.busy) return;

  if (message.length > MAX_LENGTH) {
    appendBotMessage(`<p>Please keep your question under ${MAX_LENGTH} characters.</p>`, {
      category: 'Other',
      grounded: false,
      feedback: false,
    });
    return;
  }

  // --- UI: show the student message + typing indicator ---
  els.input.value = '';
  setBusy(true);
  appendUserMessage(message);
  showTyping();

  let payload = null;

  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message,
        history: state.history.slice(-6),
        sessionId: state.sessionId,
      }),
    });

    payload = await res.json().catch(() => null);

    if (!res.ok) {
      const errorCode = payload?.error;
      let text;
      if (errorCode === 'missing_api_key') {
        text =
          '<p><strong>Nova is not configured yet.</strong> The server has no LLM API key, so I ' +
          'cannot generate an answer.</p><p>Add <code>LLM_API_KEY</code> to the <code>.env</code> ' +
          'file in the project root, then restart the server. ' +
          'Get a free key at https://aistudio.google.com/apikey</p>';
      } else if (errorCode === 'rate_limited') {
        const secs = payload?.retryAfterSeconds;
        text =
          `<p>${escapeHtml(payload?.answer || 'Nova is busy right now. Please try again in a moment.')}</p>` +
          (secs ? `<p class="text-neutral-500">You can try again in about ${secs} second${secs === 1 ? '' : 's'}.</p>` : '');
      } else if (errorCode === 'empty_message' || errorCode === 'message_too_long') {
        text = `<p>${escapeHtml(payload?.answer || 'Please type a shorter question.')}</p>`;
      } else {
        text =
          '<p>The assistant is unavailable right now, please try again in a moment.</p>';
      }
      appendBotMessage(text, { category: 'Other', grounded: false, feedback: false });
      setStatus(false);
      return;
    }
  } catch {
    appendBotMessage(
      '<p>I could not reach the campus helpdesk service. Please check that the server is ' +
        'running and try again.</p>',
      { category: 'Other', grounded: false, feedback: false }
    );
    setStatus(false);
    return;
  } finally {
    setBusy(false);
    hideTyping();
  }

  // --- Render the answer ---
  const answer = payload?.answer || 'Sorry, I could not generate an answer. Please try again.';
  appendBotMessage(renderAnswer(answer), {
    category: payload?.category || 'Other',
    grounded: Boolean(payload?.grounded),
    flags: payload?.flags || [],
    id: String(Date.now()),
  });

  // --- Keep history so follow-ups ("and for hostel?") work ---
  state.history.push({ role: 'user', content: message });
  state.history.push({ role: 'assistant', content: answer });
  if (state.history.length > 12) state.history = state.history.slice(-12);
}

/** Toggle the loading state of the composer. */
function setBusy(busy) {
  state.busy = busy;
  els.send.disabled = busy;
  els.send.textContent = busy ? 'WAITING…' : 'SEND ↵';
}

/** Update the online / unavailable indicator next to Nova's name. */
function setStatus(online) {
  els.statusDot.className =
    'w-2 h-2 rounded-full flex-shrink-0 ' + (online ? 'bg-emerald-500' : 'bg-amber-500');
}

/* -------------------------------------------------------------------------
   Modal control
   ------------------------------------------------------------------------- */
function openChat(prefill) {
  els.modal.classList.remove('hidden');
  els.modal.classList.add('flex');

  // The hero terminal types a sample query - offer it as a starting point.
  const suggested = prefill || (els.promptText ? els.promptText.textContent.trim() : '');
  if (suggested && !els.input.value) els.input.value = suggested;

  setTimeout(() => els.input.focus(), 50);
}

function closeChat() {
  els.modal.classList.add('hidden');
  els.modal.classList.remove('flex');
}

/** Select a help category: open the chat and ask the starter question. */
function selectCategory(categoryName) {
  openChat();
  setChatContext(categoryName);
  const question = TOPIC_QUESTIONS[categoryName];
  if (question) {
    els.input.value = question;
    sendMessage(question);
  }
}

/** Update the category chip shown in the modal header. */
function setChatContext(categoryName) {
  els.category.textContent = categoryName.toUpperCase() + ' DESK';
}

/** Reset the chat back to the welcome message. */
function clearChat() {
  els.messages.innerHTML = '';
  state.history = [];
  appendBotMessage(WELCOME_MESSAGE, { category: 'Other', grounded: false, feedback: false });
  els.input.focus();

  // Also forget the server-side copy of this conversation.
  fetch(`/api/session/${encodeURIComponent(state.sessionId)}`, { method: 'DELETE' }).catch(
    () => {}
  );
}

/* -------------------------------------------------------------------------
   Static UI construction
   ------------------------------------------------------------------------- */
function buildSuggestions() {
  SUGGESTED_QUESTIONS.forEach((q) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className =
      'px-2 py-1 rounded border border-black/10 bg-white/80 hover:bg-white text-[10px] text-neutral-600 transition';
    btn.textContent = q;
    btn.addEventListener('click', () => sendMessage(q));
    els.suggestions.appendChild(btn);
  });
}

/* -------------------------------------------------------------------------
   Runtime info
   ------------------------------------------------------------------------- */
async function loadRuntimeInfo() {
  try {
    const res = await fetch('/api/config');
    const cfg = await res.json();
    els.modelPill.textContent = `${cfg.model || 'LLM'} · ${cfg.provider || 'llm'}`;
    state.aiEnabled = Boolean(cfg.aiEnabled);
    setStatus(state.aiEnabled);
    if (!state.aiEnabled) els.modelPill.textContent += ' · key required';
  } catch {
    els.modelPill.textContent = 'offline';
    setStatus(false);
  }
}

/** Restore the previous conversation after a reload. */
async function restoreSession() {
  try {
    const res = await fetch(`/api/session/${encodeURIComponent(state.sessionId)}`);
    const data = await res.json();
    if (Array.isArray(data.history) && data.history.length) {
      state.history = data.history;
      for (const turn of data.history) {
        if (turn.role === 'user') appendUserMessage(turn.content);
        else
          appendBotMessage(renderAnswer(turn.content), {
            category: 'Other',
            grounded: false,
            feedback: false,
          });
      }
      return;
    }
  } catch {
    /* no stored session - fall through to the welcome message */
  }
  appendBotMessage(WELCOME_MESSAGE, { category: 'Other', grounded: false, feedback: false });
}

/* -------------------------------------------------------------------------
   Event wiring
   ------------------------------------------------------------------------- */
function initEvents() {
  els.form.addEventListener('submit', (e) => {
    e.preventDefault();
    sendMessage();
  });

  els.close.addEventListener('click', closeChat);
  els.clear.addEventListener('click', clearChat);

  // Click on the backdrop closes the dialog.
  els.modal.addEventListener('mousedown', (e) => {
    if (e.target === els.modal) closeChat();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !els.modal.classList.contains('hidden')) closeChat();
  });

  // Quick category pills inside the chat.
  document.querySelectorAll('[data-chat-topic]').forEach((btn) => {
    btn.addEventListener('click', () => {
      selectCategory(btn.dataset.chatTopic);
    });
  });
}

/* -------------------------------------------------------------------------
   Boot
   ------------------------------------------------------------------------- */
function init() {
  // The design's inline markup calls these from onclick= attributes.
  window.openChat = openChat;
  window.closeChat = closeChat;
  window.selectCategory = selectCategory;
  window.setChatContext = setChatContext;

  writeLocal('campus-helpdesk-session', state.sessionId);

  initEvents();
  buildSuggestions();
  restoreSession();
  loadRuntimeInfo();
}

document.addEventListener('DOMContentLoaded', init);
