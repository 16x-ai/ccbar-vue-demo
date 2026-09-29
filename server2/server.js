'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { getToken } = require('./get-token');

const BIND = process.env.CCBAR_BIND || '127.0.0.1';
const DEMO = process.env.CCBAR_DEMO === '1';
const MAX_BODY = 64 * 1024;
const ROOT = __dirname;
const ROOT_PREFIX = ROOT.endsWith(path.sep) ? ROOT : ROOT + path.sep;
let listenPort = Number(process.env.PORT) || 3000;

function parseDotEnv(text) {
  const out = {};
  String(text || '').split(/\r?\n/).forEach((line) => {
    const t = line.trim();
    if (!t || t.startsWith('#')) return;
    const i = t.indexOf('=');
    if (i <= 0) return;
    const key = t.slice(0, i).trim();
    let val = t.slice(i + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (key) out[key] = val;
  });
  return out;
}

function loadDotEnvFile(filePath) {
  let text;
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch {
    return;
  }
  const parsed = parseDotEnv(text);
  Object.keys(parsed).forEach((key) => {
    if (process.env[key] == null || process.env[key] === '') {
      process.env[key] = parsed[key];
    }
  });
}

loadDotEnvFile(path.join(ROOT, '.env'));
loadDotEnvFile(path.join(ROOT, '.env.example'));

function demoDefaults() {
  return {
    host: String(process.env.CC_API_HOST || '').trim(),
    sipWs: String(process.env.CC_SIP_WS || process.env.CC_SIP_WSS || '').trim(),
  };
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function corsHeaders(req) {
  const origin = (req && req.headers && req.headers.origin) || '';
  // 同源(nginx 反代)场景不依赖 CORS; file:// 或跨源本地调试时回显 Origin
  return {
    'Access-Control-Allow-Origin': origin || `http://127.0.0.1:${listenPort}`,
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Vary': 'Origin',
  };
}

function sendJson(req, res, status, payload) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    ...corsHeaders(req),
  });
  res.end(JSON.stringify(payload));
}

function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('请求体不是合法 JSON'));
      }
    });
    req.on('error', reject);
  });
}

function serveStatic(req, res) {
  const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  const safePath = urlPath === '/' ? '/index.html' : urlPath;
  const filePath = path.normalize(path.join(ROOT, safePath));

  if (filePath !== ROOT && !filePath.startsWith(ROOT_PREFIX)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(err.code === 'ENOENT' ? 404 : 500);
      res.end(err.code === 'ENOENT' ? 'Not Found' : 'Server Error');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const urlPath = (req.url || '/').split('?')[0];

  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsHeaders(req));
    res.end();
    return;
  }

  if (req.method === 'POST' && (urlPath === '/get-token' || urlPath === '/ccbar/get-token' || urlPath === '/demo/get-token')) {
    if (!DEMO) {
      sendJson(req, res, 403, { code: -1, message: 'get-token disabled; set CCBAR_DEMO=1 for local demo' });
      return;
    }
    try {
      const body = await readBody(req, MAX_BODY);
      // 页面请求体优先, 环境变量仅兜底
      const isPublic = body.isPublic !== false;
      const params = {
        isPublic,
        host: body.host || process.env.CC_API_HOST,
        appKey: body.appKey || process.env.CC_API_APP_KEY,
        appSecret: body.appSecret || process.env.CC_API_APP_SECRET,
      };
      if (isPublic) {
        params.extension = body.extension;
      } else {
        params.userId = body.userId;
        params.departmentId = body.departmentId;
      }
      const result = await getToken(params);
      sendJson(req, res, 200, result);
    } catch (error) {
      sendJson(req, res, 500, { code: -1, message: error.message });
    }
    return;
  }

  if (req.method === 'GET' && (urlPath === '/defaults' || urlPath === '/ccbar/defaults')) {
    sendJson(req, res, 200, { code: 0, data: demoDefaults() });
    return;
  }

  if (req.method === 'GET' || req.method === 'HEAD') {
    serveStatic(req, res);
    return;
  }

  res.writeHead(405);
  res.end('Method Not Allowed');
});

function preferredPort(startPort) {
  const n = Number(startPort);
  if (Number.isFinite(n) && n > 0) return Math.floor(n);
  const fromEnv = Number(process.env.PORT);
  if (Number.isFinite(fromEnv) && fromEnv > 0) return Math.floor(fromEnv);
  return 3000;
}

function startServer(httpServer, bind, port, { fallback = true } = {}) {
  const preferred = preferredPort(port);
  const last = fallback ? preferred + 19 : preferred;
  return new Promise((resolve, reject) => {
    let current = preferred;
    const attempt = () => {
      const onError = (err) => {
        httpServer.off('listening', onListening);
        if (err && err.code === 'EADDRINUSE' && current < last) {
          console.warn(`端口 ${current} 已被占用，改用 ${current + 1}`);
          current += 1;
          attempt();
          return;
        }
        if (err && err.code === 'EADDRINUSE') {
          reject(new Error(
            `端口 ${preferred} 已被占用。请关掉占用该端口的进程，或执行 PORT=${preferred + 1} npm run dev`
          ));
          return;
        }
        reject(err);
      };
      const onListening = () => {
        httpServer.off('error', onError);
        listenPort = current;
        console.log(`本地服务已启动: http://${bind}:${current}`);
        resolve({ port: current, url: `http://${bind}:${current}` });
      };
      httpServer.once('error', onError);
      httpServer.once('listening', onListening);
      httpServer.listen(current, bind);
    };
    attempt();
  });
}

function listen(startPort) {
  const preferred = preferredPort(startPort);
  const pinned = startPort == null && String(process.env.PORT || '').trim() !== '';
  startServer(server, BIND, preferred, { fallback: !pinned }).catch((err) => {
    console.error(err.message || err);
    process.exit(1);
  });
  return server;
}

if (require.main === module) {
  listen();
}

module.exports = { server, BIND, DEMO, listen, startServer, preferredPort, parseDotEnv, loadDotEnvFile, demoDefaults };
