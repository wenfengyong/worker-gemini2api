// gemini-web2api Cloudflare Worker
// Ported from Python: gemini_web2api/{config,models,gemini,tools,server}.py
// Every function maps 1:1 to the Python source

// ═══════════════════════════════════════════════════════════════════════════════
// config.py
// ═══════════════════════════════════════════════════════════════════════════════

const CONFIG = {
  retry_attempts: 3,
  retry_delay_sec: 2,
  request_timeout_sec: 180,
  gemini_bl: 'boq_assistant-bard-web-server_20260525.09_p0',
  auth_user: null,
  xsrf_token: null,
  default_model: 'gemini-3.5-flash',
  log_requests: true,
  cookie_string: '',
  sapisid: '',
  api_keys: [],
};

function loadConfigFromEnv(env) {
  const M = {
    retry_attempts: 'number', retry_delay_sec: 'number', request_timeout_sec: 'number',
    gemini_bl: 'string', auth_user: 'string', xsrf_token: 'string',
    default_model: 'string', log_requests: 'bool',
    cookie_string: 'string', sapisid: 'string', api_keys: 'string',
  };
  for (const [k, t] of Object.entries(M)) {
    if (env[k] === undefined) continue;
    if (t === 'number') CONFIG[k] = Number(env[k]);
    else if (t === 'bool') CONFIG[k] = env[k] === 'true' || env[k] === '1';
    else if (t === 'string') CONFIG[k] = String(env[k]);
  }
  // api_keys: comma-separated
  if (env.api_keys) {
    CONFIG.api_keys = String(env.api_keys).split(',').map(s => s.trim()).filter(Boolean);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// models.py
// ═══════════════════════════════════════════════════════════════════════════════

const MODELS = {
  'gemini-3.5-flash':              { mode: 1, think: 4, desc: 'Fast general-purpose model' },
  'gemini-3.5-flash-thinking':     { mode: 2, think: 0, desc: 'Deep thinking mode, longest output (~20k chars)' },
  'gemini-3.1-pro':                { mode: 3, think: 4, desc: 'Pro model (requires cookie for real routing)' },
  'gemini-3.1-pro-enhanced':       { mode: 3, think: 4, extra: { 31: 2, 80: 3 }, desc: 'Pro with enhanced output (experimental)' },
  'gemini-auto':                   { mode: 4, think: 4, desc: 'Auto model selection' },
  'gemini-3.5-flash-thinking-lite':{ mode: 5, think: 0, desc: 'Dynamic thinking with adaptive depth' },
  'gemini-flash-lite':             { mode: 6, think: 4, desc: 'Lightweight fast model' },
};

// Python: resolve_model(model_name, default) -> (name, mode_id, think_mode, error, extra_fields)
function resolveModel(modelName, defaultModel) {
  defaultModel = defaultModel || CONFIG.default_model;
  let thinkOverride = null;
  let name = modelName;
  if (name && name.includes('@think=')) {
    const parts = name.rsplit ? name.rsplit('@think=', 1) : name.split('@think=');
    name = parts[0];
    thinkOverride = parseInt(parts[1], 10);
    if (isNaN(thinkOverride)) {
      return { name: null, mode: null, think: null, error: `Invalid think level: ${parts[1]}`, extra: null };
    }
  }
  let cfg = MODELS[name];
  if (!cfg) {
    log(`Unknown model '${name}', falling back to '${defaultModel}'`);
    name = defaultModel;
    cfg = MODELS[defaultModel];
  }
  return {
    name: name,
    mode: cfg.mode,
    think: thinkOverride !== null ? thinkOverride : cfg.think,
    error: null,
    extra: cfg.extra || null,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// gemini.py
// ═══════════════════════════════════════════════════════════════════════════════

function log(msg) {
  if (CONFIG.log_requests) {
    const d = new Date();
    const ts = [d.getHours(), d.getMinutes(), d.getSeconds()].map(n => String(n).padStart(2, '0')).join(':');
    console.log(`[${ts}] ${msg}`);
  }
}

// Python: make_sapisidhash(sapisid) -> str
async function makeSapisidhash(sapisid) {
  const ts = Math.floor(Date.now() / 1000);
  const data = new TextEncoder().encode(`${ts} ${sapisid} https://gemini.google.com`);
  const hash = await crypto.subtle.digest('SHA-1', data);
  const hex = Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
  return `SAPISIDHASH ${ts}_${hex}`;
}

// Python: _account_prefix() -> str
function accountPrefix() {
  const authUser = CONFIG.auth_user;
  if (authUser === null || authUser === '') return '';
  return `/u/${authUser}`;
}

// Python: _build_headers() -> dict
async function buildHeaders() {
  const prefix = accountPrefix();
  const h = {
    'Content-Type': 'application/x-www-form-urlencoded',
    'Origin': 'https://gemini.google.com',
    'Referer': `https://gemini.google.com${prefix}/app`,
    'X-Same-Domain': '1',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  };
  if (prefix) h['X-Goog-AuthUser'] = String(CONFIG.auth_user);
  if (CONFIG.cookie_string) h['Cookie'] = CONFIG.cookie_string;
  if (CONFIG.sapisid) {
    const hash = await makeSapisidhash(CONFIG.sapisid);
    if (hash) h['Authorization'] = hash;
  }
  return h;
}

// Python: _build_payload(prompt, model_id, think_mode, file_refs, extra_fields) -> str
function buildPayload(prompt, modelId, thinkMode, extraFields) {
  const inner = new Array(102).fill(null);
  inner[0] = [prompt, 0, null, null, null, null, 0];
  inner[1] = ['en'];
  inner[2] = ['', '', '', null, null, null, null, null, null, ''];
  inner[6] = [0];
  inner[7] = 1;
  inner[10] = 1;
  inner[11] = 0;
  inner[17] = [[thinkMode]];
  inner[18] = 0;
  inner[27] = 1;
  inner[30] = [4];
  inner[41] = [2];
  inner[53] = 0;
  inner[59] = crypto.randomUUID();
  inner[61] = [];
  inner[68] = 1;
  inner[79] = modelId;
  if (extraFields) {
    for (const [k, v] of Object.entries(extraFields)) {
      inner[parseInt(k)] = v;
    }
  }
  const outer = [null, JSON.stringify(inner)];
  const params = { 'f.req': JSON.stringify(outer) };
  if (CONFIG.xsrf_token) params['at'] = CONFIG.xsrf_token;
  return new URLSearchParams(params).toString();
}

// Python: _get_url() -> str
function getUrl() {
  const reqid = Math.floor(Date.now() / 1000) % 1000000;
  const prefix = accountPrefix();
  return `https://gemini.google.com${prefix}/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate?bl=${CONFIG.gemini_bl}&hl=en&_reqid=${reqid}&rt=c`;
}

// Python: clean_text(text) -> str
function cleanText(text) {
  text = text.replace(/```(?:python|javascript|text)\?code_(?:reference|stdout)&code_event_index=\d+\n.*?```\n?/gs, '');
  text = text.replace(/http:\/\/googleusercontent\.com\/card_content\/\d+\n?/g, '');
  return text.trim();
}

// Python: _extract_texts_from_line(line) -> list[str]
function extractTextsFromLine(line) {
  if (!line.includes('"wrb.fr"') || line.length < 200) return [];
  try {
    const arr = JSON.parse(line);
    const innerStr = arr[0][2];
    if (!innerStr || innerStr.length < 50) return [];
    const inner = JSON.parse(innerStr);
    if (!(Array.isArray(inner) && inner.length > 4 && inner[4])) return [];
    const texts = [];
    for (const part of inner[4]) {
      if (Array.isArray(part) && part.length > 1 && part[1] && Array.isArray(part[1])) {
        for (const t of part[1]) {
          if (typeof t === 'string' && t) texts.push(t);
        }
      }
    }
    return texts;
  } catch (e) {
    return [];
  }
}

// Python: extract_response_text(raw) -> str
function extractResponseText(raw) {
  let lastText = '';
  for (const line of raw.split('\n')) {
    for (const t of extractTextsFromLine(line)) {
      if (t.length > lastText.length) lastText = t;
    }
  }
  return cleanText(lastText);
}

// Python: generate(prompt, model_id, think_mode, file_refs, extra_fields) -> str
async function generate(prompt, modelId, thinkMode, extraFields, traceId) {
  const body = buildPayload(prompt, modelId, thinkMode, extraFields);
  const url = getUrl();
  let lastErr = null;
  for (let attempt = 0; attempt < CONFIG.retry_attempts; attempt++) {
    try {
      const headers = await buildHeaders();
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), CONFIG.request_timeout_sec * 1000);
      const resp = await fetch(url, { method: 'POST', headers, body, signal: ctrl.signal });
      clearTimeout(timer);
      if (!resp.ok) throw new Error(`HTTP ${resp.status} ${resp.statusText}`);
      const raw = await resp.text();
      return extractResponseText(raw);
    } catch (e) {
      lastErr = e;
      if (attempt < CONFIG.retry_attempts - 1) {
        log(`Retry ${attempt + 1}/${CONFIG.retry_attempts}: ${e.message}`);
        await new Promise(r => setTimeout(r, CONFIG.retry_delay_sec * 1000));
      }
    }
  }
  throw lastErr;
}

// Python: generate_stream(prompt, model_id, think_mode, file_refs, extra_fields) -> yields delta
// Returns the upstream ReadableStream for the caller to consume
async function generateStream(prompt, modelId, thinkMode, extraFields, traceId) {
  const body = buildPayload(prompt, modelId, thinkMode, extraFields);
  const url = getUrl();
  const headers = await buildHeaders();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), CONFIG.request_timeout_sec * 1000);
  const resp = await fetch(url, { method: 'POST', headers, body, signal: ctrl.signal });
  clearTimeout(timer);
  if (!resp.ok) throw new Error(`HTTP ${resp.status} ${resp.statusText}`);
  return resp.body;
}

// ═══════════════════════════════════════════════════════════════════════════════
// tools.py
// ═══════════════════════════════════════════════════════════════════════════════

// Python: _build_tool_choice_instruction(tool_choice, tool_defs) -> str
function buildToolChoiceInstruction(toolChoice) {
  if (toolChoice === 'none') return '\n\nIMPORTANT: Do NOT call any tools. Respond with text only.';
  if (toolChoice === 'required') return '\n\nIMPORTANT: You MUST call at least one tool. Do not respond with text only.';
  if (typeof toolChoice === 'object' && toolChoice !== null) {
    const fnName = (toolChoice.function || {}).name || toolChoice.name || '';
    if (fnName) return `\n\nIMPORTANT: You MUST call the tool "${fnName}". Do not call other tools.`;
  }
  return '';
}

// Python: messages_to_prompt(messages, tools, tool_choice) -> (prompt, images)
function messagesToPrompt(messages, tools, toolChoice) {
  const parts = [];

  if (tools && toolChoice !== 'none') {
    const toolDefs = [];
    for (const tool of tools) {
      const fn = tool.type === 'function' ? (tool.function || tool) : tool;
      toolDefs.push({
        name: fn.name || tool.name || '',
        description: fn.description || tool.description || '',
        parameters: fn.parameters || tool.parameters || {},
      });
    }
    if (toolDefs.length) {
      const constraint = buildToolChoiceInstruction(toolChoice);
      parts.push(
        '# Tool Use\n\n' +
        'You can call the following tools. Call format:\n' +
        '```tool_call\n{"name": "func_name", "arguments": {...}}\n```\n' +
        'When calling tools, output ONLY the tool_call block(s).\n\n' +
        'Available tools:\n' + JSON.stringify(toolDefs, null, 2) +
        constraint
      );
    }
  }

  for (const msg of messages) {
    const role = msg.role || 'user';
    let content = msg.content || '';

    if (Array.isArray(content)) {
      const textParts = [];
      for (const c of content) {
        if (c.type === 'text' || c.type === 'input_text') textParts.push(c.text || '');
        else if (c.type === 'image_url' || c.type === 'image') textParts.push('[Note: Image input not supported in this API. Please describe the image in text.]');
      }
      content = textParts.join(' ');
    }

    if (role === 'system') {
      parts.push(`[System instruction]: ${content}`);
    } else if (role === 'assistant') {
      if (msg.tool_calls && msg.tool_calls.length) {
        const tcStrs = msg.tool_calls.map(tc => {
          const fn = tc.function || {};
          // Python: f'"arguments": {fn.get("arguments", "{}")}'  — arguments is already a JSON string
          return '```tool_call\n{"name": "' + (fn.name || '') + '", "arguments": ' + (fn.arguments || '{}') + '}\n```';
        });
        parts.push('[Assistant]: ' + (content || '') + '\n' + tcStrs.join('\n'));
      } else {
        parts.push(`[Assistant]: ${content}`);
      }
    } else if (role === 'tool') {
      parts.push(`[Tool result for ${msg.name || ''}]: ${content}`);
    } else {
      parts.push(content || '');
    }
  }

  return parts.filter(p => p).join('\n\n');
}

// Python: parse_tool_calls(text) -> (clean_text, tool_calls_list)
function parseToolCalls(text) {
  const toolCalls = [];
  const pattern = /```tool_call\s*\n(.*?)\n```/gs;
  const cleanParts = [];
  let lastEnd = 0;
  for (const m of text.matchAll(pattern)) {
    cleanParts.push(text.slice(lastEnd, m.index));
    lastEnd = m.index + m[0].length;
    try {
      const data = JSON.parse(m[1].trim());
      toolCalls.push({
        id: 'call_' + crypto.randomUUID().slice(0, 8),
        type: 'function',
        function: {
          name: data.name,
          arguments: JSON.stringify(data.arguments || {}),
        },
      });
    } catch (e) {}
  }
  cleanParts.push(text.slice(lastEnd));
  return [cleanParts.join('').trim(), toolCalls];
}

// Python: build_tool_prompt(tool_defs) -> str
function buildToolPrompt(toolDefs) {
  const toolSpec = JSON.stringify(toolDefs, null, 2);
  return (
    '# Tool Use\n\n' +
    'You can call the following tools to help accomplish tasks. ' +
    'These tools connect to the user\'s local environment and will execute when called.\n\n' +
    'Call format (use this exact format):\n' +
    '```function_call\n' +
    '{"name": "<tool_name>", "args": {<arguments>}}\n' +
    '```\n\n' +
    'When calling tools:\n' +
    '- Output ONLY the function_call block(s), nothing else\n' +
    '- You may call multiple tools with multiple blocks\n' +
    '- After receiving a [Tool result for ...], use that data to answer the user\n\n' +
    'Available tools:\n' + toolSpec
  );
}

// Python: _google_tool_choice_instruction(req) -> str
function googleToolChoiceInstruction(req) {
  const toolConfig = req.toolConfig || {};
  const fcConfig = toolConfig.functionCallingConfig || {};
  const mode = fcConfig.mode || 'AUTO';
  const allowed = fcConfig.allowedFunctionNames || [];
  if (mode === 'NONE') return '\n\nIMPORTANT: Do NOT call any tools. Respond with text only.';
  if (mode === 'ANY') {
    if (allowed.length) {
      const names = allowed.map(n => `"${n}"`).join(', ');
      return `\n\nIMPORTANT: You MUST call one of these tools: ${names}. Do not respond with text only.`;
    }
    return '\n\nIMPORTANT: You MUST call at least one tool. Do not respond with text only.';
  }
  return '';
}

// Python: google_contents_to_prompt(req) -> (prompt, images)
function googleContentsToPrompt(req) {
  const parts = [];
  const toolConfig = req.toolConfig || {};
  const fcMode = (toolConfig.functionCallingConfig || {}).mode || 'AUTO';

  const tools = req.tools;
  const toolDefs = [];
  if (tools && fcMode !== 'NONE') {
    for (const toolGroup of tools) {
      for (const fn of (toolGroup.functionDeclarations || [])) {
        const td = { name: fn.name || '', description: fn.description || '' };
        const params = fn.parameters || fn.parametersJsonSchema;
        if (params) td.parameters = params;
        toolDefs.push(td);
      }
    }
  }

  const sysInst = req.systemInstruction;
  if (sysInst) {
    const sysParts = sysInst.parts || [];
    const sysText = sysParts.filter(p => p.text).map(p => p.text).join(' ');
    if (sysText) {
      if (toolDefs.length) {
        parts.push(sysText + '\n\n' + buildToolPrompt(toolDefs) + googleToolChoiceInstruction(req));
      } else {
        parts.push(sysText);
      }
    }
  } else if (toolDefs.length) {
    parts.push(buildToolPrompt(toolDefs) + googleToolChoiceInstruction(req));
  }

  for (const content of (req.contents || [])) {
    const role = content.role || 'user';
    const msgParts = [];
    for (const p of (content.parts || [])) {
      if (p.text) msgParts.push(p.text);
      else if (p.functionCall) {
        const fc = p.functionCall;
        msgParts.push('```function_call\n' + JSON.stringify({ name: fc.name, args: fc.args || {} }) + '\n```');
      } else if (p.functionResponse) {
        const fr = p.functionResponse;
        msgParts.push('[Tool result for ' + (fr.name || '') + ']: ' + JSON.stringify(fr.response || {}));
      }
    }
    const text = msgParts.join('\n');
    if (role === 'model') parts.push('[Assistant]: ' + text);
    else parts.push(text);
  }

  return parts.filter(p => p).join('\n\n');
}

// Python: parse_google_function_calls(text) -> (clean_text, function_calls)
function parseGoogleFunctionCalls(text) {
  const functionCalls = [];
  let clean = text;

  // Pattern 1: ```function_call\n{...}\n```
  const p1 = /```function_call\s*\n(.*?)\n```/gs;
  for (const m of clean.matchAll(p1)) {
    try {
      const data = JSON.parse(m[1].trim());
      if (data.name) functionCalls.push({ name: data.name, args: data.args || data.arguments || {} });
    } catch (e) {}
  }
  clean = clean.replace(p1, '').trim();

  // Pattern 2: function_call\n{...}
  const p2 = /(?:^|\n)function_call\s*\n(\{[^`]*?\})/g;
  for (const m of clean.matchAll(p2)) {
    try {
      const data = JSON.parse(m[1].trim());
      if (data.name) functionCalls.push({ name: data.name, args: data.args || data.arguments || {} });
    } catch (e) {}
  }
  clean = clean.replace(p2, '').trim();

  // Pattern 3: raw JSON
  if (!functionCalls.length && clean.trim().startsWith('{')) {
    try {
      const data = JSON.parse(clean.trim());
      if (data.name && (data.args || data.arguments)) {
        functionCalls.push({ name: data.name, args: data.args || data.arguments });
        clean = '';
      }
    } catch (e) {}
  }

  return [clean, functionCalls];
}

// ═══════════════════════════════════════════════════════════════════════════════
// server.py helpers
// ═══════════════════════════════════════════════════════════════════════════════

function _usage(prompt, text) {
  const p = Math.floor(prompt.length / 4);
  const c = Math.floor((text || '').length / 4);
  return { prompt_tokens: p, completion_tokens: c, total_tokens: p + c };
}

function sendJson(data, status, extraHeaders) {
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': '*',
  };
  if (extraHeaders) Object.assign(headers, extraHeaders);
  return new Response(JSON.stringify(data), { status, headers });
}

function _authorized(request) {
  const keys = CONFIG.api_keys || [];
  if (!keys.length) return true;
  // Support both OpenAI (Authorization: Bearer xxx) and Anthropic (x-api-key: xxx)
  const auth = request.headers.get('Authorization') || '';
  const key = auth.startsWith('Bearer ') ? auth.slice(7) : (request.headers.get('x-api-key') || '');
  return keys.includes(key);
}

function _parseBody(request) {
  return request.json().catch(() => null);
}

// ═══════════════════════════════════════════════════════════════════════════════
// server.py: do_OPTIONS
// ═══════════════════════════════════════════════════════════════════════════════

function doOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': '*',
      'Access-Control-Max-Age': '86400',
    },
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// server.py: do_GET
// ═══════════════════════════════════════════════════════════════════════════════

function doGet(pathname, request) {
  // Auth for /v1/ only (Python: if self.path.startswith("/v1/") and not self._authorized())
  if (pathname.startsWith('/v1/') && !_authorized(request)) {
    return sendJson({ error: { message: 'invalid api key' } }, 401);
  }

  if (pathname === '/v1/models') {
    return sendJson({
      object: 'list',
      data: Object.entries(MODELS).map(([n, c]) => ({
        id: n, object: 'model', created: 1700000000, owned_by: 'google', description: c.desc,
      })),
    }, 200);
  }

  // GET /v1/models/{model} — single model retrieval (required by Claude Code, OpenAI SDK, etc.)
  const singleModelMatch = pathname.match(/^\/v1\/models\/([^/]+)$/);
  if (singleModelMatch) {
    const modelName = singleModelMatch[1];
    const cfg = MODELS[modelName];
    if (cfg) {
      return sendJson({
        id: modelName, object: 'model', created: 1700000000, owned_by: 'google', description: cfg.desc,
      }, 200);
    }
    return sendJson({ error: { message: `model '${modelName}' not found` } }, 404);
  }

  if (pathname.startsWith('/v1beta/models')) {
    return sendJson({
      models: Object.entries(MODELS).map(([n, c]) => ({
        name: `models/${n}`, displayName: n, description: c.desc,
        supportedGenerationMethods: ['generateContent', 'streamGenerateContent'],
      })),
    }, 200);
  }

  if (pathname === '/') {
    return sendJson({ status: 'ok', version: '2.0.0', models: Object.keys(MODELS), endpoints: ['/v1/chat/completions', '/v1/messages', '/v1/responses', '/v1/models', '/v1beta/models'] }, 200);
  }

  if (pathname === '/dashboard' || pathname === '/admin') {
    return serveDashboard();
  }

  return sendJson({ error: 'not found' }, 404);
}

// ═══════════════════════════════════════════════════════════════════════════════
// Dashboard HTML
// ═══════════════════════════════════════════════════════════════════════════════

function serveDashboard() {
  const modelCards = Object.entries(MODELS).map(([n, c]) =>
    `<div style="background:#1e1e1e;padding:.75rem;border-radius:6px;border:1px solid #333"><div style="color:#ffbf00;font-weight:600;margin-bottom:2px">${n}</div><div style="color:#999;font-size:.8rem">${c.desc}</div></div>`
  ).join('\n');
  const modelOpts = Object.entries(MODELS).map(([n, c]) =>
    `<option value="${n}">${n} - ${c.desc}</option>`
  ).join('\n');

  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>gemini-web2api</title>
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'Mono','SF Mono','Consolas',monospace;background:#121212;color:#e0e0e0;line-height:1.6}
.container{max-width:1100px;margin:0 auto;padding:1rem}
header{background:#1e1e1e;border-bottom:1px solid #333;padding:1rem}
.header-inner{display:flex;justify-content:space-between;align-items:center;max-width:1100px;margin:0 auto;padding:0 1rem}
.logo{font-size:1.4rem;font-weight:bold;color:#ffbf00}
.status-dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:6px}
.healthy{background:#10b981}.unhealthy{background:#ef4444}
.checking{background:#f59e0b;animation:pulse 1.5s infinite}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.5}}
.card{background:#1e1e1e;border:1px solid #333;border-radius:8px;padding:1.25rem;margin-bottom:1rem}
.card h2{color:#ffbf00;font-size:1rem;margin-bottom:.75rem}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:.75rem}
input,select,textarea,button{font-family:inherit;font-size:.85rem}
input,select,textarea{background:#222;border:1px solid #444;color:#ccc;padding:.4rem .6rem;border-radius:4px;width:100%}
button{background:#ffbf00;color:#000;border:none;padding:.4rem .8rem;border-radius:4px;cursor:pointer;font-weight:600}
button:hover{background:#e6ac00}button:disabled{opacity:.5;cursor:not-allowed}
.terminal{background:#0a0a0a;border:1px solid #333;border-radius:8px;padding:1rem;min-height:280px;max-height:480px;overflow-y:auto;font-size:.82rem;white-space:pre-wrap;word-break:break-all}
.terminal::-webkit-scrollbar{width:6px}.terminal::-webkit-scrollbar-thumb{background:#555;border-radius:3px}
.user-msg{color:#10b981}.assistant-msg{color:#e0e0e0}.error-msg{color:#ef4444}
.info{color:#888;font-size:.78rem;margin-top:.4rem}
footer{text-align:center;padding:1.5rem 0;color:#666;font-size:.78rem}
a{color:#ffbf00;text-decoration:none}a:hover{text-decoration:underline}
.input-row{display:flex;gap:.5rem;margin-bottom:.5rem}
.input-row select{width:auto;min-width:180px}.input-row input{flex:1}
.ep{background:#222;border:1px solid #333;border-radius:6px;padding:.6rem .8rem;margin-bottom:.4rem;font-size:.82rem}
.ep code{color:#ffbf00}.ep .method{color:#10b981;font-weight:600;margin-right:.5rem}
</style>
</head>
<body>
<header><div class="header-inner">
<div class="logo"><i class="fas fa-rocket"></i> gemini-web2api</div>
<div><span class="status-dot checking" id="health-dot"></span><span id="health-text" style="font-size:.82rem">检查中...</span></div>
</div></header>
<div class="container">
<div class="grid">
<div class="card">
<h2><i class="fas fa-key"></i> API 配置</h2>
<label style="display:block;margin-bottom:.4rem;color:#aaa;font-size:.82rem">API 密钥</label>
<div class="input-row">
<input type="password" id="api-key" placeholder="输入 API 密钥">
<button onclick="toggleKey()" style="width:auto"><i class="fas fa-eye"></i></button>
<button onclick="saveKey()" style="width:auto"><i class="fas fa-save"></i></button>
</div>
<div class="info">API Base URL: <code id="api-url"></code></div>
</div>
<div class="card">
<h2><i class="fas fa-list"></i> 可用模型</h2>
<div class="grid" style="gap:.5rem">${modelCards}</div>
</div>
</div>
<div class="card">
<h2><i class="fas fa-plug"></i> API 端点</h2>
<div class="ep"><span class="method">POST</span><code>/v1/chat/completions</code> — OpenAI Chat Completions</div>
<div class="ep"><span class="method">POST</span><code>/v1/messages</code> — Anthropic Messages (Claude Code)</div>
<div class="ep"><span class="method">POST</span><code>/v1/responses</code> — OpenAI Responses (Codex CLI)</div>
<div class="ep"><span class="method">GET</span><code>/v1/models</code> — OpenAI 模型列表</div>
<div class="ep"><span class="method">GET</span><code>/v1/models/{model}</code> — 单模型查询</div>
<div class="ep"><span class="method">POST</span><code>/v1beta/models/{model}:generateContent</code> — Google 非流式</div>
<div class="ep"><span class="method">POST</span><code>/v1beta/models/{model}:streamGenerateContent</code> — Google 流式</div>
</div>
<div class="card">
<h2><i class="fas fa-terminal"></i> 实时交互终端</h2>
<div class="input-row">
<select id="model-select">${modelOpts}</select>
<input type="text" id="prompt-input" placeholder="输入您的问题..." onkeydown="if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();sendRequest();}">
<button id="send-btn" onclick="sendRequest()"><i class="fas fa-paper-plane"></i> 发送</button>
</div>
<div class="terminal" id="output-area"></div>
</div>
</div>
<footer><p>gemini-web2api | 注意: 此服务依赖于第三方公开接口，请合理使用。</p></footer>
<script>
const API_BASE=window.location.origin+'/v1';
document.getElementById('api-url').textContent=API_BASE;
const sk=localStorage.getItem('gemini_api_key');if(sk)document.getElementById('api-key').value=sk;
function getKey(){return document.getElementById('api-key').value.trim()||'sk-default'}
function toggleKey(){const i=document.getElementById('api-key');i.type=i.type==='password'?'text':'password'}
function saveKey(){localStorage.setItem('gemini_api_key',getKey())}
function addOut(t,c){const a=document.getElementById('output-area');a.innerHTML+='<div class="'+c+'">'+t+'</div>';a.scrollTop=a.scrollHeight}
async function sendRequest(){
const p=document.getElementById('prompt-input').value.trim();if(!p)return;
const m=document.getElementById('model-select').value;document.getElementById('prompt-input').value='';
addOut('您: '+p,'user-msg');
const b=document.getElementById('send-btn');b.disabled=true;b.innerHTML='<i class="fas fa-spinner fa-spin"></i> 处理中...';
try{
const r=await fetch(API_BASE+'/chat/completions',{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+getKey()},body:JSON.stringify({model:m,messages:[{role:'user',content:p}],stream:true})});
if(!r.ok){const e=await r.json().catch(()=>({error:{message:r.statusText}}));addOut('错误: '+(e.error?.message||JSON.stringify(e)),'error-msg');return}
const rd=r.body.getReader();const dc=new TextDecoder();let at='';
addOut('','assistant-msg');const ms=document.getElementById('output-area').getElementsByClassName('assistant-msg');const lm=ms[ms.length-1];
while(true){const{done,value}=await rd.read();if(done)break;const tx=dc.decode(value);
for(const l of tx.split('\\n')){if(!l.startsWith('data: ')||l==='data: [DONE]')continue;try{const d=JSON.parse(l.slice(6));const dl=d.choices?.[0]?.delta?.content||'';if(dl){at+=dl;lm.textContent='AI: '+at}}catch(e){}}}
if(!at)lm.textContent='AI: (无响应)';
}catch(e){addOut('网络错误: '+e.message,'error-msg')}
finally{b.disabled=false;b.innerHTML='<i class="fas fa-paper-plane"></i> 发送'}
}
async function checkHealth(){
const d=document.getElementById('health-dot');const t=document.getElementById('health-text');
d.className='status-dot checking';t.textContent='检查中...';
try{const r=await fetch(API_BASE+'/models',{headers:{'Authorization':'Bearer '+getKey()}});d.className='status-dot '+(r.ok?'healthy':'unhealthy');t.textContent=r.ok?'上游正常':'上游异常 ('+r.status+')'}
catch(e){d.className='status-dot unhealthy';t.textContent='网络错误'}
}
checkHealth();setInterval(checkHealth,30000);
</script>
</body></html>`;

  return new Response(html, {
    status: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' },
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// server.py: _handle_chat
// ═══════════════════════════════════════════════════════════════════════════════

async function handleChat(request, traceId) {
  const req = await _parseBody(request);
  if (!req) return sendJson({ error: { message: 'invalid JSON' } }, 400);

  const model = resolveModel(req.model || CONFIG.default_model);
  if (model.error) return sendJson({ error: { message: model.error } }, 400);

  const tools = req.tools;
  const toolChoice = req.tool_choice || 'auto';
  const prompt = messagesToPrompt(req.messages || [], tools, toolChoice);
  if (!prompt.trim()) return sendJson({ error: { message: 'empty prompt' } }, 400);

  const stream = req.stream === true;
  const cid = 'chatcmpl-' + crypto.randomUUID().slice(0, 12);
  const now = Math.floor(Date.now() / 1000);

  // Python: if stream and (not tools or tool_choice == "none"):
  if (stream && (!tools || toolChoice === 'none')) {
    return handleChatStream(prompt, model, cid, now, traceId);
  }

  // Non-streaming (or streaming with tools)
  let text;
  try {
    text = await generate(prompt, model.mode, model.think, model.extra, traceId);
  } catch (e) {
    return sendJson({ error: { message: `upstream error: ${e}` } }, 502);
  }

  let toolCalls = null;
  if (tools && text && toolChoice !== 'none') {
    [text, toolCalls] = parseToolCalls(text);
  }

  const msg = { role: 'assistant', content: text || null };
  if (toolCalls && toolCalls.length) msg.tool_calls = toolCalls;
  const finish = toolCalls && toolCalls.length ? 'tool_calls' : 'stop';

  if (stream) {
    const chunk = { id: cid, object: 'chat.completion.chunk', created: now, model: model.name, choices: [{ index: 0, delta: msg, finish_reason: finish }] };
    const encoder = new TextEncoder();
    const body = new ReadableStream({
      start(c) {
        c.enqueue(encoder.encode('data: ' + JSON.stringify(chunk) + '\n\n'));
        c.enqueue(encoder.encode('data: [DONE]\n\n'));
        c.close();
      },
    });
    return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Access-Control-Allow-Origin': '*' } });
  }

  return sendJson({
    id: cid, object: 'chat.completion', created: now, model: model.name,
    choices: [{ index: 0, message: msg, finish_reason: finish }],
    usage: _usage(prompt, text),
  }, 200);
}

// Python: streaming part of _handle_chat
async function handleChatStream(prompt, model, cid, now, traceId) {
  const encoder = new TextEncoder();
  const body = new ReadableStream({
    async start(controller) {
      try {
        const upstream = await generateStream(prompt, model.mode, model.think, model.extra, traceId);
        const reader = upstream.getReader();
        let prevText = '';
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const decoded = new TextDecoder().decode(value);
          // Python: for line in buf.split("\n"): for t in _extract_texts_from_line(line):
          for (const line of decoded.split('\n')) {
            for (const t of extractTextsFromLine(line)) {
              if (t.length > prevText.length) {
                const delta = cleanText(t.slice(prevText.length));
                if (delta) {
                  const chunk = { id: cid, object: 'chat.completion.chunk', created: now, model: model.name, choices: [{ index: 0, delta: { content: delta }, finish_reason: null }] };
                  controller.enqueue(encoder.encode('data: ' + JSON.stringify(chunk) + '\n\n'));
                }
                prevText = t;
              }
            }
          }
        }
        const end = { id: cid, object: 'chat.completion.chunk', created: now, model: model.name, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] };
        controller.enqueue(encoder.encode('data: ' + JSON.stringify(end) + '\n\n'));
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();
      } catch (e) {
        log(`Stream error: ${e.message}`);
        controller.close();
      }
    },
  });
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Access-Control-Allow-Origin': '*' } });
}

// ═══════════════════════════════════════════════════════════════════════════════
// server.py: _handle_responses
// ═══════════════════════════════════════════════════════════════════════════════

async function handleResponses(request, traceId) {
  const req = await _parseBody(request);
  if (!req) return sendJson({ error: { message: 'invalid JSON' } }, 400);

  const model = resolveModel(req.model || CONFIG.default_model);
  if (model.error) return sendJson({ error: { message: model.error } }, 400);

  // Python: convert input items to messages
  const inputItems = req.input || [];
  const tools = req.tools;
  const messages = [];

  if (req.instructions) messages.push({ role: 'system', content: req.instructions });

  if (typeof inputItems === 'string') {
    messages.push({ role: 'user', content: inputItems });
  } else if (Array.isArray(inputItems)) {
    for (const item of inputItems) {
      if (typeof item === 'string') {
        messages.push({ role: 'user', content: item });
      } else if (typeof item === 'object' && item !== null) {
        if (item.type === 'function_call_output') {
          messages.push({ role: 'tool', tool_call_id: item.call_id || '', name: item.name || '', content: item.output || '' });
        } else if (item.role === 'assistant' || (item.type === 'message' && item.role === 'assistant')) {
          const cp = item.content || [];
          let textAcc = '';
          const tcList = [];
          if (Array.isArray(cp)) {
            for (const c of cp) {
              if (typeof c === 'object' && c !== null) {
                if (c.type === 'output_text') textAcc += c.text || '';
                else if (c.type === 'function_call') tcList.push(c);
              }
            }
          } else if (typeof cp === 'string') {
            textAcc = cp;
          }
          const m = { role: 'assistant', content: textAcc || null };
          if (tcList.length) {
            m.tool_calls = tcList.map((tc, i) => ({
              id: tc.call_id || `call_${i}`, type: 'function',
              function: { name: tc.name || '', arguments: tc.arguments || '{}' },
            }));
          }
          messages.push(m);
        } else {
          let content = item.content || '';
          if (Array.isArray(content)) {
            content = content.filter(c => c.type === 'text' || c.type === 'input_text').map(c => c.text || '').join(' ');
          }
          messages.push({ role: item.role || 'user', content });
        }
      }
    }
  }

  // Python: normalize tools
  let normalizedTools = tools;
  if (tools) {
    normalizedTools = tools.map(t => {
      if (t.type === 'function' && !t.function) {
        return { type: 'function', function: { name: t.name, description: t.description || '', parameters: t.parameters || {} } };
      }
      return t;
    });
  }

  const toolChoice = req.tool_choice || 'auto';
  const prompt = messagesToPrompt(messages, normalizedTools, toolChoice);
  if (!prompt.trim()) return sendJson({ error: { message: 'empty input' } }, 400);

  let text;
  try {
    text = await generate(prompt, model.mode, model.think, model.extra, traceId);
  } catch (e) {
    return sendJson({ error: { message: `upstream error: ${e}` } }, 502);
  }

  let toolCalls = null;
  if (normalizedTools && text && toolChoice !== 'none') {
    [text, toolCalls] = parseToolCalls(text);
  }

  const rid = 'resp_' + crypto.randomUUID().slice(0, 16);
  const mid = 'msg_' + crypto.randomUUID().slice(0, 12);
  const output = [];

  if (toolCalls) {
    for (const tc of toolCalls) {
      output.push({ type: 'function_call', id: tc.id, call_id: tc.id, name: tc.function.name, arguments: tc.function.arguments, status: 'completed' });
    }
  }
  if (text || !toolCalls) {
    output.push({ type: 'message', id: mid, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: text || '', annotations: [] }] });
  }

  if (req.stream) {
    const encoder = new TextEncoder();
    const body = new ReadableStream({
      start(controller) {
        // response.created
        const ev1 = { type: 'response.created', response: { id: rid, object: 'response', status: 'in_progress', model: model.name, output: [] } };
        controller.enqueue(encoder.encode('event: response.created\ndata: ' + JSON.stringify(ev1) + '\n\n'));
        for (const item of output) {
          if (item.type === 'function_call') {
            const ev = { type: 'response.function_call_arguments.done', item_id: item.id, call_id: item.call_id, name: item.name, arguments: item.arguments };
            controller.enqueue(encoder.encode('event: response.function_call_arguments.done\ndata: ' + JSON.stringify(ev) + '\n\n'));
          } else if (item.type === 'message') {
            for (let ci = 0; ci < item.content.length; ci++) {
              const ev = { type: 'response.output_text.done', item_id: item.id, content_index: ci, text: item.content[ci].text };
              controller.enqueue(encoder.encode('event: response.output_text.done\ndata: ' + JSON.stringify(ev) + '\n\n'));
            }
          }
        }
        const respObj = { id: rid, object: 'response', status: 'completed', model: model.name, output, usage: { input_tokens: Math.floor(prompt.length / 4), output_tokens: Math.floor((text || '').length / 4), total_tokens: Math.floor((prompt.length + (text || '').length) / 4) } };
        controller.enqueue(encoder.encode('event: response.completed\ndata: ' + JSON.stringify({ type: 'response.completed', response: respObj }) + '\n\n'));
        controller.close();
      },
    });
    return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Access-Control-Allow-Origin': '*' } });
  }

  return sendJson({
    id: rid, object: 'response', created_at: Math.floor(Date.now() / 1000),
    status: 'completed', model: model.name, output,
    usage: { input_tokens: Math.floor(prompt.length / 4), output_tokens: Math.floor((text || '').length / 4), total_tokens: Math.floor((prompt.length + (text || '').length) / 4) },
  }, 200);
}

// ═══════════════════════════════════════════════════════════════════════════════
// Anthropic Messages API (POST /v1/messages) — required by Claude Code
// ═══════════════════════════════════════════════════════════════════════════════

// Convert Anthropic messages to our internal prompt format
function anthropicMessagesToPrompt(req) {
  const parts = [];
  const tools = req.tools;
  const toolChoice = req.tool_choice;

  // System prompt
  const sys = req.system;
  if (sys) {
    let sysText = '';
    if (typeof sys === 'string') sysText = sys;
    else if (Array.isArray(sys)) {
      sysText = sys.filter(b => b.type === 'text').map(b => b.text || '').join('\n');
    }
    if (sysText) parts.push(`[System instruction]: ${sysText}`);
  }

  // Tool definitions
  if (tools && tools.length) {
    const tc = toolChoice || { type: 'auto' };
    let constraint = '';
    if (tc.type === 'none') constraint = '\n\nIMPORTANT: Do NOT call any tools. Respond with text only.';
    else if (tc.type === 'any') constraint = '\n\nIMPORTANT: You MUST call at least one tool. Do not respond with text only.';
    else if (tc.type === 'tool' && tc.name) constraint = `\n\nIMPORTANT: You MUST call the tool "${tc.name}". Do not call other tools.`;

    const toolDefs = tools.map(t => ({
      name: t.name || '',
      description: t.description || '',
      parameters: t.input_schema || {},
    }));

    if (tc.type !== 'none' && toolDefs.length) {
      parts.push(
        '# Tool Use\n\n' +
        'You can call the following tools. Call format:\n' +
        '```tool_call\n{"name": "func_name", "arguments": {...}}\n```\n' +
        'When calling tools, output ONLY the tool_call block(s).\n\n' +
        'Available tools:\n' + JSON.stringify(toolDefs, null, 2) +
        constraint
      );
    }
  }

  // Messages
  for (const msg of (req.messages || [])) {
    const role = msg.role;
    const content = msg.content;

    if (role === 'user') {
      if (typeof content === 'string') {
        parts.push(content);
      } else if (Array.isArray(content)) {
        const textParts = [];
        for (const block of content) {
          if (block.type === 'text') textParts.push(block.text || '');
          else if (block.type === 'tool_result') {
            // tool_result: convert to [Tool result for ...]
            let resultText = '';
            if (typeof block.content === 'string') resultText = block.content;
            else if (Array.isArray(block.content)) {
              resultText = block.content.filter(b => b.type === 'text').map(b => b.text || '').join(' ');
            }
            parts.push(`[Tool result for ${block.tool_use_id || ''}]: ${resultText}`);
          } else if (block.type === 'image') {
            textParts.push('[Note: Image input not supported. Please describe the image in text.]');
          }
        }
        if (textParts.length) parts.push(textParts.join(' '));
      }
    } else if (role === 'assistant') {
      if (typeof content === 'string') {
        parts.push(`[Assistant]: ${content}`);
      } else if (Array.isArray(content)) {
        const textParts = [];
        const tcStrs = [];
        for (const block of content) {
          if (block.type === 'text') textParts.push(block.text || '');
          else if (block.type === 'tool_use') {
            tcStrs.push('```tool_call\n{"name": "' + (block.name || '') + '", "arguments": ' + JSON.stringify(block.input || {}) + '}\n```');
          }
        }
        const textContent = textParts.join(' ');
        parts.push('[Assistant]: ' + (textContent || '') + (tcStrs.length ? '\n' + tcStrs.join('\n') : ''));
      }
    }
  }

  return parts.filter(p => p).join('\n\n');
}

// Convert parsed tool_calls to Anthropic tool_use content blocks
function toAnthropicToolUse(toolCalls) {
  return toolCalls.map(tc => ({
    type: 'tool_use',
    id: tc.id,
    name: tc.function.name,
    input: JSON.parse(tc.function.arguments || '{}'),
  }));
}

// Build Anthropic non-streaming response
function anthropicResponse(msgId, model, content, stopReason, usage) {
  return {
    id: msgId,
    type: 'message',
    role: 'assistant',
    content: content,
    model: model,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: usage,
  };
}

async function handleAnthropicMessages(request, traceId) {
  const req = await _parseBody(request);
  if (!req) return sendJson({ type: 'error', error: { type: 'invalid_request_error', message: 'invalid JSON' } }, 400);

  const model = resolveModel(req.model || CONFIG.default_model);
  if (model.error) return sendJson({ type: 'error', error: { type: 'invalid_request_error', message: model.error } }, 400);

  const prompt = anthropicMessagesToPrompt(req);
  if (!prompt.trim()) return sendJson({ type: 'error', error: { type: 'invalid_request_error', message: 'empty prompt' } }, 400);

  const stream = req.stream === true;
  const hasTools = !!(req.tools && req.tools.length);
  const toolChoiceType = (req.tool_choice || {}).type || 'auto';
  const msgId = 'msg_' + crypto.randomUUID().slice(0, 24);

  // Streaming without tools
  if (stream && (!hasTools || toolChoiceType === 'none')) {
    return handleAnthropicStream(prompt, model, msgId, traceId);
  }

  // Non-streaming (or streaming with tools — need full text first)
  let text;
  try {
    text = await generate(prompt, model.mode, model.think, model.extra, traceId);
  } catch (e) {
    return sendJson({ type: 'error', error: { type: 'api_error', message: `upstream error: ${e}` } }, 502);
  }

  let toolCalls = null;
  if (hasTools && text && toolChoiceType !== 'none') {
    [text, toolCalls] = parseToolCalls(text);
  }

  // Build content blocks
  const contentBlocks = [];
  if (text) contentBlocks.push({ type: 'text', text: text });
  if (toolCalls && toolCalls.length) {
    for (const tcu of toAnthropicToolUse(toolCalls)) contentBlocks.push(tcu);
  }
  if (!contentBlocks.length) contentBlocks.push({ type: 'text', text: '' });

  const stopReason = (toolCalls && toolCalls.length) ? 'tool_use' : 'end_turn';
  const usage = {
    input_tokens: Math.floor(prompt.length / 4),
    output_tokens: Math.floor((text || '').length / 4),
  };

  if (stream) {
    return handleAnthropicStreamWithContent(model, msgId, contentBlocks, stopReason, usage, traceId);
  }

  return sendJson(anthropicResponse(msgId, model.name, contentBlocks, stopReason, usage), 200);
}

// Anthropic SSE streaming (no tools)
async function handleAnthropicStream(prompt, model, msgId, traceId) {
  const encoder = new TextEncoder();
  const body = new ReadableStream({
    async start(controller) {
      const emit = (event, data) => {
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      };

      try {
        // message_start
        emit('message_start', {
          type: 'message_start',
          message: {
            id: msgId, type: 'message', role: 'assistant', content: [],
            model: model.name, stop_reason: null, stop_sequence: null,
            usage: { input_tokens: Math.floor(prompt.length / 4), output_tokens: 0 },
          },
        });

        // content_block_start (text block, index 0)
        emit('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });

        const upstream = await generateStream(prompt, model.mode, model.think, model.extra, traceId);
        const reader = upstream.getReader();
        let prevText = '';
        let totalOutputTokens = 0;

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const decoded = new TextDecoder().decode(value);
          for (const line of decoded.split('\n')) {
            for (const t of extractTextsFromLine(line)) {
              if (t.length > prevText.length) {
                const delta = cleanText(t.slice(prevText.length));
                if (delta) {
                  totalOutputTokens += Math.floor(delta.length / 4);
                  emit('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: delta } });
                }
                prevText = t;
              }
            }
          }
        }

        // content_block_stop
        emit('content_block_stop', { type: 'content_block_stop', index: 0 });

        // message_delta
        emit('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: totalOutputTokens } });

        // message_stop
        emit('message_stop', { type: 'message_stop' });

        controller.close();
      } catch (e) {
        log(`Anthropic stream error: ${e.message}`);
        controller.close();
      }
    },
  });
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Access-Control-Allow-Origin': '*' } });
}

// Anthropic SSE streaming with pre-computed content (for tool use)
function handleAnthropicStreamWithContent(model, msgId, contentBlocks, stopReason, usage, traceId) {
  const encoder = new TextEncoder();
  const body = new ReadableStream({
    start(controller) {
      const emit = (event, data) => {
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      };

      // message_start
      emit('message_start', {
        type: 'message_start',
        message: {
          id: msgId, type: 'message', role: 'assistant', content: [],
          model: model.name, stop_reason: null, stop_sequence: null,
          usage: { input_tokens: usage.input_tokens, output_tokens: 0 },
        },
      });

      for (let i = 0; i < contentBlocks.length; i++) {
        const block = contentBlocks[i];

        if (block.type === 'text') {
          emit('content_block_start', { type: 'content_block_start', index: i, content_block: { type: 'text', text: '' } });
          if (block.text) {
            emit('content_block_delta', { type: 'content_block_delta', index: i, delta: { type: 'text_delta', text: block.text } });
          }
          emit('content_block_stop', { type: 'content_block_stop', index: i });
        } else if (block.type === 'tool_use') {
          emit('content_block_start', { type: 'content_block_start', index: i, content_block: { type: 'tool_use', id: block.id, name: block.name, input: '' } });
          const inputJson = JSON.stringify(block.input);
          emit('content_block_delta', { type: 'content_block_delta', index: i, delta: { type: 'input_json_delta', partial_json: inputJson } });
          emit('content_block_stop', { type: 'content_block_stop', index: i });
        }
      }

      emit('message_delta', { type: 'message_delta', delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: usage.output_tokens } });
      emit('message_stop', { type: 'message_stop' });

      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Access-Control-Allow-Origin': '*' } });
}

// ═══════════════════════════════════════════════════════════════════════════════
// server.py: _handle_google_generate
// ═══════════════════════════════════════════════════════════════════════════════

async function handleGoogleGenerate(request, pathname, stream, traceId) {
  const req = await _parseBody(request);
  if (!req) return sendJson({ error: { message: 'invalid JSON' } }, 400);

  const m = pathname.match(/\/v1beta\/models\/([^:?]+)/);
  const modelName = m ? m[1] : CONFIG.default_model;
  const model = resolveModel(modelName);
  if (model.error) return sendJson({ error: { message: model.error } }, 400);

  const toolConfig = req.toolConfig || {};
  const fcMode = (toolConfig.functionCallingConfig || {}).mode || 'AUTO';
  const hasTools = !!(req.tools) && fcMode !== 'NONE';
  const prompt = googleContentsToPrompt(req);
  if (!prompt.trim()) return sendJson({ error: { message: 'empty content' } }, 400);

  log(`Google API: model=${model.name} stream=${stream} tools=${hasTools} prompt_len=${prompt.length}`);

  // Python: if stream and not has_tools:
  if (stream && !hasTools) {
    return handleGoogleStream(prompt, model, traceId);
  }

  // Non-streaming (or streaming with tools)
  let text;
  try {
    text = await generate(prompt, model.mode, model.think, model.extra, traceId);
  } catch (e) {
    return sendJson({ error: { message: `upstream error: ${e}` } }, 502);
  }

  if (!text) log('Warning: empty response from Gemini');

  const responseParts = [];
  if (hasTools && text) {
    const [clean, functionCalls] = parseGoogleFunctionCalls(text);
    if (functionCalls.length) {
      if (clean) responseParts.push({ text: clean });
      for (const fc of functionCalls) responseParts.push({ functionCall: { name: fc.name, args: fc.args } });
    } else {
      responseParts.push({ text });
    }
  } else {
    responseParts.push({ text: text || 'I apologize, but I was unable to generate a response. Please try again.' });
  }

  const candidate = { content: { parts: responseParts, role: 'model' }, finishReason: 'STOP', index: 0 };
  const usage = { promptTokenCount: Math.floor(prompt.length / 4), candidatesTokenCount: Math.floor((text || '').length / 4), totalTokenCount: Math.floor((prompt.length + (text || '').length) / 4) };
  const responseObj = { candidates: [candidate], usageMetadata: usage, modelVersion: model.name };

  if (stream) {
    const encoder = new TextEncoder();
    const body = new ReadableStream({
      start(c) {
        c.enqueue(encoder.encode('data: ' + JSON.stringify(responseObj) + '\n\n'));
        c.close();
      },
    });
    return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Access-Control-Allow-Origin': '*' } });
  }

  return sendJson(responseObj, 200);
}

// Python: streaming part of _handle_google_generate
async function handleGoogleStream(prompt, model, traceId) {
  const encoder = new TextEncoder();
  const body = new ReadableStream({
    async start(controller) {
      try {
        const upstream = await generateStream(prompt, model.mode, model.think, model.extra, traceId);
        const reader = upstream.getReader();
        let fullText = '';
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const decoded = new TextDecoder().decode(value);
          for (const line of decoded.split('\n')) {
            for (const t of extractTextsFromLine(line)) {
              if (t.length > fullText.length) {
                const delta = cleanText(t.slice(fullText.length));
                if (delta) {
                  fullText += delta;
                  const chunkObj = { candidates: [{ content: { parts: [{ text: delta }], role: 'model' }, index: 0 }], modelVersion: model.name };
                  controller.enqueue(encoder.encode('data: ' + JSON.stringify(chunkObj) + '\n\n'));
                }
                // Update fullText to the full upstream text (not just delta)
                fullText = t.length > fullText.length ? t : fullText;
              }
            }
          }
        }
        const finalChunk = {
          candidates: [{ finishReason: 'STOP', index: 0 }],
          usageMetadata: { promptTokenCount: Math.floor(prompt.length / 4), candidatesTokenCount: Math.floor(fullText.length / 4), totalTokenCount: Math.floor((prompt.length + fullText.length) / 4) },
          modelVersion: model.name,
        };
        controller.enqueue(encoder.encode('data: ' + JSON.stringify(finalChunk) + '\n\n'));
        controller.close();
      } catch (e) {
        log(`Google stream error: ${e.message}`);
        controller.close();
      }
    },
  });
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Access-Control-Allow-Origin': '*' } });
}

// ═══════════════════════════════════════════════════════════════════════════════
// Main fetch handler (maps to server.py do_GET / do_POST / do_OPTIONS)
// ═══════════════════════════════════════════════════════════════════════════════

export default {
  async fetch(request, env, ctx) {
    loadConfigFromEnv(env);
    const url = new URL(request.url);
    const pathname = url.pathname;
    const traceId = crypto.randomUUID().slice(0, 8);

    if (CONFIG.log_requests) {
      log(`${request.method} ${pathname} [${traceId}]`);
    }

    try {
      // Python: do_OPTIONS
      if (request.method === 'OPTIONS') return doOptions();

      // Python: do_GET
      if (request.method === 'GET') return doGet(pathname, request);

      // Python: do_POST
      if (request.method === 'POST') {
        // Auth for /v1/ only
        if (pathname.startsWith('/v1/') && !_authorized(request)) {
          return sendJson({ error: { message: 'invalid api key' } }, 401);
        }

        if (pathname === '/v1/chat/completions') return handleChat(request, traceId);
        if (pathname === '/v1/responses') return handleResponses(request, traceId);
        if (pathname === '/v1/messages') return handleAnthropicMessages(request, traceId);
        if (pathname.includes(':generateContent') && !pathname.includes(':streamGenerateContent')) {
          return handleGoogleGenerate(request, pathname, false, traceId);
        }
        if (pathname.includes(':streamGenerateContent')) {
          return handleGoogleGenerate(request, pathname, true, traceId);
        }

        return sendJson({ error: 'not found' }, 404);
      }

      return sendJson({ error: 'method not allowed' }, 405);
    } catch (e) {
      log(`Unhandled error: ${e.message}`);
      return sendJson({ error: { message: String(e) } }, 500);
    }
  },
};
