// ─────────────────────────────────────────────
//  Vexis AI · server.js
//  Run: node server.js
// ─────────────────────────────────────────────

require('dotenv').config();           // loads .env from the same folder

const express = require('express');
const cors    = require('cors');
const OpenAI  = require('openai').default;

// ── Config ───────────────────────────────────
const PORT    = process.env.PORT || 3000;
const API_KEY = process.env.OPENAI_API_KEY;
const MODEL   = 'gpt-4o';

if (!API_KEY) {
  console.error('\n[Vexis AI] ERROR: OPENAI_API_KEY is missing from your .env file.');
  console.error('           Edit .env and paste your key, then re-run node server.js\n');
  process.exit(1);
}

const openai = new OpenAI({ apiKey: API_KEY });

// ── Express ──────────────────────────────────
const app = express();
app.use(cors());
app.use(express.json());

// ── System prompt ────────────────────────────
const SYSTEM_PROMPT =
  'You are Vexis AI, the built-in assistant for the Vexis browser OS. ' +
  'You are helpful, concise, and friendly. Keep responses readable as plain ' +
  'text with occasional line breaks — avoid heavy markdown.';

// ── Health check ─────────────────────────────
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', model: MODEL });
});

// ── Chat endpoint ────────────────────────────
app.post('/api/chat', async (req, res) => {
  const { messages } = req.body;

  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'messages array is required.' });
  }

  try {
    const completion = await openai.chat.completions.create({
      model: MODEL,
      messages: [{ role: 'system', content: SYSTEM_PROMPT }, ...messages],
      max_tokens: 1024,
      temperature: 0.7,
    });

    const message = completion.choices[0]?.message?.content?.trim() ?? '';
    res.json({ message, model: MODEL });

  } catch (err) {
    console.error('[Vexis AI] OpenAI error:', err.message);
    res.status(err.status || 500).json({ error: err.message || 'AI error.' });
  }
});

// ── Start ─────────────────────────────────────
app.listen(PORT, () => {
  console.log('\n  ✦ Vexis AI server running → http://localhost:' + PORT + '\n');
});