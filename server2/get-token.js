'use strict';

const crypto = require('node:crypto');

const DEFAULT_HOST = process.env.CC_API_HOST || 'https://x.16x.tech';

function requireCredential(value, envName, label) {
  const resolved = String(value || process.env[envName] || '').trim();
  if (!resolved) {
    throw new Error(`请填写 ${label}，或设置环境变量 ${envName}`);
  }
  return resolved;
}

function parseServer(input) {
  let raw = String(input || DEFAULT_HOST).trim();
  let protocol = 'http';
  if (/^https:\/\//i.test(raw)) {
    protocol = 'https';
    raw = raw.replace(/^https:\/\//i, '');
  } else if (/^http:\/\//i.test(raw)) {
    raw = raw.replace(/^http:\/\//i, '');
  }
  raw = raw.replace(/\/+$/, '');
  return { host: raw || DEFAULT_HOST, protocol };
}

function hostnameOf(serverHost) {
  const h = String(serverHost || '').split('/')[0];
  if (h.startsWith('[')) {
    const end = h.indexOf(']');
    return end > 0 ? h.slice(1, end).toLowerCase() : h.toLowerCase();
  }
  return h.split(':')[0].toLowerCase();
}

function isBlockedApiHost(hostname) {
  const h = String(hostname || '').toLowerCase();
  if (!h) return true;
  if (h === '169.254.169.254' || h.startsWith('169.254.')) return true;
  if (h === 'metadata.google.internal') return true;
  if (h === '0.0.0.0' || h === '::') return true;
  return false;
}

function assertAllowedTokenHost(host) {
  const server = parseServer(host);
  if (isBlockedApiHost(hostnameOf(server.host))) {
    throw new Error('API host not allowed');
  }
  return server;
}

function md5(value) {
  return crypto.createHash('md5').update(value, 'utf8').digest('hex');
}

function hmacSha256(value, appSecret) {
  return crypto.createHmac('sha256', appSecret).update(value, 'utf8').digest('hex');
}

function createAuthentication(content, appKey, appSecret, now = Date.now()) {
  if (!appKey) {
    throw new Error('请填写 API KEY，或设置环境变量 CC_API_APP_KEY');
  }
  if (!appSecret) {
    throw new Error('请填写 API SECRET，或设置环境变量 CC_API_APP_SECRET');
  }

  const timestamp = String(now);
  const nonce = crypto.randomBytes(8).toString('hex');
  const contentDigest = md5(content);
  const signature = hmacSha256(`${appKey}${contentDigest}${nonce}${timestamp}`, appSecret);

  return {
    'X-Ca-Key': appKey,
    'X-Ca-Timestamp': timestamp,
    'X-Ca-Nonce': nonce,
    'X-Ca-Signature': signature,
  };
}

async function getToken({ extension, host = DEFAULT_HOST, appKey, appSecret } = {}) {
  const resolvedKey = requireCredential(appKey, 'CC_API_APP_KEY', 'API KEY');
  const resolvedSecret = requireCredential(appSecret, 'CC_API_APP_SECRET', 'API SECRET');
  const server = assertAllowedTokenHost(host);

  // openapi 契约(internal/model/dto/token)：/openapi/v1/token/fs，body { extension }
  if (!extension) {
    throw new Error('分机号 extension 不能为空');
  }
  const body = JSON.stringify({ extension: String(extension).trim() });
  const API_URL = `${server.protocol}://${server.host}/openapi/v1/token/fs`;
  const authentication = createAuthentication(body, resolvedKey, resolvedSecret);
  const timeoutMs = 20_000;
  let response;
  try {
    response = await fetch(API_URL, {
      method: 'POST',
      headers: {
        ...authentication,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    if (error && (error.name === 'TimeoutError' || /aborted due to timeout/i.test(error.message))) {
      throw new Error('获取 token 超时：连不上 ' + API_URL + '（' + (timeoutMs / 1000) + ' 秒）。请确认该地址和 8003 端口可达');
    }
    throw new Error('获取 token 失败：无法请求 ' + API_URL + '（' + ((error && error.message) || '网络错误') + '）');
  }
  const responseText = await response.text();
  let result;

  try {
    result = JSON.parse(responseText);
  } catch {
    throw new Error(`接口返回了非 JSON 响应（HTTP ${response.status}）：${responseText}`);
  }
  

  if (!response.ok || result.code !== 0) {
    const traceId = result.traceID ? `，traceID：${result.traceID}` : '';
    throw new Error(`获取 token 失败（HTTP ${response.status}）：${result.message || responseText}${traceId}`);
  }

  return result;
}

async function main() {
  const result = await getToken({
    extension: process.env.CC_EXTENSION,
    host: process.env.CC_API_HOST,
    appKey: process.env.CC_API_APP_KEY,
    appSecret: process.env.CC_API_APP_SECRET,
  });
  console.log(JSON.stringify(result, null, 2));
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = {
  createAuthentication,
  getToken,
  md5,
  hmacSha256,
  parseServer,
  isBlockedApiHost,
  assertAllowedTokenHost,
};
