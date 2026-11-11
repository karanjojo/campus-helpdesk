# AI-Powered University Campus Helpdesk — Presidency University

A web app built for **Technopia 2.0** (Presidency University, School of Computer Science & Engineering).
Students type a question in plain English and an LLM answers using **only** the fixed university
knowledge base supplied with the problem statement — academics, attendance, examinations,
placements, hostel, library, administration and events.

If the answer is not in the knowledge base, the assistant **says so clearly** and points the
student to the right office instead of inventing a date, email, phone number, timing or percentage.

---

## Table of contents

1. [Features](#features)
2. [Tech stack](#tech-stack)
3. [AI model / API used](#ai-model--api-used)
4. [How the AI is integrated](#how-the-ai-is-integrated)
5. [Setup and running the app](#setup-and-running-the-app)
6. [Deploying it so the judges can open it](#deploying-it-so-the-judges-can-open-it)
7. [Configuration reference](#configuration-reference)
8. [Project structure](#project-structure)
9. [API reference](#api-reference)
10. [Security note](#security-note)
11. [Testing / acceptance checks](#testing--acceptance-checks)
12. [AI tools disclosure](#ai-tools-disclosure)
13. [License](#license)

---

## Features

- **Natural-language chat UI** — message bubbles, avatars, timestamps, auto-scroll, "typing…"
  indicator, Enter to send, and a working **Clear Chat** button.
- **A real LLM does the answering.** No hardcoded question/answer pairs and no keyword lookup
  table — the model reads the question and writes the reply.
- **Grounded in a fixed knowledge base.** `knowledge.json` is injected into the system prompt on
  every call, so answers come from the university's own wording.
- **Anti-hallucination by design.** Low temperature (0.2), a strict "answer only from the
  knowledge base" rule, an explicit unknown-query rule, and a `grounded` flag on every reply.
- **Six topic shortcuts** (Academics, Examinations, Placements, Hostel, Library, Administration)
  that send a ready-made starter question.
- **Conversation memory** — the last 6 turns are sent back to the model, so follow-ups like
  *"and for hostel?"* are understood.
- **Suggested question chips** built from the five official test queries.
- **Helpful / Not helpful feedback** on every bot reply, remembered in `localStorage`.
- **Category badge + "Source: University knowledge base" tag** on grounded answers.
- **Dark mode toggle**, remembered between visits.
- **Fully responsive** — the sidebar collapses into a drawer on small screens (verified at 375 px).
- **Accessible** — Lighthouse accessibility score **100/100** in both light and dark themes,
  keyboard focus states, ARIA labels, a skip link and `prefers-reduced-motion` support.
- **Hardened API** — input validation, request timeout, defensive JSON parsing and friendly
  error messages. Stack traces and secrets never reach the browser.

---

## Tech stack

| Layer      | Technology                                                        |
| ---------- | ----------------------------------------------------------------- |
| Backend    | Node.js 18+ and Express 4                                         |
| Config     | `dotenv` (`.env` → environment variables)                         |
| CORS       | `cors`                                                            |
| LLM        | Provider REST API called with the built-in `fetch` (Node 18+)      |
| Frontend   | Plain HTML + CSS + vanilla JavaScript — **no build step**         |
| Fonts      | Poppins + Inter (Google Fonts)                                    |
| Assets     | Supplied Presidency University logo (`public/assets/`)            |

The frontend is served statically by the same Express process, so the whole app runs with a
single `npm start`.

---

## AI model / API used

| Setting      | Value                                                            |
| ------------ | ---------------------------------------------------------------- |
| Provider     | **Google Gemini** — REST API (`generativelanguage.googleapis.com`) |
| Model        | **gemini-3.5-flash-lite** (fast + inexpensive)              |
| Fallback     | **gemini-3.8-flash** - used automatically if the primary is quota-blocked |
| API key      | Read from `LLM_API_KEY` in `.env` — **never sent to the browser** |
| Temperature  | `0.2`                                                            |
| Output mode  | Structured JSON (`responseMimeType: "application/json"`)          |

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
──────────────────           ──────────────────────────              ───────────
 student question  ──POST──▶  1. validate message (1-500 chars)
 conversation history         2. buildPrompt()  ← system prompt
                              3. inject knowledge.json               ───────────▶
                              4. callLLM()  (fetch, 20 s timeout)   Gemini REST
                              5. parseModelOutput()  ← JSON         ◀───────────
                              6. { answer, category, grounded }
        ◀──JSON────────────
 render bubble + badges + feedback
```

**1. Grounding.** `buildPrompt()` puts the eight knowledge-base facts into the system prompt as
a `Category: fact` list. The model is told to answer *only* from that list and to never invent
dates, numbers, names, emails, phone numbers, locations or policies.

**2. Structured output.** The model is asked to return
`{"answer": string, "category": one of [...], "grounded": boolean}`, and the provider is put in
JSON mode. `parseModelOutput()` then parses defensively — it strips markdown code fences, extracts
the outermost JSON object, and validates that `category` is one of the allowed values. If the model
returns something unparseable, the raw text is used as the answer with `category: "Other"` and
`grounded: false`, so the chat never breaks.

**3. The unknown-query rule.** Rule 2 of the system prompt requires the model to state plainly
that a specific detail (an exam date, a phone number, a closing time, an attendance percentage)
is not in the data it has, and then suggest the most relevant office from the knowledge base.

**4. Low temperature.** `0.2` keeps the model close to the supplied wording and reduces
creative improvisation.

**5. The `grounded` flag.** The model reports whether the answer came straight from the
knowledge base. The UI shows a green **"Source: University knowledge base"** tag only when it is
`true` — a visible, honest signal to the student (and to the judges) about what is known.

**6. Conversation history.** The last 6 messages are replayed to the model, which is what makes
follow-ups such as *"and for hostel?"* resolve to the right department.

**7. Failure handling.** The model call runs inside `try/catch` with an `AbortController` timeout.
Any failure (bad key, provider outage, timeout, malformed output) returns a friendly
*"The assistant is unavailable right now, please try again"* message — never a stack trace,
never a leaked key.

**8. Staying up under a real free-tier quota.** Public API keys have a per-model request quota,
and models get retired. The backend therefore:

- **falls back to a second model** (`LLM_FALLBACK_MODEL`) when the primary returns `429`
  (quota exhausted) or `404` (model retired), and re-probes the primary periodically;
- **retries transient failures** (`429` / `5xx` / dropped connections) with exponential backoff;
- **arms a cooldown** when no fallback can serve the request, so a throttled key is not hammered —
  during the cooldown the student gets a friendly *"the assistant is busy, try again in N seconds"*
  instead of an error;
- **rate-limits** `/api/chat` per IP.

This is why the demo keeps working even when one model tier is throttled mid-conversation.

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
#   LLM_MODEL   = gemini-3.5-flash-lite

npm start
```

Then open **<http://localhost:3000>**.

Check that the server and the key were picked up:

```bash
curl http://localhost:3000/api/health
# {"status":"ok","provider":"gemini","model":"gemini-3.5-flash-lite","knowledgeCategories":8,"hasApiKey":true,...}
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

## Deploying it so the judges can open it

The repo is public and the app is a plain Node/Express server, so it runs on any Node host.
The only secret is the LLM key, which is set as an environment variable **on the host** — never
committed.

### Option A — Render (recommended, free)

The repo already contains a [`render.yaml`](render.yaml) Blueprint, so this is four steps:

1. Go to **<https://render.com>** → **New** → **Blueprint**.
2. Connect the GitHub account and pick `karanjojo/campus-helpdesk`.
3. Render will show the environment variables from the Blueprint and ask for the one value it
   cannot read from the repo — **`LLM_API_KEY`**. Paste your Gemini key
   (free key: <https://aistudio.google.com/apikey>).
4. Click **Apply** and wait for the build.

The site is live at **`https://campus-helpdesk.onrender.com`** (or a similar
`campus-helpdesk-xxxx.onrender.com` if the name is taken).

Check it with:

```bash
curl https://campus-helpdesk.onrender.com/api/health
```

> The free plan spins down after ~15 minutes of inactivity, so the first request after a quiet
> period takes ~30 seconds while the instance wakes up. Open the site once before you present.

### Option B — Railway

<https://railway.app> → **New Project** → **Deploy from GitHub** → pick the repo → Railway detects
`package.json` and uses `npm start`. Add `LLM_API_KEY` (and optionally `LLM_MODEL`,
`LLM_FALLBACK_MODEL`) under **Variables**. The `Procfile` in the repo is set for Railway/Heroku.

### Option C — any other Node host

`npm ci --omit=dev` to build, `npm start` to run, and set `LLM_API_KEY` (plus `PORT` if the host
does not set it). The app binds to all interfaces and exposes `/api/health` for host health
checks.

### Making sure the demo does not hit a quota wall

Free Gemini keys allow only a handful of requests per minute **per model**. The server handles
this for you:

- `LLM_FALLBACK_MODEL` accepts a **comma-separated list**. When the primary model returns HTTP
  429 (quota) or 404 (retired), the server switches to the next model in the list. Each model has
  its own quota bucket, so listing several multiplies how many questions the site can answer per
  minute.
- When every model is exhausted the server arms a short cooldown and answers
  *"Nova is catching up with the university helpdesk queue — please try again in about N
  seconds."* with `Retry-After` set, instead of failing silently.

The Blueprint ships with `gemini-3.5-flash-lite` as the primary and
`gemini-3.8-flash,gemini-2.5-flash` as fallbacks. For a busy demo, use a paid tier or a key with
a higher quota.

### Demo checklist

```bash
# 1. The site is up
curl -s https://campus-helpdesk.onrender.com/api/health

# 2. The key is wired (hasApiKey must be true)
curl -s https://campus-helpdesk.onrender.com/api/health | grep -o '"hasApiKey":[a-z]*'

# 3. The assistant actually answers
curl -s -X POST https://campus-helpdesk.onrender.com/api/chat \
  -H 'Content-Type: application/json' \
  -d '{"message":"Whom should I contact for placement training?"}'
```

---

## Configuration reference

All settings live in `.env` (see `.env.example`).

| Variable            | Default                                | Purpose                                                |
| ------------------- | -------------------------------------- | ------------------------------------------------------ |
| `LLM_PROVIDER`      | `gemini`                               | `gemini` \| `openai` \| `ollama`                       |
| `LLM_API_KEY`       | –                                      | Provider API key (server-side only)                    |
| `LLM_MODEL`         | `gemini-3.5-flash-lite`             | Model id passed to the provider                        |
| `LLM_FALLBACK_MODEL`| -                                    | Second model used if the primary is quota-blocked (429) or retired (404) |
| `LLM_FALLBACK_MODEL`| -                                       | Second model used if the primary is quota-blocked (429) or retired (404) |
| `PORT`              | `3000`                                 | HTTP port                                               |
| `LLM_BASE_URL`      | `https://api.openai.com/v1`            | Base URL for the OpenAI-compatible provider            |
| `OLLAMA_URL`        | `http://localhost:11434`               | Local Ollama server                                     |
| `OLLAMA_MODEL`      | `llama3.2`                             | Local model id                                          |
| `LLM_JSON_MODE`     | `true`                                 | Set `false` for providers without JSON mode            |
| `LLM_TIMEOUT_MS`    | `20000`                                | Per-request timeout                                     |
| `LLM_FALLBACK_MODEL`| –                                      | Comma-separated fallback models (tried on 429/404)      |
| `LLM_FALLBACK_HOLD_MS` | `600000`                            | How long to stay on a fallback before re-probing        |
| `LLM_MAX_RETRIES`   | `2`                                    | Retries for transient provider failures                 |
| `RATE_LIMIT_PER_MIN`| `30`                                   | Chat requests allowed per IP per minute                 |
| `LLM_MAX_COOLDOWN_MS`| `30000`                               | Longest cooldown after a provider quota error           |
| `GEMINI_BASE_URL`   | Google v1beta endpoint                 | Override for testing against a local stub              |

---

## Project structure

```
campus-helpdesk/
├── server.js                 # Express backend: prompt, LLM call, parsing, routes
├── knowledge.json            # The ONLY source of truth (8 university facts)
├── package.json
├── render.yaml               # Render Blueprint (one-click deploy)
├── Procfile                  # web: npm start  (Railway / Heroku)
├── .env.example              # Committed template — no secrets
├── .env                      # Local secrets — git-ignored
├── .gitignore
├── README.md
└── public/
    ├── index.html            # App shell: header, hero, chips, chat, composer
    ├── style.css             # Design tokens, light/dark themes, responsive rules
    ├── app.js                # Chat logic, rendering, feedback, theme, drawer
    └── assets/
        ├── logo.png          # Supplied Presidency University logo
        └── logo-white.png    # Same artwork recoloured for the navy header
```

### Backend functions (`server.js`)

| Function             | Responsibility                                                             |
| -------------------- | -------------------------------------------------------------------------- |
| `loadKnowledge()`   | Reads and parses `knowledge.json`; fails soft so the server still boots    |
| `formatKnowledge()` | Flattens the knowledge object into the `- Category: fact` prompt block      |
| `buildPrompt()`     | System prompt + knowledge base + trimmed history + the new question        |
| `callLLM()`         | Dispatches to the configured provider adapter                              |
| `callGemini()`      | Google Gemini `generateContent` adapter                                   |
| `callOpenAI()`      | OpenAI-compatible `chat/completions` adapter                               |
| `callOllama()`      | Local Ollama `/api/chat` adapter                                           |
| `fetchWithTimeout()`| `fetch` + `AbortController`, so a hung provider cannot hang the API        |
| `parseModelOutput()`| Defensive JSON extraction, category validation, `grounded` coercion         |

---

## API reference

### `POST /api/chat`

```jsonc
// request
{
  "message": "Whom should I contact for placement training?",
  "history": [{ "role": "user", "content": "..." },
              { "role": "assistant", "content": "..." }]
}

// 200 response
{
  "answer": "Students may contact the Placement Department for training and placement-related information.",
  "category": "Placements",
  "grounded": true,
  "provider": "gemini",
  "model": "gemini-3.5-flash-lite"
}
```

Error responses use the same shape plus an `error` code, and are always human-readable:

| Status | `error`           | When                                                     |
| ------ | ----------------- | -------------------------------------------------------- |
| `400`  | `empty_message`   | Message was empty or whitespace                          |
| `400`  | `message_too_long`| Message longer than 500 characters                       |
| `502`  | `llm_error`       | Provider failed or returned something unusable           |
| `502`  | `timeout`         | Provider did not answer within `LLM_TIMEOUT_MS`          |
| `503`  | `missing_api_key` | No key configured on the server                           |

### `GET /api/health`

Returns server status, provider, model, knowledge-base size and whether a key is loaded
(**never the key itself**).

### `GET /api/config`

Public, non-secret runtime info used by the frontend to show the active model.

---

## Security note

- The API key lives **only** in `.env`, which is listed in `.gitignore`. Only `.env.example`
  (no real values) is committed.
- The key is used **exclusively on the server**. The browser talks to `/api/chat` on our own
  Express server and never to the LLM provider directly, so the key is never shipped in
  client-side JavaScript, HTML or the network tab.
- `/api/health` and `/api/config` deliberately expose no secret material.
- Provider errors are logged server-side and returned to the client as a generic message, so
  stack traces and key fragments never reach the browser.

---

## Testing / acceptance checks

Every query from the problem statement was exercised against the running app:

| Question                                    | Expected behaviour                                                | Result |
| ------------------------------------------- | ----------------------------------------------------------------- | ------ |
| Whom should I contact for academic problems? | Faculty advisor                                                 | pass   |
| Where can I find the examination timetable?  | Official university channels                                     | pass   |
| Whom should I contact for placement training?| Placement Department (no invented email)                        | pass   |
| How can I raise a hostel complaint?          | Hostel Administration                                            | pass   |
| What is the exact date of my next examination? | Says the date is unavailable, points to official channels      | pass   |
| What is the library closing time?            | Exact timing not available; refers to library timings/rules      | pass   |
| What is the minimum attendance percentage?    | Exact figure not in the data; refers to university regulations    | pass   |
| Who won the cricket world cup?               | Politely declines — university queries only                      | pass   |
| "hostel complaint kaise karu" (typos)       | Still understood as Hostel Administration                         | pass   |
| Empty message / >500 chars / missing key     | Friendly error, no crash, no stack trace                         | pass   |

Automated checks also assert that **no reply ever contains an email address or a phone number**.

---

## AI tools disclosure

> Built with assistance from **Cursor** and **Claude**; LLM at runtime: **Gemini `gemini-3.5-flash-lite` (with `gemini-3.8-flash` as an automatic fallback - the provider, model and key are all environment variables, so the model can be swapped without touching code).
> (provider switchable to any OpenAI-compatible API or a local Ollama model via environment
> variables).

The code, prompt design, UI and documentation in this repository were written with AI coding
assistants. The answers served to students are produced at runtime by the configured LLM —
there is no pre-written question/answer table anywhere in the codebase.

---

## License

MIT — free to use for the competition and for academic purposes.
