// gemini-web2api Cloudflare Worker
// Converts Google Gemini web to OpenAI-compatible API

// ─── Configuration ────────────────────────────────────────────────────────────

const CONFIG = {
  PROJECT_NAME: 'gemini-web2api',
  PROJECT_VERSION: '2.0.1',
  UPSTREAM_BASE_URL: 'https://gemini.google.com',
  UPSTREAM_PATH: '/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate',
  GEMINI_BL: 'boq_assistant-bard-web-server_20260525.09_p0',
  API_MASTER_KEY: 'sk-gemini-web2api-key',
  DEFAULT_MODEL: 'gemini-3.5-flash',
  REQUEST_TIMEOUT_MS: 180000,
  RETRY_ATTEMPTS: 3,
  RETRY_DELAY_MS: 2000,
  LOG_REQUESTS: true,
  COOKIE_STRING: '',
  SAPISID: '',
  AUTH_USER: null,
  XSRF_TOKEN: null,
  CACHE_TTL_SEC: 300,
};

const MODELS = {
  'gemini-3.5-flash': { mode: 1, think: 4, desc: 'Fast general-purpose model', desc_zh: '通用快速模型 (默认)' },
  'gemini-3.5-flash-thinking': { mode: 2, think: 0, desc: 'Deep thinking, longest output (~20k chars)', desc_zh: '深度思考 - 用于复杂推理和长文本生成 (~2万字)' },
  'gemini-3.1-pro': { mode: 3, think: 4, desc: 'Pro model (requires cookie)', desc_zh: 'Pro - 高级模型，需Cookie验证' },
  'gemini-auto': { mode: 4, think: 4, desc: 'Auto model selection', desc_zh: '自动模型选择 - 由系统选择最佳模型' },
  'gemini-3.5-flash-thinking-lite': { mode: 5, think: 0, desc: 'Dynamic thinking, adaptive depth', desc_zh: '动态思考 - 自适应深度' },
  'gemini-flash-lite': { mode: 6, think: 4, desc: 'Lightweight fast model', desc_zh: '轻量级快速模型 - 适用于简单查询' },
};

// ─── Config from Environment ──────────────────────────────────────────────────

function loadConfigFromEnv(env) {
  const keys = [
    'API_MASTER_KEY', 'COOKIE_STRING', 'SAPISID', 'AUTH_USER',
    'XSRF_TOKEN', 'GEMINI_BL', 'DEFAULT_MODEL', 'LOG_REQUESTS',
    'RETRY_ATTEMPTS', 'RETRY_DELAY_MS', 'REQUEST_TIMEOUT_MS', 'CACHE_TTL_SEC',
  ];
  keys.forEach(k => {
    if (env[k] !== undefined) {
      if (k === 'AUTH_USER' || k === 'XSRF_TOKEN' || k === 'COOKIE_STRING' ||
          k === 'SAPISID' || k === 'GEMINI_BL' || k === 'DEFAULT_MODEL' ||
          k === 'API_MASTER_KEY') {
        CONFIG[k] = env[k];
      } else {
        // Numeric / boolean fields
        if (env[k] === 'false' || env[k] === '0') CONFIG[k] = false;
        else if (env[k] === 'true' || env[k] === '1') CONFIG[k] = true;
        else if (!isNaN(env[k]) && env[k] !== '') CONFIG[k] = Number(env[k]);
        else CONFIG[k] = env[k];
      }
    }
  });
  if (!CONFIG.API_MASTER_KEY || CONFIG.API_MASTER_KEY === '') {
    console.warn('Warning: API_MASTER_KEY not set. Using default key.');
    CONFIG.API_MASTER_KEY = 'sk-gemini-web2api-key';
  }
}

// ─── SAPISID Hash ─────────────────────────────────────────────────────────────

async function makeSapisidHash(sapisid) {
  if (!sapisid) return '';
  const ts = Math.floor(Date.now() / 1000);
  const msg = new TextEncoder().encode(`${ts} ${sapisid} https://gemini.google.com`);
  try {
    const hash = await crypto.subtle.digest('SHA-1', msg);
    const arr = Array.from(new Uint8Array(hash));
    const hex = arr.map(b => b.toString(16).padStart(2, '0')).join('');
    return `SAPISIDHASH ${ts}_${hex}`;
  } catch (e) {
    console.error('SAPISIDHASH failed:', e);
    return '';
  }
}

// ─── URL & Header Builders ────────────────────────────────────────────────────

function accountPrefix() {
  return CONFIG.AUTH_USER ? `/u/${CONFIG.AUTH_USER}` : '';
}

function buildUpstreamUrl() {
  const prefix = accountPrefix();
  const reqid = Date.now() % 1000000;
  return `${CONFIG.UPSTREAM_BASE_URL}${prefix}${CONFIG.UPSTREAM_PATH}?bl=${CONFIG.GEMINI_BL}&hl=en&_reqid=${reqid}&rt=c`;
}

function buildGeminiRequestBody(prompt, modelId, thinkMode) {
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

  const outer = [null, JSON.stringify(inner)];
  const params = { 'f.req': JSON.stringify(outer) };
  if (CONFIG.XSRF_TOKEN) params['at'] = CONFIG.XSRF_TOKEN;
  return new URLSearchParams(params).toString();
}

async function buildGeminiRequestHeaders() {
  const prefix = accountPrefix();
  const headers = {
    'Content-Type': 'application/x-www-form-urlencoded',
    'Origin': 'https://gemini.google.com',
    'Referer': `https://gemini.google.com${prefix}/app`,
    'X-Same-Domain': '1',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  };
  if (prefix) headers['X-Goog-AuthUser'] = String(CONFIG.AUTH_USER);
  if (CONFIG.COOKIE_STRING) headers['Cookie'] = CONFIG.COOKIE_STRING;
  if (CONFIG.SAPISID) {
    const hash = await makeSapisidHash(CONFIG.SAPISID);
    if (hash) headers['Authorization'] = hash;
  }
  return headers;
}

// ─── Stream Parsing ───────────────────────────────────────────────────────────

function cleanText(text) {
  text = text.replace(/```(?:python|javascript|text)\?code_(?:reference|stdout)&code_event_index=\d+\n.*?```\n?/gs, '');
  text = text.replace(/http:\/\/googleusercontent\.com\/card_content\/\d+\n?/g, '');
  return text.trim();
}

function parseGeminiStreamChunk(chunk, prevFullText) {
  const deltas = [];
  let current = prevFullText;
  const lines = chunk.split('\n');
  for (const line of lines) {
    if (!line.includes('"wrb.fr"') || line.length < 200) continue;
    try {
      const arr = JSON.parse(line);
      const innerStr = arr[0]?.[2];
      if (!innerStr || innerStr.length < 50) continue;
      const inner = JSON.parse(innerStr);
      if (Array.isArray(inner) && inner[4]) {
        for (const part of inner[4]) {
          if (Array.isArray(part) && part[1] && Array.isArray(part[1])) {
            for (const t of part[1]) {
              if (typeof t === 'string' && t.length > current.length) {
                let delta = t.slice(current.length);
                delta = cleanText(delta);
                if (delta) deltas.push(delta);
                current = t;
              }
            }
          }
        }
      }
    } catch (e) {}
  }
  return { deltas, newFullText: current };
}

// ─── Tool Choice Instruction ──────────────────────────────────────────────────

function buildToolChoiceInstruction(toolChoice, toolDefs) {
  if (toolChoice === 'none') {
    return '\n\nIMPORTANT: Do NOT call any tools. Respond with text only.';
  }
  if (toolChoice === 'required') {
    return '\n\nIMPORTANT: You MUST call at least one tool. Do not respond with text only.';
  }
  if (typeof toolChoice === 'object' && toolChoice !== null) {
    const fnName = toolChoice?.function?.name || toolChoice?.name || '';
    if (fnName) {
      return `\n\nIMPORTANT: You MUST call the tool "${fnName}". Do not call other tools.`;
    }
  }
  return '';
}

// ─── Messages to Prompt (OpenAI format) ───────────────────────────────────────

function messagesToPrompt(messages, tools = null, toolChoice = null) {
  const parts = [];

  // Tool definitions
  if (tools && toolChoice !== 'none') {
    const toolDefs = tools.map(t => {
      const fn = t.type === 'function' ? t.function : t;
      return {
        name: fn.name || t.name || '',
        description: fn.description || t.description || '',
        parameters: fn.parameters || t.parameters || {},
      };
    });
    const constraint = buildToolChoiceInstruction(toolChoice, toolDefs);
    parts.push(
      '# Tool Use\n\n' +
      'You can call the following tools. Call format:\n' +
      '```tool_call\n{"name": "func_name", "arguments": {...}}\n```\n' +
      'When calling tools, output ONLY the tool_call block(s).\n\n' +
      `Available tools:\n${JSON.stringify(toolDefs, null, 2)}` +
      constraint
    );
  }

  for (const msg of messages) {
    const role = msg.role || 'user';
    let content = msg.content || '';

    // Handle array content (multimodal)
    if (Array.isArray(content)) {
      content = content
        .filter(c => c.type === 'text' || c.type === 'input_text')
        .map(c => c.text || '')
        .filter(t => t)
        .join(' ');
    }

    if (role === 'system') {
      parts.push(`[System instruction]: ${content}`);
    } else if (role === 'assistant') {
      if (msg.tool_calls && msg.tool_calls.length > 0) {
        const tcStrs = msg.tool_calls.map(tc => {
          const fn = tc.function || {};
          return '```tool_call\n' + JSON.stringify({ name: fn.name, arguments: JSON.parse(fn.arguments || '{}') }) + '\n```';
        });
        parts.push(`[Assistant]: ${content || ''}\n` + tcStrs.join('\n'));
      } else {
        parts.push(`[Assistant]: ${content}`);
      }
    } else if (role === 'tool') {
      parts.push(`[Tool result for ${msg.name || msg.tool_call_id || ''}]: ${content}`);
    } else {
      parts.push(content || '');
    }
  }

  return parts.filter(p => p).join('\n\n');
}

// ─── Parse Tool Calls (OpenAI format) ─────────────────────────────────────────

function parseToolCalls(text) {
  const toolCalls = [];
  const pattern = /```tool_call\s*\n(.*?)\n```/gs;
  let cleanText = text;
  let match;
  while ((match = pattern.exec(text)) !== null) {
    try {
      const data = JSON.parse(match[1].trim());
      toolCalls.push({
        id: `call_${crypto.randomUUID().slice(0, 8)}`,
        type: 'function',
        function: {
          name: data.name,
          arguments: JSON.stringify(data.arguments || data.args || {}, null, 2),
        },
      });
    } catch (e) {}
  }
  cleanText = cleanText.replace(pattern, '').trim();
  return { cleanText, toolCalls };
}

// ─── Parse Google Function Calls ──────────────────────────────────────────────

function parseGoogleFunctionCalls(text) {
  const functionCalls = [];
  const pattern1 = /```function_call\s*\n(.*?)\n```/gs;
  const pattern2 = /(?:^|\n)function_call\s*\n(\{[^`]*?\})/g;
  let clean = text;

  for (const pattern of [pattern1, pattern2]) {
    let match;
    while ((match = pattern.exec(clean)) !== null) {
      try {
        const data = JSON.parse(match[1].trim());
        if (data.name) {
          functionCalls.push({
            name: data.name,
            args: data.args || data.arguments || {},
          });
        }
      } catch (e) {}
    }
    clean = clean.replace(pattern, '').trim();
  }

  // Try raw JSON with name + args
  if (!functionCalls.length && clean.trim().startsWith('{')) {
    try {
      const data = JSON.parse(clean.trim());
      if (data.name && (data.args || data.arguments)) {
        functionCalls.push({ name: data.name, args: data.args || data.arguments });
        clean = '';
      }
    } catch (e) {}
  }

  return { cleanText: clean, functionCalls };
}

// ─── Google Contents to Prompt ────────────────────────────────────────────────

function buildGoogleToolPrompt(toolDefs) {
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
    `Available tools:\n${toolSpec}`
  );
}

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

function googleContentsToPrompt(req) {
  const parts = [];
  const toolConfig = req.toolConfig || {};
  const fcMode = toolConfig.functionCallingConfig?.mode || 'AUTO';

  // Extract tool definitions
  const tools = req.tools;
  const toolDefs = [];
  if (tools && fcMode !== 'NONE') {
    for (const toolGroup of tools) {
      for (const fn of toolGroup.functionDeclarations || []) {
        const td = { name: fn.name || '', description: fn.description || '' };
        const params = fn.parameters || fn.parametersJsonSchema;
        if (params) td.parameters = params;
        toolDefs.push(td);
      }
    }
  }

  // System instruction
  const sysInst = req.systemInstruction;
  if (sysInst) {
    const sysParts = sysInst.parts || [];
    const sysText = sysParts.filter(p => p.text).map(p => p.text).join(' ');
    if (sysText) {
      if (toolDefs.length) {
        const constraint = googleToolChoiceInstruction(req);
        parts.push(sysText + '\n\n' + buildGoogleToolPrompt(toolDefs) + constraint);
      } else {
        parts.push(sysText);
      }
    }
  } else if (toolDefs.length) {
    const constraint = googleToolChoiceInstruction(req);
    parts.push(buildGoogleToolPrompt(toolDefs) + constraint);
  }

  // Contents
  for (const content of req.contents || []) {
    const role = content.role || 'user';
    const msgParts = [];
    for (const p of content.parts || []) {
      if (p.text) msgParts.push(p.text);
      else if (p.functionCall) {
        const fc = p.functionCall;
        msgParts.push('```function_call\n' + JSON.stringify({ name: fc.name, args: fc.args || {} }) + '\n```');
      } else if (p.functionResponse) {
        const fr = p.functionResponse;
        msgParts.push(`[Tool result for ${fr.name || ''}]: ${JSON.stringify(fr.response || {})}`);
      }
    }
    const text = msgParts.join('\n');
    if (role === 'model') parts.push(`[Assistant]: ${text}`);
    else parts.push(text);
  }

  return parts.filter(p => p).join('\n\n');
}

// ─── Model Resolution ─────────────────────────────────────────────────────────

function resolveModel(modelName) {
  let thinkOverride = null;
  let name = modelName;
  if (name.includes('@think=')) {
    const parts = name.split('@think=');
    name = parts[0];
    thinkOverride = parseInt(parts[1], 10);
    if (isNaN(thinkOverride)) thinkOverride = null;
  }
  const cfg = MODELS[name];
  if (!cfg) {
    // Fallback to default
    const defaultCfg = MODELS[CONFIG.DEFAULT_MODEL];
    return {
      modelName: CONFIG.DEFAULT_MODEL,
      mode: defaultCfg.mode,
      think: thinkOverride !== null ? thinkOverride : defaultCfg.think,
      extra: null,
      error: null,
    };
  }
  return {
    modelName: name,
    mode: cfg.mode,
    think: thinkOverride !== null ? thinkOverride : cfg.think,
    extra: cfg.extra || null,
    error: null,
  };
}

// ─── Gemini Upstream Calls ────────────────────────────────────────────────────

async function callGeminiWithRetry(prompt, modelId, thinkMode, traceId) {
  const body = buildGeminiRequestBody(prompt, modelId, thinkMode);
  const url = buildUpstreamUrl();
  let lastErr;
  for (let attempt = 0; attempt < CONFIG.RETRY_ATTEMPTS; attempt++) {
    try {
      const headers = await buildGeminiRequestHeaders();
      headers['X-Request-ID'] = traceId;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), CONFIG.REQUEST_TIMEOUT_MS);
      const resp = await fetch(url, {
        method: 'POST', headers, body, signal: controller.signal,
        cf: { httpVersion: '3' },
      });
      clearTimeout(timeout);
      if (!resp.ok) throw new Error(`Upstream error: ${resp.status} ${resp.statusText}`);
      const raw = await resp.text();
      const parsed = parseGeminiStreamChunk(raw, '');
      return { text: parsed.newFullText, raw };
    } catch (e) {
      lastErr = e;
      if (attempt < CONFIG.RETRY_ATTEMPTS - 1) {
        console.log(`[${traceId}] Retry ${attempt + 1}/${CONFIG.RETRY_ATTEMPTS}: ${e.message}`);
        await new Promise(r => setTimeout(r, CONFIG.RETRY_DELAY_MS));
      }
    }
  }
  throw lastErr;
}

async function callGeminiStream(prompt, modelId, thinkMode, traceId) {
  const body = buildGeminiRequestBody(prompt, modelId, thinkMode);
  const url = buildUpstreamUrl();
  try {
    const headers = await buildGeminiRequestHeaders();
    headers['X-Request-ID'] = traceId;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), CONFIG.REQUEST_TIMEOUT_MS);
    const resp = await fetch(url, {
      method: 'POST', headers, body, signal: controller.signal,
      cf: { httpVersion: '3' },
    });
    clearTimeout(timeout);
    if (!resp.ok) throw new Error(`Upstream error: ${resp.status} ${resp.statusText}`);
    return resp.body;
  } catch (e) {
    console.error(`[${traceId}] Stream upstream failed:`, e);
    throw e;
  }
}

// ─── JSON Response Helper ─────────────────────────────────────────────────────

function jsonResponse(data, status = 200, extraHeaders = {}) {
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': '*',
    ...extraHeaders,
  };
  return new Response(JSON.stringify(data, null, 2), { status, headers });
}

// ─── API Route Handler ────────────────────────────────────────────────────────

async function handleApiRequest(request, pathname, traceId, executionCtx, env) {
  // Auth check
  const authHeader = request.headers.get('Authorization') || '';
  const apiKey = authHeader ? authHeader.replace(/^Bearer\s+/i, '') : request.headers.get('x-api-key');
  if (apiKey !== CONFIG.API_MASTER_KEY) {
    return jsonResponse({ error: { message: 'invalid api key' } }, 401, { 'X-Worker-Trace-ID': traceId });
  }

  // Cache for model list
  if (request.method === 'GET' && pathname === '/v1/models') {
    const cache = caches.default;
    const cacheKey = new Request(request.url + '#models', request);
    let cached = await cache.match(cacheKey);
    if (cached) {
      const newHeaders = new Headers(cached.headers);
      newHeaders.set('X-Worker-Trace-ID', traceId);
      return new Response(cached.body, { ...cached, headers: newHeaders });
    }
  }

  const method = request.method;

  // ─── GET /v1/models ───
  if (method === 'GET' && pathname === '/v1/models') {
    return handleListModels(traceId, apiKey, request, executionCtx);
  }

  // ─── GET /v1beta/models ───
  if (method === 'GET' && pathname === '/v1beta/models') {
    return handleGoogleListModels(traceId);
  }

  // ─── POST endpoints ───
  if (method !== 'POST') {
    return jsonResponse({ error: { message: 'Method not allowed', code: 405 } }, 405, { 'X-Worker-Trace-ID': traceId });
  }

  // ─── POST /v1/chat/completions ───
  if (pathname === '/v1/chat/completions') {
    return handleChatCompletions(request, traceId, executionCtx);
  }

  // ─── POST /v1/responses ───
  if (pathname === '/v1/responses') {
    return handleResponses(request, traceId, executionCtx);
  }

  // ─── POST /v1beta/models/:model:generateContent ───
  if (pathname.includes(':generateContent') && !pathname.includes(':streamGenerateContent')) {
    return handleGoogleGenerate(request, pathname, traceId, false);
  }

  // ─── POST /v1beta/models/:model:streamGenerateContent ───
  if (pathname.includes(':streamGenerateContent')) {
    return handleGoogleGenerate(request, pathname, traceId, true);
  }

  return jsonResponse({ error: { message: 'Not found', code: 404 } }, 404, { 'X-Worker-Trace-ID': traceId });
}

// ─── GET /v1/models ───────────────────────────────────────────────────────────

async function handleListModels(traceId, apiKey, request, executionCtx) {
  const data = Object.entries(MODELS).map(([name, cfg]) => ({
    id: name, object: 'model', created: 1700000000, owned_by: 'google',
    description: cfg.desc_zh || cfg.desc,
  }));
  const resp = jsonResponse({ object: 'list', data }, 200, { 'X-Worker-Trace-ID': traceId });
  if (executionCtx) {
    const cache = caches.default;
    const cacheKey = new Request(request.url + '#models', request);
    executionCtx.waitUntil(cache.put(cacheKey, resp.clone()));
  }
  return resp;
}

// ─── GET /v1beta/models ───────────────────────────────────────────────────────

function handleGoogleListModels(traceId) {
  const models = Object.entries(MODELS).map(([name, cfg]) => ({
    name: `models/${name}`,
    displayName: name,
    description: cfg.desc,
    supportedGenerationMethods: ['generateContent', 'streamGenerateContent'],
  }));
  return jsonResponse({ models }, 200, { 'X-Worker-Trace-ID': traceId });
}

// ─── POST /v1/chat/completions ────────────────────────────────────────────────

async function handleChatCompletions(request, traceId, executionCtx) {
  const startTime = Date.now();
  let req;
  try {
    req = await request.json();
  } catch (e) {
    return jsonResponse({ error: { message: 'Invalid JSON in request body' } }, 400, { 'X-Worker-Trace-ID': traceId });
  }

  const model = resolveModel(req.model || CONFIG.DEFAULT_MODEL);
  if (model.error) return jsonResponse({ error: { message: model.error } }, 400, { 'X-Worker-Trace-ID': traceId });

  const tools = req.tools;
  const toolChoice = req.tool_choice || 'auto';
  const prompt = messagesToPrompt(req.messages || [], tools, toolChoice);
  if (!prompt.trim()) {
    return jsonResponse({ error: { message: 'Empty prompt' } }, 400, { 'X-Worker-Trace-ID': traceId });
  }

  const stream = req.stream === true;
  const cid = `chatcmpl-${crypto.randomUUID().slice(0, 12)}`;

  // Streaming without tools, or tools disabled
  if (stream && (!tools || toolChoice === 'none')) {
    return handleChatStreaming(prompt, model, cid, traceId, startTime, executionCtx);
  }

  // Non-streaming (or streaming with tools - we need full text for tool parsing)
  try {
    const result = await callGeminiWithRetry(prompt, model.mode, model.think, traceId);
    let text = cleanText(result.text);
    let toolCalls = null;

    if (tools && text && toolChoice !== 'none') {
      const parsed = parseToolCalls(text);
      text = parsed.cleanText;
      toolCalls = parsed.toolCalls;
    }

    const msg = { role: 'assistant', content: text || null };
    if (toolCalls && toolCalls.length > 0) msg.tool_calls = toolCalls;
    const finishReason = (toolCalls && toolCalls.length > 0) ? 'tool_calls' : 'stop';

    if (stream) {
      // Stream the complete result as a single chunk (needed for tool parsing)
      const chunk = {
        id: cid, object: 'chat.completion.chunk', created: Math.floor(startTime / 1000),
        model: model.modelName, choices: [{ index: 0, delta: msg, finish_reason: finishReason }],
      };
      const encoder = new TextEncoder();
      const body = new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
          controller.enqueue(encoder.encode('data: [DONE]\n\n'));
          controller.close();
        },
      });
      return new Response(body, {
        status: 200,
        headers: {
          'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache',
          'X-Worker-Trace-ID': traceId, 'Connection': 'keep-alive',
        },
      });
    }

    return jsonResponse({
      id: cid, object: 'chat.completion', created: Math.floor(startTime / 1000),
      model: model.modelName,
      choices: [{ index: 0, message: msg, finish_reason: finishReason }],
      usage: {
        prompt_tokens: Math.ceil(prompt.length / 4),
        completion_tokens: Math.ceil((text || '').length / 4),
        total_tokens: Math.ceil((prompt.length + (text || '').length) / 4),
      },
    }, 200, { 'X-Worker-Trace-ID': traceId });
  } catch (e) {
    console.error(`[${traceId}] Chat failed:`, e);
    return jsonResponse({ error: { message: `upstream error: ${e.message}` } }, 502, { 'X-Worker-Trace-ID': traceId });
  }
}

// ─── Chat Streaming (no tools) ────────────────────────────────────────────────

async function handleChatStreaming(prompt, model, cid, traceId, startTime, executionCtx) {
  const encoder = new TextEncoder();
  const body = new ReadableStream({
    async start(controller) {
      try {
        const stream = await callGeminiStream(prompt, model.mode, model.think, traceId);
        if (!stream) throw new Error('No stream from upstream');
        const reader = stream.getReader();
        let prevText = '';
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const decoded = new TextDecoder().decode(value);
          const parsed = parseGeminiStreamChunk(decoded, prevText);
          prevText = parsed.newFullText;
          for (const delta of parsed.deltas) {
            const chunk = {
              id: cid, object: 'chat.completion.chunk', created: Math.floor(startTime / 1000),
              model: model.modelName, choices: [{ index: 0, delta: { content: delta }, finish_reason: null }],
            };
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
          }
        }
        // End chunk
        const end = {
          id: cid, object: 'chat.completion.chunk', created: Math.floor(startTime / 1000),
          model: model.modelName, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        };
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(end)}\n\n`));
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();
      } catch (e) {
        console.error(`[${traceId}] Stream error:`, e);
        const errChunk = {
          id: cid, object: 'chat.completion.chunk', created: Math.floor(startTime / 1000),
          model: model.modelName, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          error: { message: `upstream error: ${e.message}` },
        };
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(errChunk)}\n\n`));
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();
      }
    },
    cancel() {
      console.log(`[${traceId}] Client cancelled stream`);
    },
  });
  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache',
      'X-Worker-Trace-ID': traceId, 'Connection': 'keep-alive',
    },
  });
}

// ─── POST /v1/responses (OpenAI Codex CLI) ────────────────────────────────────

async function handleResponses(request, traceId, executionCtx) {
  let req;
  try {
    req = await request.json();
  } catch (e) {
    return jsonResponse({ error: { message: 'Invalid JSON in request body' } }, 400, { 'X-Worker-Trace-ID': traceId });
  }

  const model = resolveModel(req.model || CONFIG.DEFAULT_MODEL);
  if (model.error) return jsonResponse({ error: { message: model.error } }, 400, { 'X-Worker-Trace-ID': traceId });

  // Convert Responses API input to messages
  const inputItems = req.input || [];
  const tools = req.tools;
  const messages = [];

  if (req.instructions) {
    messages.push({ role: 'system', content: req.instructions });
  }

  if (typeof inputItems === 'string') {
    messages.push({ role: 'user', content: inputItems });
  } else if (Array.isArray(inputItems)) {
    for (const item of inputItems) {
      if (typeof item === 'string') {
        messages.push({ role: 'user', content: item });
      } else if (typeof item === 'object' && item !== null) {
        if (item.type === 'function_call_output') {
          messages.push({
            role: 'tool',
            tool_call_id: item.call_id || '',
            name: item.name || '',
            content: item.output || '',
          });
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
              id: tc.call_id || `call_${i}`,
              type: 'function',
              function: { name: tc.name || '', arguments: tc.arguments || '{}' },
            }));
          }
          messages.push(m);
        } else {
          const role = item.role || 'user';
          let content = item.content || '';
          if (Array.isArray(content)) {
            content = content
              .filter(c => c.type === 'text' || c.type === 'input_text')
              .map(c => c.text || '')
              .join(' ');
          }
          messages.push({ role, content });
        }
      }
    }
  }

  // Normalize tools format
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
  if (!prompt.trim()) {
    return jsonResponse({ error: { message: 'empty input' } }, 400, { 'X-Worker-Trace-ID': traceId });
  }

  try {
    const result = await callGeminiWithRetry(prompt, model.mode, model.think, traceId);
    let text = cleanText(result.text);
    let toolCalls = null;

    if (normalizedTools && text && toolChoice !== 'none') {
      const parsed = parseToolCalls(text);
      text = parsed.cleanText;
      toolCalls = parsed.toolCalls;
    }

    const rid = `resp_${crypto.randomUUID().slice(0, 16)}`;
    const mid = `msg_${crypto.randomUUID().slice(0, 12)}`;
    const output = [];

    if (toolCalls && toolCalls.length > 0) {
      for (const tc of toolCalls) {
        output.push({
          type: 'function_call', id: tc.id, call_id: tc.id,
          name: tc.function.name, arguments: tc.function.arguments, status: 'completed',
        });
      }
    }
    if (text || !toolCalls || toolCalls.length === 0) {
      output.push({
        type: 'message', id: mid, role: 'assistant', status: 'completed',
        content: [{ type: 'output_text', text: text || '', annotations: [] }],
      });
    }

    if (req.stream) {
      const encoder = new TextEncoder();
      const body = new ReadableStream({
        start(controller) {
          // response.created
          const created = {
            type: 'response.created',
            response: { id: rid, object: 'response', status: 'in_progress', model: model.modelName, output: [] },
          };
          controller.enqueue(encoder.encode(`event: response.created\ndata: ${JSON.stringify(created)}\n\n`));

          for (const item of output) {
            if (item.type === 'function_call') {
              const ev = {
                type: 'response.function_call_arguments.done',
                item_id: item.id, call_id: item.call_id,
                name: item.name, arguments: item.arguments,
              };
              controller.enqueue(encoder.encode(`event: response.function_call_arguments.done\ndata: ${JSON.stringify(ev)}\n\n`));
            } else if (item.type === 'message') {
              for (let ci = 0; ci < item.content.length; ci++) {
                const ev = {
                  type: 'response.output_text.done',
                  item_id: item.id, content_index: ci, text: item.content[ci].text,
                };
                controller.enqueue(encoder.encode(`event: response.output_text.done\ndata: ${JSON.stringify(ev)}\n\n`));
              }
            }
          }

          // response.completed
          const respObj = {
            id: rid, object: 'response', status: 'completed', model: model.modelName, output,
            usage: {
              input_tokens: Math.ceil(prompt.length / 4),
              output_tokens: Math.ceil((text || '').length / 4),
              total_tokens: Math.ceil((prompt.length + (text || '').length) / 4),
            },
          };
          controller.enqueue(encoder.encode(`event: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', response: respObj })}\n\n`));
          controller.close();
        },
      });
      return new Response(body, {
        status: 200,
        headers: {
          'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache',
          'Access-Control-Allow-Origin': '*', 'X-Worker-Trace-ID': traceId,
        },
      });
    }

    return jsonResponse({
      id: rid, object: 'response', created_at: Math.floor(Date.now() / 1000),
      status: 'completed', model: model.modelName, output,
      usage: {
        input_tokens: Math.ceil(prompt.length / 4),
        output_tokens: Math.ceil((text || '').length / 4),
        total_tokens: Math.ceil((prompt.length + (text || '').length) / 4),
      },
    }, 200, { 'X-Worker-Trace-ID': traceId });
  } catch (e) {
    console.error(`[${traceId}] Responses failed:`, e);
    return jsonResponse({ error: { message: `upstream error: ${e.message}` } }, 502, { 'X-Worker-Trace-ID': traceId });
  }
}

// ─── POST /v1beta/models/:model:generateContent / :streamGenerateContent ──────

async function handleGoogleGenerate(request, pathname, traceId, stream) {
  let req;
  try {
    req = await request.json();
  } catch (e) {
    return jsonResponse({ error: { message: 'Invalid JSON in request body' } }, 400, { 'X-Worker-Trace-ID': traceId });
  }

  // Extract model name from path
  const m = pathname.match(/\/v1beta\/models\/([^:?]+)/);
  const modelName = m ? m[1] : CONFIG.DEFAULT_MODEL;
  const model = resolveModel(modelName);
  if (model.error) return jsonResponse({ error: { message: model.error } }, 400, { 'X-Worker-Trace-ID': traceId });

  const toolConfig = req.toolConfig || {};
  const fcMode = toolConfig.functionCallingConfig?.mode || 'AUTO';
  const hasTools = !!(req.tools) && fcMode !== 'NONE';
  const prompt = googleContentsToPrompt(req);
  if (!prompt.trim()) {
    return jsonResponse({ error: { message: 'empty content' } }, 400, { 'X-Worker-Trace-ID': traceId });
  }

  // Streaming without tools
  if (stream && !hasTools) {
    const encoder = new TextEncoder();
    const body = new ReadableStream({
      async start(controller) {
        try {
          const streamBody = await callGeminiStream(prompt, model.mode, model.think, traceId);
          if (!streamBody) throw new Error('No stream from upstream');
          const reader = streamBody.getReader();
          let fullText = '';
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            const decoded = new TextDecoder().decode(value);
            const parsed = parseGeminiStreamChunk(decoded, fullText);
            fullText = parsed.newFullText;
            for (const delta of parsed.deltas) {
              const chunkObj = {
                candidates: [{ content: { parts: [{ text: delta }], role: 'model' }, index: 0 }],
                modelVersion: model.modelName,
              };
              controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunkObj)}\n\n`));
            }
          }
          const finalChunk = {
            candidates: [{ finishReason: 'STOP', index: 0 }],
            usageMetadata: {
              promptTokenCount: Math.ceil(prompt.length / 4),
              candidatesTokenCount: Math.ceil(fullText.length / 4),
              totalTokenCount: Math.ceil((prompt.length + fullText.length) / 4),
            },
            modelVersion: model.modelName,
          };
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(finalChunk)}\n\n`));
          controller.close();
        } catch (e) {
          console.error(`[${traceId}] Google stream error:`, e);
          controller.close();
        }
      },
    });
    return new Response(body, {
      status: 200,
      headers: {
        'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache',
        'Access-Control-Allow-Origin': '*', 'X-Worker-Trace-ID': traceId,
      },
    });
  }

  // Non-streaming (or streaming with tools)
  try {
    const result = await callGeminiWithRetry(prompt, model.mode, model.think, traceId);
    let text = cleanText(result.text);
    if (!text) text = '';

    const responseParts = [];
    if (hasTools && text) {
      const parsed = parseGoogleFunctionCalls(text);
      if (parsed.functionCalls.length > 0) {
        if (parsed.cleanText) responseParts.push({ text: parsed.cleanText });
        for (const fc of parsed.functionCalls) {
          responseParts.push({ functionCall: { name: fc.name, args: fc.args } });
        }
      } else {
        responseParts.push({ text });
      }
    } else {
      responseParts.push({ text: text || 'I apologize, but I was unable to generate a response. Please try again.' });
    }

    const candidate = {
      content: { parts: responseParts, role: 'model' },
      finishReason: 'STOP', index: 0,
    };
    const usage = {
      promptTokenCount: Math.ceil(prompt.length / 4),
      candidatesTokenCount: Math.ceil((text || '').length / 4),
      totalTokenCount: Math.ceil((prompt.length + (text || '').length) / 4),
    };
    const responseObj = { candidates: [candidate], usageMetadata: usage, modelVersion: model.modelName };

    if (stream) {
      const encoder = new TextEncoder();
      const body = new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(responseObj)}\n\n`));
          controller.close();
        },
      });
      return new Response(body, {
        status: 200,
        headers: {
          'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache',
          'Access-Control-Allow-Origin': '*', 'X-Worker-Trace-ID': traceId,
        },
      });
    }

    return jsonResponse(responseObj, 200, { 'X-Worker-Trace-ID': traceId });
  } catch (e) {
    console.error(`[${traceId}] Google generate failed:`, e);
    return jsonResponse({ error: { message: `upstream error: ${e.message}` } }, 502, { 'X-Worker-Trace-ID': traceId });
  }
}

// ─── Developer Dashboard ──────────────────────────────────────────────────────

async function serveDeveloperDashboard(request, traceId) {
  const html = generateDashboardHTML();
  return new Response(html, {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'X-Worker-Trace-ID': traceId,
      'Cache-Control': 'no-cache, no-store, must-revalidate',
    },
  });
}

function generateDashboardHTML() {
  const modelOptions = Object.entries(MODELS).map(([name, cfg]) =>
    `<option value="${name}">${name} - ${cfg.desc_zh || cfg.desc}</option>`
  ).join('\n');

  const modelCards = Object.entries(MODELS).map(([name, cfg]) => `
    <div class="bg-gray-800 p-4 rounded border border-gray-700">
      <h3 class="text-amber-400 font-semibold mb-1">${name}</h3>
      <p class="text-gray-400 text-sm">${cfg.desc_zh || cfg.desc}</p>
    </div>
  `).join('\n');

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${CONFIG.PROJECT_NAME} - 开发者驾驶舱</title>
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: 'Mono', 'SF Mono', 'Cascadia Code', 'Consolas', monospace; background: #121212; color: #e0e0e0; line-height: 1.6; overflow-x: hidden; }
    .container { max-width: 1200px; margin: 0 auto; padding: 1rem; }
    header { background: #1e1e1e; border-bottom: 1px solid #333; padding: 1rem 0; }
    .header-inner { display: flex; justify-content: space-between; align-items: center; max-width: 1200px; margin: 0 auto; padding: 0 1rem; }
    .logo { font-size: 1.5rem; font-weight: bold; color: #ffbf00; }
    .status-dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 6px; }
    .healthy { background: #10b981; }
    .unhealthy { background: #ef4444; }
    .checking { background: #f59e0b; animation: pulse 1.5s infinite; }
    @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.5; } }
    .card { background: #1e1e1e; border: 1px solid #333; border-radius: 8px; padding: 1.5rem; margin-bottom: 1rem; }
    .card h2 { color: #ffbf00; font-size: 1.1rem; margin-bottom: 0.75rem; }
    .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 1rem; }
    input, select, textarea, button { font-family: inherit; font-size: 0.9rem; }
    input, select, textarea { background: #222; border: 1px solid #444; color: #ccc; padding: 0.5rem; border-radius: 4px; width: 100%; }
    button { background: #ffbf00; color: #000; border: none; padding: 0.5rem 1rem; border-radius: 4px; cursor: pointer; font-weight: 600; }
    button:hover { background: #e6ac00; }
    button:disabled { opacity: 0.5; cursor: not-allowed; }
    .terminal { background: #0a0a0a; border: 1px solid #333; border-radius: 8px; padding: 1rem; min-height: 300px; max-height: 500px; overflow-y: auto; font-size: 0.85rem; white-space: pre-wrap; word-break: break-all; }
    .terminal::-webkit-scrollbar { width: 6px; }
    .terminal::-webkit-scrollbar-thumb { background: #555; border-radius: 3px; }
    .user-msg { color: #10b981; }
    .assistant-msg { color: #e0e0e0; }
    .error-msg { color: #ef4444; }
    .info { color: #aaa; font-size: 0.8rem; margin-top: 0.5rem; }
    footer { text-align: center; padding: 2rem 0; color: #666; font-size: 0.8rem; }
    a { color: #ffbf00; text-decoration: none; }
    a:hover { text-decoration: underline; }
    .input-row { display: flex; gap: 0.5rem; margin-bottom: 0.5rem; }
    .input-row select { width: auto; min-width: 200px; }
    .input-row input { flex: 1; }
  </style>
</head>
<body>
  <header>
    <div class="header-inner">
      <div class="logo"><i class="fas fa-rocket"></i> ${CONFIG.PROJECT_NAME} <span style="font-size:0.8rem;color:#aaa">v${CONFIG.PROJECT_VERSION}</span></div>
      <div><span class="status-dot checking" id="health-dot"></span><span id="health-text" style="font-size:0.85rem">检查中...</span></div>
    </div>
  </header>

  <div class="container">
    <div class="grid">
      <div class="card">
        <h2><i class="fas fa-key"></i> API 配置</h2>
        <label style="display:block;margin-bottom:0.5rem;color:#aaa;font-size:0.85rem">API 密钥</label>
        <div class="input-row">
          <input type="password" id="api-key" placeholder="输入您的 API 密钥">
          <button onclick="toggleKeyVisibility()" style="width:auto"><i class="fas fa-eye"></i></button>
          <button onclick="saveKey()" style="width:auto"><i class="fas fa-save"></i></button>
        </div>
        <div class="info">API Base URL: <code id="api-url">${CONFIG.PROJECT_NAME}</code></div>
      </div>

      <div class="card">
        <h2><i class="fas fa-list"></i> 可用模型</h2>
        <div class="grid" style="gap:0.5rem">
          ${modelCards}
        </div>
      </div>
    </div>

    <div class="card">
      <h2><i class="fas fa-terminal"></i> 实时交互终端</h2>
      <div class="input-row">
        <select id="model-select">${modelOptions}</select>
        <input type="text" id="prompt-input" placeholder="输入您的问题..." onkeydown="if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();sendRequest();}">
        <button id="send-btn" onclick="sendRequest()"><i class="fas fa-paper-plane"></i> 发送</button>
      </div>
      <div class="terminal" id="output-area"></div>
    </div>
  </div>

  <footer>
    <p>${CONFIG.PROJECT_NAME} v${CONFIG.PROJECT_VERSION} | <a href="https://github.com" target="_blank">GitHub</a></p>
    <p class="info" style="margin-top:0.5rem">注意: 此服务依赖于第三方公开接口，请合理使用。</p>
  </footer>

  <script>
    const API_BASE = window.location.origin + '/v1';
    document.getElementById('api-url').textContent = API_BASE;

    // Load saved key
    const savedKey = localStorage.getItem('gemini_api_key');
    if (savedKey) document.getElementById('api-key').value = savedKey;

    function getApiKey() {
      return document.getElementById('api-key').value.trim() || 'sk-default';
    }

    function toggleKeyVisibility() {
      const inp = document.getElementById('api-key');
      inp.type = inp.type === 'password' ? 'text' : 'password';
    }

    function saveKey() {
      localStorage.setItem('gemini_api_key', getApiKey());
    }

    function addOutput(text, cls = '') {
      const area = document.getElementById('output-area');
      area.innerHTML += '<div class="' + cls + '">' + text + '</div>';
      area.scrollTop = area.scrollHeight;
    }

    async function sendRequest() {
      const prompt = document.getElementById('prompt-input').value.trim();
      if (!prompt) return;
      const model = document.getElementById('model-select').value;
      document.getElementById('prompt-input').value = '';
      addOutput('您: ' + prompt, 'user-msg');

      const sendBtn = document.getElementById('send-btn');
      sendBtn.disabled = true;
      sendBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> 处理中...';

      try {
        const resp = await fetch(API_BASE + '/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer ' + getApiKey(),
          },
          body: JSON.stringify({
            model: model,
            messages: [{ role: 'user', content: prompt }],
            stream: true,
          }),
        });

        if (!resp.ok) {
          const err = await resp.json().catch(() => ({ error: { message: resp.statusText } }));
          addOutput('错误: ' + (err.error?.message || JSON.stringify(err)), 'error-msg');
          return;
        }

        const reader = resp.body.getReader();
        const decoder = new TextDecoder();
        let assistantText = '';
        addOutput('', 'assistant-msg');
        const msgElements = document.getElementById('output-area').getElementsByClassName('assistant-msg');
        const lastMsg = msgElements[msgElements.length - 1];

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const text = decoder.decode(value);
          for (const line of text.split('\\n')) {
            if (!line.startsWith('data: ') || line === 'data: [DONE]') continue;
            try {
              const data = JSON.parse(line.slice(6));
              const delta = data.choices?.[0]?.delta?.content || '';
              if (delta) {
                assistantText += delta;
                lastMsg.textContent = 'AI: ' + assistantText;
              }
            } catch (e) {}
          }
        }
        if (!assistantText) lastMsg.textContent = 'AI: (无响应)';
      } catch (e) {
        addOutput('网络错误: ' + e.message, 'error-msg');
      } finally {
        sendBtn.disabled = false;
        sendBtn.innerHTML = '<i class="fas fa-paper-plane"></i> 发送';
      }
    }

    // Health check
    async function checkHealth() {
      const dot = document.getElementById('health-dot');
      const text = document.getElementById('health-text');
      dot.className = 'status-dot checking';
      text.textContent = '检查中...';
      try {
        const resp = await fetch(API_BASE + '/models', { headers: { 'Authorization': 'Bearer ' + getApiKey() } });
        dot.className = 'status-dot ' + (resp.ok ? 'healthy' : 'unhealthy');
        text.textContent = resp.ok ? '上游正常' : '上游异常 (' + resp.status + ')';
      } catch (e) {
        dot.className = 'status-dot unhealthy';
        text.textContent = '网络错误';
      }
    }
    checkHealth();
    setInterval(checkHealth, 30000);
  </script>
</body>
</html>`;
}

// ─── Main Fetch Handler ───────────────────────────────────────────────────────

export default {
  async fetch(request, env, ctx) {
    loadConfigFromEnv(env);
    const url = new URL(request.url);
    const pathname = url.pathname;
    const traceId = crypto.randomUUID();
    const traceHeaders = { 'X-Worker-Trace-ID': traceId };

    if (CONFIG.LOG_REQUESTS) {
      console.log(`[${new Date().toISOString()}] [${traceId}] ${request.method} ${pathname} |auth:${request.headers.get('Authorization') ? 'yes' : 'no'}|`);
    }

    try {
      // Dashboard
      if (pathname === '/' && request.method === 'GET') {
        return serveDeveloperDashboard(request, traceId);
      }

      // API routes
      if (pathname.startsWith('/v1/') || pathname.startsWith('/v1beta/')) {
        return handleApiRequest(request, pathname, traceId, ctx, env);
      }

      // Not found
      return jsonResponse({ error: { message: 'Not found', code: 404 } }, 404, traceHeaders);
    } catch (e) {
      console.error(`[${traceId}] Unhandled error:`, e);
      return jsonResponse({ error: { message: 'Internal Server Error', details: e.message } }, 500, traceHeaders);
    }
  },
};
