/**
 * AI Campus Helpdesk - frontend
 * -----------------------------
 * The browser never talks to the LLM directly. It calls our own backend
 * (POST /api/chat) which holds the API key and performs the model call.
 */
'use strict';

/* -------------------------------------------------------------------------
   Constants
   ------------------------------------------------------------------------- */
const MAX_LENGTH = 500;

/** Starter question used when a topic chip / sidebar link is clicked. */
const TOPIC_QUESTIONS = {
  Academics: 'Whom should I contact for academic problems?',
  Examinations: 'Where can I find the examination timetable?',
  Placements: 'Whom should I contact for placement training?',
  Hostel: 'How can I raise a hostel complaint?',
  Library: 'What are the timings and rules for accessing library resources?',
  Administration: 'Who do I contact for certificates and student records?',
};

/** The five acceptance-test questions from the problem statement. */
const SUGGESTED_QUESTIONS = [
  'Whom should I contact for academic problems?',
  'Where can I find the examination timetable?',
  'Whom should I contact for placement training?',
  'How can I raise a hostel complaint?',
  'What is the exact date of my next examination?',
];

const WELCOME_MESSAGE =
  "Hi! I'm the AI Campus Helpdesk for Presidency University. Ask me about academics, attendance, exams, placements, hostel, library, administration or events, and I'll point you to the right place.";

/* -------------------------------------------------------------------------
   DOM references
   ------------------------------------------------------------------------- */
const els = {
  chatLog: document.getElementById('chatLog'),
  form: document.getElementById('chatForm'),
  input: document.getElementById('messageInput'),
  sendBtn: document.getElementById('sendBtn'),
  clearBtn: document.getElementById('clearBtn'),
  charCount: document.getElementById('charCount'),
  suggestionList: document.getElementById('suggestionList'),
  categoryChips: document.getElementById('categoryChips'),
  modelPill: document.getElementById('modelPill'),
  statusDot: document.getElementById('statusDot'),
  statusText: document.getElementById('statusText'),
  themeToggle: document.getElementById('themeToggle'),
  menuToggle: document.getElementById('menuToggle'),
  sidebar: document.getElementById('sidebar'),
  sidebarScrim: document.getElementById('sidebarScrim'),
};

/* -------------------------------------------------------------------------
   State
   ------------------------------------------------------------------------- */
const state = {
  /** Conversation history sent to the backend: [{ role, content }] */
  history: [],
  /** True while a request is in flight. */
  busy: false,
  /** Feedback map persisted locally: messageId -> 'yes' | 'no' */
  feedback: readLocal('campus-helpdesk-feedback') || {},
};

/* -------------------------------------------------------------------------
   Small helpers
   ------------------------------------------------------------------------- */
function readLocal(key) {
  try {
    return JSON.parse(localStorage.getItem(key));
  } catch {
    return null;
  }
}

function writeLocal(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage may be unavailable (private mode) - feedback still works in-session */
  }
}

function nowLabel() {
  return new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/** Escape user/model text before injecting it into the DOM. */
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
 * bullet lists, **bold**, `code` and paragraph breaks.
 */
function renderAnswer(text) {
  const safe = escapeHtml(text || '');
  const blocks = safe.split(/\n{2,}/);

  return blocks
    .map((block) => {
      const lines = block.split('\n');
      // A block may mix bullet lines with plain lines - walk it and group
      // consecutive bullets into <ul> runs.
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
  els.chatLog.scrollTop = els.chatLog.scrollHeight;
}

/* -------------------------------------------------------------------------
   Rendering
   ------------------------------------------------------------------------- */

/**
 * Append a message bubble to the chat log.
 * @param {'user'|'bot'} role
 * @param {string} text
 * @param {{category?: string, grounded?: boolean, id?: string, withFeedback?: boolean}} meta
 */
function addMessage(role, text, meta = {}) {
  const wrap = document.createElement('div');
  wrap.className = `msg msg--${role}`;

  const avatar = document.createElement('div');
  avatar.className = 'avatar';
  avatar.setAttribute('aria-hidden', 'true');
  avatar.textContent = role === 'user' ? '🙋' : '🎓';

  const body = document.createElement('div');
  body.className = 'msg__body';

  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  bubble.innerHTML = role === 'bot' ? renderAnswer(text) : `<p>${escapeHtml(text)}</p>`;
  body.appendChild(bubble);

  // ---- meta row: time, category badge, grounded source tag ----
  const metaRow = document.createElement('div');
  metaRow.className = 'msg__meta';

  const time = document.createElement('span');
  time.textContent = nowLabel();
  metaRow.appendChild(time);

  if (role === 'bot' && meta.category) {
    const badge = document.createElement('span');
    badge.className = 'badge';
    badge.textContent = meta.category;
    metaRow.appendChild(badge);
  }
  if (role === 'bot' && meta.grounded) {
    const src = document.createElement('span');
    src.className = 'badge badge--source';
    src.textContent = 'Source: University knowledge base';
    metaRow.appendChild(src);
  }
  body.appendChild(metaRow);

  // ---- feedback row ----
  if (role === 'bot' && meta.withFeedback !== false) {
    body.appendChild(buildFeedback(meta.id || String(Date.now())));
  }

  wrap.appendChild(avatar);
  wrap.appendChild(body);
  els.chatLog.appendChild(wrap);
  scrollToBottom();
  return wrap;
}

/** Build the "Was this answer helpful? Yes / No" row. */
function buildFeedback(messageId) {
  const row = document.createElement('div');
  row.className = 'feedback';

  const label = document.createElement('span');
  label.textContent = 'Was this answer helpful?';
  row.appendChild(label);

  const yes = document.createElement('button');
  yes.type = 'button';
  yes.className = 'fb-btn';
  yes.textContent = 'Yes';
  yes.setAttribute('aria-label', 'Yes, this answer was helpful');

  const no = document.createElement('button');
  no.type = 'button';
  no.className = 'fb-btn';
  no.textContent = 'No';
  no.setAttribute('aria-label', 'No, this answer was not helpful');

  const thanks = document.createElement('span');
  thanks.className = 'feedback__thanks';
  thanks.textContent = 'Thanks for the feedback!';

  const saved = state.feedback[messageId];
  if (saved) {
    (saved === 'yes' ? yes : no).classList.add('is-selected');
    row.appendChild(thanks);
  }

  const apply = (value) => {
    yes.classList.toggle('is-selected', value === 'yes');
    no.classList.toggle('is-selected', value === 'no');
    state.feedback[messageId] = value;
    writeLocal('campus-helpdesk-feedback', state.feedback);
    if (!thanks.isConnected) row.appendChild(thanks);
  };

  yes.addEventListener('click', () => apply('yes'));
  no.addEventListener('click', () => apply('no'));

  row.appendChild(yes);
  row.appendChild(no);
  return row;
}

/** Show / remove the "typing..." indicator. */
function showTyping() {
  const wrap = document.createElement('div');
  wrap.className = 'msg msg--bot';
  wrap.id = 'typingIndicator';

  const avatar = document.createElement('div');
  avatar.className = 'avatar';
  avatar.setAttribute('aria-hidden', 'true');
  avatar.textContent = '🎓';

  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  bubble.innerHTML = '<div class="typing"><span></span><span></span><span></span></div>';

  wrap.appendChild(avatar);
  wrap.appendChild(bubble);
  els.chatLog.appendChild(wrap);
  scrollToBottom();
}

function hideTyping() {
  const node = document.getElementById('typingIndicator');
  if (node) node.remove();
}

/* -------------------------------------------------------------------------
   Chat flow
   ------------------------------------------------------------------------- */

/**
 * Send a message to the backend and render the reply.
 * @param {string} text
 */
async function sendMessage(text) {
  const message = (text ?? els.input.value).trim();
  if (!message || state.busy) return;

  if (message.length > MAX_LENGTH) {
    addMessage('bot', `Please keep your question under ${MAX_LENGTH} characters.`, {
      category: 'Other',
      grounded: false,
      withFeedback: false,
    });
    return;
  }

  // --- UI: show the student message + typing indicator ---
  els.input.value = '';
  autoGrow();
  updateCount();
  setBusy(true);
  addMessage('user', message);
  showTyping();

  // --- API call ---
  let payload;
  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message, history: state.history.slice(-6) }),
    });

    payload = await res.json().catch(() => null);

    if (!res.ok) {
      hideTyping();
      addMessage(
        'bot',
        payload?.answer ||
          'The assistant is unavailable right now, please try again in a moment.',
        { category: 'Other', grounded: false }
      );
      setStatus(false);
      return;
    }
  } catch (err) {
    hideTyping();
    addMessage(
      'bot',
      'I could not reach the campus helpdesk service. Please check that the server is running and try again.',
      { category: 'Other', grounded: false }
    );
    setStatus(false);
    return;
  } finally {
    setBusy(false);
    hideTyping();
  }

  // --- Render the answer ---
  const answer = payload?.answer || 'Sorry, I could not generate an answer. Please try again.';
  const id = String(Date.now());
  addMessage('bot', answer, {
    category: payload?.category || 'Other',
    grounded: Boolean(payload?.grounded),
    id,
  });

  // --- Keep history for follow-ups (last 6 turns) ---
  state.history.push({ role: 'user', content: message });
  state.history.push({ role: 'assistant', content: answer });
  if (state.history.length > 6) state.history = state.history.slice(-6);
}

/** Toggle the loading state of the composer. */
function setBusy(busy) {
  state.busy = busy;
  els.sendBtn.disabled = busy;
  els.sendBtn.innerHTML = busy
    ? '<span aria-hidden="true">⏳</span> Sending…'
    : '<span aria-hidden="true">➤</span> Send';
}

/** Update the "assistant online / unavailable" indicator. */
function setStatus(online) {
  els.statusDot.className = `dot ${online ? 'dot--live' : 'dot--down'}`;
  els.statusText.textContent = online ? 'Assistant online' : 'Assistant unavailable';
}

/* -------------------------------------------------------------------------
   Composer helpers
   ------------------------------------------------------------------------- */

/** Auto-grow the textarea as the student types. */
function autoGrow() {
  els.input.style.height = 'auto';
  els.input.style.height = `${Math.min(els.input.scrollHeight, 140)}px`;
}

function updateCount() {
  els.charCount.textContent = `${els.input.value.length}/${MAX_LENGTH}`;
}

/* -------------------------------------------------------------------------
   Static UI construction
   ------------------------------------------------------------------------- */

/** Build the suggested-question chips under the composer. */
function buildSuggestions() {
  SUGGESTED_QUESTIONS.forEach((q) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'sugg';
    btn.textContent = q;
    btn.addEventListener('click', () => sendMessage(q));
    els.suggestionList.appendChild(btn);
  });
}

/** Reset the chat to the welcome message. */
function clearChat() {
  els.chatLog.innerHTML = '';
  state.history = [];
  setStatus(true);
  addMessage('bot', WELCOME_MESSAGE, {
    category: 'Other',
    grounded: false,
    withFeedback: false,
  });
  els.input.focus();
}

/* -------------------------------------------------------------------------
   Theme
   ------------------------------------------------------------------------- */
function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  writeLocal('campus-helpdesk-theme', theme);
}

function initTheme() {
  let theme = readLocal('campus-helpdesk-theme');
  if (!theme) {
    theme =
      window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches
        ? 'dark'
        : 'light';
  }
  applyTheme(theme);
  els.themeToggle.addEventListener('click', () => {
    const next =
      document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    applyTheme(next);
  });
}

/* -------------------------------------------------------------------------
   Sidebar (mobile drawer)
   ------------------------------------------------------------------------- */
function initSidebar() {
  els.menuToggle.addEventListener('click', () => {
    const open = !els.sidebar.classList.contains('is-open');
    els.sidebar.classList.toggle('is-open', open);
    els.sidebarScrim.hidden = !open;
    els.menuToggle.setAttribute('aria-expanded', String(open));
  });

  els.sidebarScrim.addEventListener('click', closeSidebar);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeSidebar();
  });
}

/** Close the mobile drawer and reset the menu button state. */
function closeSidebar() {
  els.sidebar.classList.remove('is-open');
  els.sidebarScrim.hidden = true;
  els.menuToggle.setAttribute('aria-expanded', 'false');
}

/* -------------------------------------------------------------------------
   Runtime info
   ------------------------------------------------------------------------- */
async function loadRuntimeInfo() {
  try {
    const res = await fetch('/api/config');
    const cfg = await res.json();
    const model = cfg.model || cfg.provider || 'LLM';
    els.modelPill.textContent = `${model} · ${cfg.provider || 'llm'}`;
    setStatus(Boolean(cfg.aiEnabled));
  } catch {
    els.modelPill.textContent = 'AI assistant';
  }
}

/* -------------------------------------------------------------------------
   Event wiring
   ------------------------------------------------------------------------- */
function initEvents() {
  els.form.addEventListener('submit', (e) => {
    e.preventDefault();
    sendMessage();
  });

  // Enter sends, Shift+Enter inserts a newline.
  els.input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });

  els.input.addEventListener('input', () => {
    autoGrow();
    updateCount();
  });

  els.clearBtn.addEventListener('click', clearChat);

  // Topic chips + sidebar links -> pre-fill and send the starter question.
  document.querySelectorAll('[data-topic]').forEach((el) => {
    el.addEventListener('click', () => {
      const topic = el.dataset.topic;
      const question = TOPIC_QUESTIONS[topic];
      if (!question) return;
      els.input.value = question;
      updateCount();
      sendMessage(question);
      // Close the mobile drawer if it is open.
      closeSidebar();
    });
  });

  // Sidebar "Home" -> scroll back to top.
  document.querySelectorAll('[data-nav="home"]').forEach((el) => {
    el.addEventListener('click', () => {
      window.scrollTo({ top: 0, behavior: 'smooth' });
      els.input.focus();
    });
  });

  // Highlight the active sidebar entry.
  document.querySelectorAll('.nav-link[data-topic]').forEach((el) => {
    el.addEventListener('click', () => {
      document.querySelectorAll('.nav-link').forEach((n) => n.classList.remove('is-active'));
      el.classList.add('is-active');
    });
  });
}

/* -------------------------------------------------------------------------
   Boot
   ------------------------------------------------------------------------- */
function init() {
  initTheme();
  initSidebar();
  initEvents();
  buildSuggestions();
  clearChat();
  loadRuntimeInfo();
}

document.addEventListener('DOMContentLoaded', init);
