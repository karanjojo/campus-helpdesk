# AI-Powered University Campus Helpdesk — Presidency University

A web app built for **Technopia 2.0** (Presidency University, School of Computer Science &
Engineering). A student types a question in plain English and an LLM answers using **only** the
fixed university knowledge base supplied with the problem statement — academics, attendance,
examinations, placements, hostel, library, administration and events.

If the answer is not in the knowledge base, the assistant **says so clearly** and points the
student to the right office instead of inventing a date, email, phone number, timing or percentage.

The site is the **Google Stitch** design *“Presidency University — AI Helpdesk & Nova Agent”*
(project `207563885384410251`, screen `c21a0b2027584509b7fa64981832b8f3`), with the Stitch
keyword-matching placeholder bot replaced by a real, backend-backed AI agent.

---

## Table of contents

1. [Features](#features)
2. [Tech stack](#tech-stack)
3. [The design](#the-design)
4. [AI model / API used](#ai-model--api-used)
5. [How the AI is integrated](#how-the-ai-is-integrated)
6. [Setup and running the app](#setup-and-running-the-app)
7. [Configuration reference](#configuration-reference)
8. [Project structure](#project-structure)
9. [API reference](#api-reference)
10. [Security note](#security-note)
11. [Testing / acceptance checks](#testing--acceptance-checks)
12. [Known limits](#known-limits)
13. [AI tools disclosure](#ai-tools-disclosure)
14. [License](#license)

---

## Features

- **Stitch landing page** — hero, live query terminal, seven help-category cards, feature
  walkthrough, student voices and a Three.js **3D “Nova” robot** on the page background.
- **A real LLM does the answering.** No hardcoded question/answer pairs and no keyword lookup
  table — the model reads the question and writes the reply. (The Stitch export shipped a fake
  keyword bot; that was removed and replaced with a call to the backend.)
- **Grounded in a fixed knowledge base.** `knowledge.json` is injected into the system prompt on
  every call, so answers come from the university’s own wording.
- **Anti-hallucination by design.** Low temperature (0.2), a strict “answer only from the knowledge
  base” rule, an explicit unknown-query rule, and a `grounded` flag on every reply.
- **Server-side fact checking.** Every answer is re-scanned for concrete facts — email addresses,
  phone numbers, dates, percentages, links and bare numbers. Anything that cannot be found in
  `knowledge.json` is reported back as an unverified claim and surfaced in the UI.
- **Visible provenance.** Each reply carries a category badge plus either
  `SOURCE: UNIVERSITY KNOWLEDGE BASE` or `NOT FROM KNOWLEDGE BASE`.
- **Chat modal** — Nova bubble vs. student bubble, “typing…” indicator, Enter to send,
  suggestion chips, and a working **CLEAR** button.
- **Seven category shortcuts** that open the chat and send a ready-made starter question, so
  every knowledge-base domain is one click away.
- **Conversation memory** — the last 6 turns are replayed to the model, so follow-ups like
  *“and for hostel?”* are understood. Conversations are also stored server-side per session id, so
  a page reload does not lose the thread.
- **Helpful / Not helpful feedback** on every bot reply, remembered in `localStorage`.
- **Provider-aware error handling** — friendly messages for a missing key, a quota cooldown, an
  empty question, a too-long question or a provider outage. Stack traces and secrets never reach
  the browser.
- **Accessible & responsive** — ARIA roles, visible keyboard focus, `prefers-reduced-motion`
  support, and a layout that works down to 375 px.

---

## Tech stack

| Layer      | Technology                                                             |
| ---------- | ---------------------------------------------------------------------- |
| Backend    | Node.js 18+ and Express 4                                             |
| Config     | `dotenv` (`.env` → environment variables)                             |
| CORS       | `cors`                                                                |
| LLM        | Provider REST API called with the built-in `fetch` (Node 18+)          |
| Frontend   | Plain HTML + vanilla JavaScript — **no build step**                     |
| Styling    | Tailwind CSS (CDN) + the Stitch design’s inline CSS                    |
| 3D         | Three.js `0.160.0` (ES module import map, unpkg) — the “Nova” robot   |
| Fonts      | Schibsted Grotesk + IBM Plex Mono (Google Fonts)                       |
| Assets     | Presidency University logo (`public/assets/`)                          |

The frontend is served statically by the same Express process, so the whole app runs with a
single `npm start`.

---

## The design

The visual design comes from the Google Stitch export. Key tokens, straight from the export:

```
background      #efece6   warm paper          accent orange  #ff8a3d
text            #141414                      accent coral   #ff5a5f
brand blue      #0b2240                      accent amber   #ffb347
surfaces        #e8e4db #f5f2ec #ffffff      accent pink    #ff3d8b
grid lines      rgba(20,20,20,.09)
display font    Schibsted Grotesk            mono font      IBM Plex Mono
```

The page keeps every section of the original design — announcement bar, sticky nav, the
typewriter query terminal, the direct-help directory, the seven category cards, the “Speak to
Nova 3D” launcher, the tabbed product walkthrough, the testimonial carousel and the footer — and
the chat modal is wired to the real backend.

Two deliberate changes:

- The remote Google-hosted logo was replaced with the supplied `public/assets/logo.png`, so the
  page has no third-party image dependency.
- The 3D scene is wrapped in a `try/catch` and respects `prefers-reduced-motion`. If WebGL is
  unavailable the page still works — the chat is the product, the robot is decoration.

> **Note for reviewers.** The stat tiles (`<15s`, `18,000+`, `7 Core Categories`) and the
> testimonials are decorative marketing copy from the design. They are *not* in `knowledge.json`
> and must never appear in an answer the agent gives.

---

## AI model / API used

| Setting     | Value                                                              |
| ----------- | ------------------------------------------------------------------ |
| Provider    | **Google Gemini** — REST API (`generativelanguage.googleapis.com`) |
| Model       | **`gemini-3.8-flash`** (fast + inexpensive; set via `LLM_MODEL`)   |
| API key     | Read from `LLM_API_KEY` in `.env` — **never sent to the browser**   |
| Temperature | `0.2`                                                              |
| Output mode | Structured JSON (`responseMimeType: "application/json"`)            |

The provider, model and key are all read from environment variables, so the model can be swapped
without touching a line of code. Two alternative providers are already implemented:

- **OpenAI-compatible** (`LLM_PROVIDER=openai`) — works with OpenAI, Groq, OpenRouter, etc.
  via `LLM_BASE_URL`.
- **Ollama** (`LLM_PROVIDER=ollama`) — runs a local model via `OLLAMA_URL` / `OLLAMA_MODEL`,
  so the app can work fully offline with no API key.

---

## How the AI is integrated

This is a small **RAG-style grounding** pipeline (no vector database needed for 8 facts):

```
Browser (public/)            Express backend (server.js)              LLM provider
──────────────────            ──────────────────────────              ───────────
 student question  ──POST──▶  1. validate message (1-500 chars)
 conversation history         2. buildPrompt()  ← system prompt
 session id                   3. inject knowledge.json               ───────────▶
                              4. callLLM()  (fetch, 20 s timeout)   Gemini REST
                              5. parseModelOutput()  ← JSON         ◀───────────
                              6. verifyGrounding()  ← fact check
                              7. { answer, category, grounded, flags }
        ◀──JSON────────────
 render bubble + badges + feedback
```

**1. Grounding.** `buildPrompt()` puts the eight knowledge-base facts into the system prompt as a
`Category: fact` list. The model is told to answer *only* from that list and to never invent
dates, numbers, names, emails, phone numbers, locations or policies.

**2. Structured output.** The model is asked to return
`{"answer": string, "category": one of [...], "grounded": boolean}`, and the provider is put in
JSON mode. `parseModelOutput()` then parses defensively — it strips markdown code fences, extracts
the outermost JSON object, and validates that `category` is one of the allowed values. If the
model returns something unparseable, the raw text is used as the answer with `category: "Other"`
and `grounded: false`, so the chat never breaks.

**3. The unknown-query rule.** Rule 2 of the system prompt requires the model to state plainly
that a specific detail (an exam date, a phone number, a closing time, an attendance percentage)
is not in the data it has, and then suggest the most relevant office from the knowledge base.

**4. Low temperature.** `0.2` keeps the model close to the supplied wording and reduces creative
improvisation.

**5. The `grounded` flag — and a server-side second opinion.** The model reports whether the
answer came straight from the knowledge base, but a self-report is not a guarantee, so
`verifyGrounding()` re-checks the answer. It scans for email addresses, phone numbers,
percentages, dates, times, links and bare numbers, and verifies each one actually appears in
`knowledge.json`. Anything that does not is returned in a `flags` array and the UI shows
`COULD NOT VERIFY: …`. A reply is only marked `grounded` when the model *and* the checker agree.

**6. Conversation history.** The last 6 messages are replayed to the model, which is what makes
follow-ups such as *“and for hostel?”* resolve to the right department. The server also keeps the
turns for a `sessionId` (in memory, with a one-hour TTL), so a page reload keeps the thread and
**Clear Chat** can wipe it on both sides.

**7. Failure handling.** The model call runs inside `try/catch` with an `AbortController` timeout.
A dropped connection is retried with exponential backoff; a quota error is not retried (it would
burn more quota) but starts a short server-side cooldown. Any failure returns a friendly
message — never a stack trace, never a leaked key.

---

## Setup and running the app

**Prerequisite:** Node.js 18 or newer.

```bash
git clone <your-repo-url> campus-helpdesk
cd campus-helpdesk
npm install

# Create your local config and add your key
copy .env.example .env        # Windows
# cp .env.example .env        # macOS / Linux

# Edit .env and set:
#   LLM_API_KEY = your Gemini (or other provider) API key
#   LLM_MODEL   = gemini-3.8-flash

npm start
```

Then open **<http://localhost:3000>**.

Check that the server and the key were picked up:

```bash
curl http://localhost:3000/api/health
# {"status":"ok","provider":"gemini","model":"gemini-3.8-flash",
#  "knowledgeCategories":8,"hasApiKey":true,...}
```

> `.env` is git-ignored. **Only `.env.example` is committed** — never commit your real key.

### Running fully offline (no API key)

Install [Ollama](https://ollama.com), pull a small model and switch the provider:

```bash
ollama pull llama3.2
```

```bash
# .env
LLM_PROVIDER=ollama
OLLAMA_URL=http://localhost:11434
OLLAMA_MODEL=llama3.2
```

```bash
npm start
```

---

## Configuration reference

All settings live in `.env` (see `.env.example`).

| Variable                       | Default                     | Purpose                                                 |
| ------------------------------ | --------------------------- | ------------------------------------------------------- |
| `LLM_PROVIDER`                 | `gemini`                    | `gemini` \| `openai` \| `ollama`                        |
| `LLM_API_KEY`                  | –                           | Provider API key (server-side only)                     |
| `LLM_MODEL`                    | `gemini-3.8-flash`          | Model id passed to the provider                         |
| `PORT`                         | `3000`                      | HTTP port                                                |
| `LLM_BASE_URL`                 | `https://api.openai.com/v1` | Base URL for the OpenAI-compatible provider             |
| `OLLAMA_URL`                   | `http://localhost:11434`    | Local Ollama server                                      |
| `OLLAMA_MODEL`                 | `llama3.2`                  | Local model id                                           |
| `LLM_JSON_MODE`                | `true`                      | Set `false` for providers without JSON mode             |
| `LLM_TIMEOUT_MS`               | `20000`                     | Per-request timeout (ms)                                |
| `LLM_MAX_RETRIES`              | `2`                         | Retries for transient provider failures                 |
| `RATE_LIMIT_PER_MIN`           | `30`                        | Chat requests allowed per IP per minute                 |
| `LLM_MAX_COOLDOWN_MS`          | `30000`                     | Longest cooldown after a provider quota error           |
| `GEMINI_BASE_URL`              | Google v1beta endpoint      | Override for testing against a local stub               |

---

## Project structure

```
campus-helpdesk/
├── server.js                 # Express backend: prompt, LLM call, parsing, fact check, routes
├── knowledge.json            # The ONLY source of truth (8 university facts)
├── package.json
├── .env.example              # Committed template — no secrets
├── .env                      # Local secrets — git-ignored
├── .gitignore
├── README.md
└── public/
    ├── index.html            # Stitch design (Tailwind CDN + Three.js) + chat modal
    ├── app.js                # Chat client: fetch /api/chat, render, feedback, session
    └── assets/
        ├── logo.png          # Supplied Presidency University logo
        └── logo-white.png    # Same artwork recoloured for dark backgrounds
```

### Backend functions (`server.js`)

| Function                  | Responsibility                                                             |
| ------------------------- | -------------------------------------------------------------------------- |
| `loadKnowledge()`        | Reads and parses `knowledge.json`; fails soft so the server still boots    |
| `formatKnowledge()`      | Flattens the knowledge object into the `- Category: fact` prompt block      |
| `buildPrompt()`          | System prompt + knowledge base + trimmed history + the new question        |
| `callLLM()`              | Dispatches to the configured provider adapter                              |
| `callGemini()`           | Google Gemini `generateContent` adapter                                    |
| `callOpenAI()`           | OpenAI-compatible `chat/completions` adapter                               |
| `callOllama()`           | Local Ollama `/api/chat` adapter                                           |
| `providerFetch()`        | One provider HTTP call; classifies errors as retryable / quota / fatal      |
| `withRetry()`            | Exponential backoff for transient failures; never retries a quota error    |
| `fetchWithTimeout()`     | `fetch` + `AbortController`, so a hung provider cannot hang the API        |
| `parseModelOutput()`     | Defensive JSON extraction, category validation, `grounded` coercion         |
| `verifyGrounding()`      | Re-checks the answer against `knowledge.json`; returns `flags`             |
| `getSession()`           | In-memory conversation store (one-hour TTL, no database)                   |

---

## API reference

### `POST /api/chat`

```jsonc
// request
{
  "message": "Whom should I contact for placement training?",
  "history": [{ "role": "user", "content": "..." },
              { "role": "assistant", "content": "..." }],
  "sessionId": "s-abc123"        // optional: enables server-side memory
}

// 200 response
{
  "answer": "Students may contact the Placement Department for training and placement-related information.",
  "category": "Placements",
  "grounded": true,
  "flags": [],                    // concrete facts not found in knowledge.json
  "provider": "gemini",
  "model": "gemini-3.8-flash"
}
```

Error responses use the same shape plus an `error` code, and are always human-readable:

| Status | `error`            | When                                                        |
| ------ | ------------------ | ----------------------------------------------------------- |
| `400`  | `empty_message`   | Message was empty or whitespace                             |
| `400`  | `message_too_long`| Message longer than 500 characters                          |
| `429`  | `rate_limited`    | Too many requests, or the provider quota is cooling down    |
| `502`  | `llm_error`       | Provider failed or returned something unusable              |
| `502`  | `timeout`         | Provider did not answer within `LLM_TIMEOUT_MS`             |
| `503`  | `missing_api_key` | No key configured on the server                             |

### `GET /api/health`

Returns server status, provider, model, knowledge-base size, whether a key is loaded and any
active cooldown (**never the key itself**).

### `GET /api/config`

Public, non-secret runtime info used by the frontend: provider, model, `aiEnabled`, the allowed
message length and the real category list from `knowledge.json`.

### `GET /api/knowledge`

The knowledge base itself, so the UI can show the real categories and sources.

### `GET /api/session/:id` · `DELETE /api/session/:id`

Reads or wipes the stored conversation for a session id. `DELETE` is what **Clear Chat** calls.

---

## Security note

- The API key lives **only** in `.env`, which is listed in `.gitignore`. Only `.env.example`
  (no real values) is committed.
- The key is used **exclusively on the server**. The browser talks to `/api/chat` on our own
  Express server and never to the LLM provider directly, so the key is never shipped in
  client-side JavaScript, HTML or the network tab.
- `/api/health`, `/api/config` and `/api/knowledge` deliberately expose no secret material.
- Provider errors are logged server-side and returned to the client as a generic message, so
  stack traces and key fragments never reach the browser.
- The chat is rate-limited per IP, which also protects the provider quota from a runaway client.

---

## Testing / acceptance checks

Every query from the problem statement was exercised against the running app:

| Question                                    | Expected behaviour                                             | Result |
| ------------------------------------------- | --------------------------------------------------------------- | ------ |
| Whom should I contact for academic problems? | Faculty advisor                                                | pass   |
| Where can I find the examination timetable?  | Official university channels                                    | pass   |
| Whom should I contact for placement training?| Placement Department (no invented email)                         | pass   |
| How can I raise a hostel complaint?          | Hostel Administration                                           | pass   |
| What is the exact date of my next examination? | Says the date is unavailable, points to official channels       | pass   |
| What is the library closing time?            | Exact timing not available; refers to library timings/rules       | pass   |
| What is the minimum attendance percentage?    | Exact figure not in the data; refers to university regulations     | pass   |
| Who won the cricket world cup?               | Politely declines — university queries only                       | pass   |
| "hostel complaint kaise karu" (typos)       | Still understood as Hostel Administration                          | pass   |
| "plcement trening krega?" (typos)          | Still understood as the Placement Department                      | pass   |
| Empty message / >500 chars / missing key     | Friendly error, no crash, no stack trace                          | pass   |
| Follow-up ("and for hostel?")                | Resolves to Hostel Administration                                | pass   |

Automated checks also assert that **no reply ever contains an email address or a phone number**.

---

## Known limits

- **Provider quota.** The Gemini free tier allows only a handful of `generateContent` requests
  per minute. When the quota is hit the server does *not* retry blindly: it starts a short
  cooldown and answers with *“Nova is catching up with the university helpdesk queue. Please try
  again in about N seconds.”* — with `Retry-After` set, so the UI can say so honestly. A paid
  tier, a different provider, or Ollama removes the limit entirely.
- **No database.** Conversations live in memory with a one-hour TTL. That is deliberate — the
  problem statement puts databases and auth out of scope.
- **Tailwind via CDN.** The design loads Tailwind from `cdn.tailwindcss.com`, which prints a
  console warning in production. It keeps the project build-step free; install the Tailwind CLI
  if you want to ship it properly.
- **Three.js needs the network.** The 3D robot is loaded from unpkg. If it cannot load, the
  page still works — the 3D is wrapped in a `try/catch`.

---

## AI tools disclosure

> Built with assistance from **Cursor** and **Claude**; LLM at runtime: **Gemini `gemini-3.8-flash`**
> (provider switchable to any OpenAI-compatible API or a local Ollama model via environment
> variables).

The code, prompt design, UI and documentation in this repository were written with AI coding
assistants. The visual design came from a **Google Stitch** export. The answers served to students
are produced at runtime by the configured LLM — there is no pre-written question/answer table
anywhere in the codebase.

---

## License

MIT — free to use for the competition and for academic purposes.
