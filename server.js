// ─────────────────────────────────────────────
//  Vexis AI · server.js
//  Run: node server.js
// ─────────────────────────────────────────────

require('dotenv').config();

const fs        = require('fs');
const path      = require('path');
const { spawn } = require('child_process');
const express   = require('express');
const cors      = require('cors');
const { Readable } = require('stream');

// ── Config ───────────────────────────────────
const PORT              = process.env.PORT || 3000;
const INTERSTELLAR_PORT = process.env.INTERSTELLAR_PORT || 3001;
const API_KEY           = process.env.OPENAI_API_KEY;
const MODEL             = 'gpt-4o';
const IMG_MODEL         = 'gpt-image-1-mini';

// OpenAI is optional — AI features are disabled if key is missing
let openai = null;
if (API_KEY) {
  const OpenAI = require('openai').default;
  openai = new OpenAI({ apiKey: API_KEY });
} else {
  console.warn('\n[Vexis] OPENAI_API_KEY not set — AI features disabled.\n');
}

// ── Auto-write go.html into Interstellar's static dir ────────
// This launcher page registers Interstellar's SW and navigates to the proxied URL.
const interstellarDir    = path.join(__dirname, 'interstellar');
const interstellarStatic = path.join(interstellarDir, 'static');
const goHtmlPath         = path.join(interstellarStatic, 'go.html');

const GO_HTML = `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="referrer" content="no-referrer">
<title>Loading...</title>
<style>
  body{margin:0;display:flex;flex-direction:column;align-items:center;
       justify-content:center;height:100vh;background:#0d0d0d;
       color:#aaa;font-family:sans-serif;font-size:13px;gap:14px;}
  .spin{width:28px;height:28px;border:2.5px solid #333;border-top-color:#888;
        border-radius:50%;animation:s .7s linear infinite;}
  @keyframes s{to{transform:rotate(360deg)}}
</style>
</head>
<body>
<div class="spin"></div>
<div id="msg">Connecting...</div>
<script>
(async function () {
  var params = new URLSearchParams(location.search);
  var url    = params.get('u');
  var msg    = document.getElementById('msg');
  if (!url) { msg.textContent = 'No URL provided.'; return; }

  // Standard Ultraviolet XOR encoder — used as fallback if __uv\\$config is unavailable
  function xorEncode(str) {
    str = encodeURIComponent(str);
    var out = '';
    for (var i = 0; i < str.length; i++)
      out += i % 2 ? String.fromCharCode(str.charCodeAt(i) ^ 2) : str[i];
    return out;
  }

  function loadScript(src) {
    return new Promise(function(resolve) {
      var s = document.createElement('script');
      s.src = src; s.onload = resolve; s.onerror = resolve;
      document.head.appendChild(s);
    });
  }

  try {
    msg.textContent = 'Registering proxy...';

    // Register Interstellar's SW through Vexis's own origin.
    // scope: '/a/' keeps it isolated from Vexis's own pages.
    // Register Interstellar's own SW at its native origin with root scope,
    // so navigator.serviceWorker.ready resolves for this page correctly.
    var reg = await navigator.serviceWorker.register('/sw.js', { scope: '/' });

    // Wait for THIS specific registration to become active before navigating.
    await new Promise(function(resolve) {
      if (reg.active) { resolve(); return; }
      var sw = reg.installing || reg.waiting;
      if (sw) {
        sw.addEventListener('statechange', function() {
          if (this.state === 'activated') resolve();
        });
      } else {
        reg.addEventListener('updatefound', function() {
          reg.installing.addEventListener('statechange', function() {
            if (this.state === 'activated') resolve();
          });
        });
      }
    });

    // Load UV config for correct URL encoding
    await loadScript('/assets/mathematics/config.js');

    var encoded;
    if (typeof __uv\$config !== 'undefined' && __uv\$config.encodeUrl) {
      encoded = __uv\$config.prefix + __uv\$config.encodeUrl(url);
    } else {
      encoded = '/a/' + xorEncode(url);
    }

    msg.textContent = 'Loading...';
    window.location.replace(encoded);
  } catch (e) {
    msg.textContent = 'Proxy error: ' + e.message;
    console.error(e);
  }
})();
<\/script>
</body>
</html>`;

try {
  if (fs.existsSync(interstellarStatic)) {
    fs.writeFileSync(goHtmlPath, GO_HTML, 'utf8');
    console.log('[Vexis] Wrote interstellar/static/go.html');
  }
} catch (e) {
  console.warn('[Vexis] Could not write go.html:', e.message);
}

// ── Start Interstellar proxy on a separate port ──────────────
const interstellar = spawn('node', ['index.js'], {
  cwd:   interstellarDir,
  env:   { ...process.env, PORT: String(INTERSTELLAR_PORT) },
  stdio: ['ignore', 'pipe', 'pipe'],
});
interstellar.stdout.on('data', d => process.stdout.write(`[Interstellar] ${d}`));
interstellar.stderr.on('data', d => process.stderr.write(`[Interstellar] ${d}`));
interstellar.on('error', err => console.error('[Interstellar] Failed to start:', err.message,
  '\n  → Make sure you cloned Interstellar and ran: cd interstellar && npm install'));
interstellar.on('exit', code => { if (code !== 0) console.warn(`[Interstellar] exited (${code})`); });

// ── Express ──────────────────────────────────
const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

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
  if (!openai) return res.status(503).json({ error: 'AI not configured (missing OPENAI_API_KEY).' });
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

// ── Image generation endpoint (DALL-E 3) ─────
app.post('/api/imagine', async (req, res) => {
  if (!openai) return res.status(503).json({ error: 'AI not configured (missing OPENAI_API_KEY).' });
  const { prompt } = req.body;

  if (!prompt || typeof prompt !== 'string' || !prompt.trim()) {
    return res.status(400).json({ error: 'prompt is required.' });
  }

  try {
    const response = await openai.images.generate({
      model: IMG_MODEL,
      prompt: prompt.trim(),
      n: 1,
      size: '1024x1024',
      quality: 'auto',
    });

    const item = response.data[0];
    if (!item) throw new Error('No image returned.');

    // gpt-image-1 returns base64; DALL-E 3 returns a URL
    if (item.b64_json) {
      res.json({ b64: item.b64_json });
    } else if (item.url) {
      res.json({ url: item.url });
    } else {
      throw new Error('No image data in response.');
    }

  } catch (err) {
    console.error('[Vexis AI] DALL-E error:', err.message);
    res.status(err.status || 500).json({ error: err.message || 'Image generation failed.' });
  }
});

// ── Web proxy endpoint ────────────────────────
app.get('/api/proxy', async (req, res) => {
  const targetUrl = req.query.url;
  if (!targetUrl) return res.status(400).send('Missing url parameter');

  let parsed;
  try {
    parsed = new URL(targetUrl);
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      return res.status(400).send('Only http/https URLs are allowed');
    }
  } catch {
    return res.status(400).send('Invalid URL');
  }

  // Block SSRF targets
  const blocked = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1']);
  if (blocked.has(parsed.hostname)) return res.status(403).send('Forbidden');

  try {
    const upHeaders = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'Accept': req.headers['accept'] || 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Dest': 'document',
      'Upgrade-Insecure-Requests': '1',
    };
    if (req.headers['range'])  upHeaders['Range']  = req.headers['range'];
    if (req.headers['cookie']) upHeaders['Cookie'] = req.headers['cookie'];

    const upstream = await fetch(targetUrl, { headers: upHeaders, redirect: 'follow' });

    // Headers to strip — removes everything that prevents iframe embedding
    const STRIP = new Set([
      'x-frame-options',
      'content-security-policy',
      'content-security-policy-report-only',
      'cross-origin-opener-policy',
      'cross-origin-embedder-policy',
      'cross-origin-resource-policy',
      'content-encoding',   // fetch auto-decompresses; browser must not try again
      'content-length',     // length changes after decompression + HTML injection
      'transfer-encoding',
    ]);
    upstream.headers.forEach((val, key) => {
      if (!STRIP.has(key.toLowerCase())) res.set(key, val);
    });
    res.status(upstream.status);

    const ct = upstream.headers.get('content-type') || '';

    if (ct.includes('text/html')) {
      let html = await upstream.text();
      const origin = `${parsed.protocol}//${parsed.host}`;

      // Remove inline CSP meta tags (header stripping doesn't catch these)
      html = html.replace(/<meta[^>]+http-equiv=["']content-security-policy["'][^>]*>/gi, '');
      html = html.replace(/<meta[^>]+content-security-policy[^>]*>/gi, '');

      // Remove any existing <base> tag so ours takes precedence
      html = html.replace(/<base[^>]*>/gi, '');

      // Injected before all other scripts so iframe-detection checks see
      // window.top === window and frameElement === null.
      const inject = `<base href="${origin}/">
<script>(function(){
  /* ── Spoof iframe environment so sites don't blank themselves ── */
  function def(obj,prop,val){try{Object.defineProperty(obj,prop,{get:function(){return val;},configurable:true});}catch(e){}}
  def(window,'top',window);
  def(window,'parent',window);
  def(window,'frameElement',null);
  def(document,'referrer','');

  /* ── Route all network requests back through the proxy ── */
  var P='/api/proxy?url=',O='${origin}';
  function px(u){
    if(!u||/^(data:|blob:|#|javascript:|mailto:|tel:|about:)/.test(u))return u;
    try{var a=new URL(u,O).href;if(/^https?:/.test(a))return P+encodeURIComponent(a);}catch(e){}
    return u;
  }
  var oF=window.fetch;
  window.fetch=function(u,o){
    if(typeof u==='string'&&/^https?:/.test(u))u=px(u);
    return oF.call(this,u,o);
  };
  var oXO=XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open=function(m,u){
    if(typeof u==='string'&&/^https?:/.test(u))arguments[1]=px(u);
    return oXO.apply(this,arguments);
  };

  /* ── Intercept link clicks and form submissions ── */
  document.addEventListener('click',function(e){
    var a=e.target.closest('a[href]');if(!a)return;
    var h=a.getAttribute('href');
    if(!h||/^(#|javascript:|mailto:|tel:)/.test(h))return;
    e.preventDefault();e.stopPropagation();
    window.location.href=px(h);
  },true);
  document.addEventListener('submit',function(e){
    var f=e.target,ac=f.getAttribute('action');
    if(ac&&!/^(#|javascript:)/.test(ac))f.setAttribute('action',px(ac));
  },true);

  /* ── Prevent location-hijack escape attempts ── */
  var _loc=window.location;
  ['assign','replace'].forEach(function(m){
    var orig=_loc[m].bind(_loc);
    try{window.location[m]=function(u){orig(px(String(u)));}}catch(e){}
  });
})();</script>`;

      html = /<head[\s>]/i.test(html)
        ? html.replace(/<head[^>]*>/i, m => m + inject)
        : inject + html;

      res.set('content-type', 'text/html; charset=utf-8');
      res.send(html);

    } else {
      // Buffer and forward everything else (images, audio, video, JS, CSS…)
      const buf = await upstream.arrayBuffer();
      res.send(Buffer.from(buf));
    }
  } catch (err) {
    console.error('[Vexis Proxy]', err.message);
    if (!res.headersSent) res.status(502).send(`Proxy error: ${err.message}`);
  }
});

// ── Health / config endpoints ─────────────────
app.get('/api/proxy-port', (_req, res) => res.json({ port: INTERSTELLAR_PORT }));

app.listen(PORT, () => {
  console.log(`\n  ✦ Vexis running      → http://localhost:${PORT}`);
  console.log(`  ✦ Interstellar proxy → http://localhost:${INTERSTELLAR_PORT}\n`);
});
