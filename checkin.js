#!/usr/bin/env node
/**
 * 每日签到助手 —— WorkBuddy + Trae(SOLO/CN) 双平台
 *
 * 设计目标：凭证过期能自动续期，单日多次重试，任何异常都不静默失败。
 *
 * 自愈分层：
 *   L1 用当前有效凭证直接签到
 *   L2 accessToken 快过期/已过期 → 自动用 refreshToken 换新（Trae 已实测打通）
 *   L3 刷新出的新凭证回写各平台自己的登录态文件，避免客户端掉登录
 *   L4 网络抖动 / 服务器限流 → 指数退避重试
 *   L5 无法自动恢复 → 落 NEED_ACTION.txt + 可选 webhook 通知 + 退出码 2
 *   L6 登录态文件路径变了 → 自动扫描候选路径重新发现
 *
 * 零第三方依赖，只用 Node 内置模块。
 * 用法：
 *   node checkin.js                 签到
 *   node checkin.js --status        只查询，不领取
 *   node checkin.js --self-test     离线自检（路径/加解密/有效期，不发网络请求）
 *   node checkin.js --verbose       输出调试细节（仍不打印 token）
 *   node checkin.js --no-writeback  不把新凭证回写各平台登录态文件
 */

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const https = require('https');
const { spawn } = require('child_process');

const APP_DIR = __dirname;
const LOG_DIR = path.join(APP_DIR, 'logs');
const STATE_FILE = path.join(APP_DIR, 'state.json');
const CONFIG_FILE = path.join(APP_DIR, 'config.json');
const NEED_ACTION_FILE = path.join(APP_DIR, 'NEED_ACTION.txt');

const ARGS = new Set(process.argv.slice(2));
const STATUS_ONLY = ARGS.has('--status');
const VERBOSE = ARGS.has('--verbose');
const SELF_TEST = ARGS.has('--self-test');
const NO_WRITEBACK = ARGS.has('--no-writeback');
const NOTIFY_TEST = ARGS.has('--notify-test');
const SIMULATE_FAIL = ARGS.has('--simulate-failure');
const DIAGNOSE = ARGS.has('--diagnose');

/* ==================================================================
 * 配置
 * ================================================================== */

const DEFAULT_CONFIG = {
  _说明: '接口地址与开关都可改。改完直接生效，无需动代码。',
  endpoints: {
    workbuddyCheckin: 'https://copilot.tencent.com/v2/billing/meter/daily-checkin',
    workbuddyRefresh: 'https://copilot.tencent.com/v2/auth/token/refresh',
    traeStatus: 'https://api.trae.cn/trae/api/v2/ug/checkin_credits/status',
    traeClaim: 'https://api.trae.cn/trae/api/v2/ug/checkin_credits/claim',
    traeExchange: 'https://api.trae.com.cn/cloudide/api/v3/trae/oauth/ExchangeToken',
  },
  trae: {
    products: ['TRAE SOLO CN', 'Trae CN', 'TRAE SOLO', 'Trae Solo CN', 'Trae', 'TRAE'],
    clientId: 'en1oxy7wnw8j9n',
    refreshAheadMinutes: 60,
    writeBack: true,
  },
  workbuddy: {
    tokenFiles: [
      '%LOCALAPPDATA%/CodeBuddyExtension/Data/Public/Auth/workbuddy-desktop.info',
      '%LOCALAPPDATA%/WorkBuddyExtension/Data/Public/Auth/workbuddy-desktop.info',
      '%LOCALAPPDATA%/WorkBuddy/Data/Public/Auth/workbuddy-desktop.info',
      '%APPDATA%/WorkBuddy/Data/Public/Auth/workbuddy-desktop.info',
      '%APPDATA%/CodeBuddy/Data/Public/Auth/workbuddy-desktop.info',
    ],
    appExe: 'E:/workbuddy/WorkBuddy.exe',
    refreshAheadMinutes: 60,
    // 公开域名下 /v2/auth/token/refresh 目前返回 404（该路由在专有网关上）。
    // 若日后拿到正确域名，改 workbuddyRefresh 后把这里置 true 即可自动续期。
    tryRefreshEndpoint: false,
    // 凭证过期时拉起一次 WorkBuddy 客户端 —— 客户端启动会自动刷新登录态文件，
    // 这是目前唯一 100% 可用的 WorkBuddy 自动续期手段。
    launchAppOnExpiry: true,
    launchWaitSeconds: 75,
  },
  retry: {
    network: 3,
    networkDelayMs: 2500,
    traeBusy: 3,
    traeBusyDelayMs: [15000, 25000],
  },
  notify: {
    type: 'none', // none | pushplus | serverchan | wecom | feishu | bark
    url: '',
    token: '',
    onSuccess: false,
    onFailure: true,
  },
};

function deepMerge(base, over) {
  const out = Object.assign({}, base);
  for (const [k, v] of Object.entries(over || {})) {
    if (v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object' && !Array.isArray(base[k])) {
      out[k] = deepMerge(base[k], v);
    } else if (v !== undefined) {
      out[k] = v;
    }
  }
  return out;
}

function loadConfig() {
  let user = {};
  if (fs.existsSync(CONFIG_FILE)) {
    try {
      user = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    } catch (e) {
      console.error(`配置文件 config.json 解析失败，改用默认配置：${e.message}`);
    }
  } else {
    try {
      fs.writeFileSync(CONFIG_FILE, JSON.stringify(DEFAULT_CONFIG, null, 2), 'utf8');
    } catch (e) {
      /* 只读目录时忽略 */
    }
  }
  return deepMerge(DEFAULT_CONFIG, user);
}

const CFG = loadConfig();

/* ==================================================================
 * 通用工具
 * ================================================================== */

function ts() {
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/**
 * 本地日期 YYYY-MM-DD。
 * 切勿用 toISOString() 取日期 —— 那是 UTC，北京时间早上 8 点前会算成前一天，
 * 导致 07:30 那班的日志被写进昨天那个文件里。
 */
function localDate(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

const LOG_BUFFER = [];
let LOG_PATH = '';
function logPath() {
  if (!LOG_PATH) LOG_PATH = path.join(LOG_DIR, `checkin-${localDate()}.log`);
  return LOG_PATH;
}

/**
 * 逐行实时落盘。
 * 为什么不缓冲到结束再一次性写：进程若被强制终止（计划任务超时结束、控制台 CTRL_C、
 * 关机断电等），缓冲区会整批丢失，事后完全看不出跑到了哪一步；逐行写最多丢最后一行。
 */
function log(msg) {
  const line = `[${ts()}] ${msg}`;
  LOG_BUFFER.push(line);
  console.log(msg);
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(logPath(), line + '\n', 'utf8');
  } catch (e) {
    /* 日志写失败不应影响签到主流程 */
  }
}

/** 兼容既有调用点：日志已在 log() 内实时落盘，这里无需再做任何事 */
function flushLog() {}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 展开 %VAR% 与 ~ */
function expand(p) {
  if (!p) return p;
  let s = String(p);
  s = s.replace(/%([^%]+)%/g, (_, name) => process.env[name] || '');
  if (s.startsWith('~/')) s = path.join(process.env.USERPROFILE || process.env.HOME || '', s.slice(2));
  return path.normalize(s);
}

function readJSON(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

/** 原子写：先写临时文件再改名，避免写一半损坏 */
function writeAtomic(file, content) {
  const tmp = file + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, file);
}

function loadState() {
  try {
    return readJSON(STATE_FILE);
  } catch (e) {
    return {};
  }
}
function saveState(s) {
  try {
    writeAtomic(STATE_FILE, JSON.stringify(s, null, 2));
    try {
      fs.chmodSync(STATE_FILE, 0o600);
    } catch (e) {
      /* Windows 上忽略 */
    }
  } catch (e) {
    log(`  ⚠ 状态文件写入失败（不影响本次签到）：${e.message}`);
  }
}

/* ---------------------------------------------------------------
 * HTTP：带退避重试
 * --------------------------------------------------------------- */

function requestOnce(method, url, headers, body, timeoutMs) {
  return new Promise((resolve) => {
    let u;
    try {
      u = new URL(url);
    } catch (e) {
      return resolve({ status: -1, body: 'URL 非法: ' + e.message, retryable: false });
    }
    const req = https.request(
      {
        hostname: u.hostname,
        port: u.port || 443,
        path: u.pathname + u.search,
        method,
        headers: Object.assign(
          {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          },
          headers || {}
        ),
      },
      (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          // 5xx / 429 视为可重试
          const retryable = res.statusCode >= 500 || res.statusCode === 429;
          resolve({ status: res.statusCode, body: data, retryable });
        });
      }
    );
    req.on('error', (e) => resolve({ status: -1, body: '网络错误: ' + e.message, retryable: true }));
    req.setTimeout(timeoutMs || 25000, () => {
      req.destroy();
      resolve({ status: -1, body: '请求超时', retryable: true });
    });
    if (body) req.write(body);
    req.end();
  });
}

async function request(method, url, headers, obj, opts) {
  opts = opts || {};
  const attempts = opts.attempts || CFG.retry.network;
  const delay = opts.delayMs || CFG.retry.networkDelayMs;
  const body = obj === undefined ? '' : JSON.stringify(obj);
  const h = Object.assign(obj === undefined ? {} : { 'Content-Type': 'application/json' }, headers || {});
  let last = null;
  for (let i = 1; i <= attempts; i++) {
    last = await requestOnce(method, url, h, body, opts.timeoutMs);
    let parsed = null;
    try {
      parsed = JSON.parse(last.body);
    } catch (e) {
      /* 非 JSON */
    }
    last.json = parsed;
    if (!last.retryable) return last;
    if (i < attempts) {
      const wait = delay * i;
      if (VERBOSE) log(`    · 第 ${i}/${attempts} 次请求可重试（HTTP ${last.status}），${Math.round(wait / 1000)}s 后重试`);
      await sleep(wait);
    }
  }
  return last;
}

/* ==================================================================
 * Trae 登录态：解密 / 加密 / 读取 / 回写
 * ================================================================== */

const SALT_A = Uint8Array.from([82,9,106,213,48,54,165,56,191,64,163,158,129,243,215,251,124,227,57,130,155,47,255,135,52,142,67,68,196,222,233,203,84,123,148,50,166,194,35,61,238,76,149,11,66,250,195,78,8,46,161,102,40,217,36,178,118,91,162,73,109,139,209,37]);
const SALT_B = Uint8Array.from([31,221,168,51,136,7,199,49,177,18,16,89,39,128,236,95,96,81,127,169,25,181,74,13,45,229,122,159,147,201,156,239,160,224,59,77,174,42,245,176,200,235,187,60,131,83,153,97,23,43,4,126,186,119,214,38,225,105,20,99,85,33,12,125]);
const SALT_C = Uint8Array.from([191,192,216,250,122,246,220,97,31,254,98,27,8,72,71,176,135,99,96,18,127,101,203,104,211,102,191,125,37,72,150,156,51,229,121,35,17,153,141,177,110,131,150,128,172,255,254,6,18,140,55,62,236,249,135,64,135,12,117,4,89,149,168,209]);
const SALT_D = Uint8Array.from([246,204,26,232,232,70,129,109,223,146,169,242,23,241,105,145,50,196,165,42,254,120,3,54,244,207,209,85,53,6,138,106,175,148,31,204,186,186,165,182,87,142,49,10,39,110,26,154,86,56,173,125,18,64,198,225,99,99,83,82,191,134,76,170]);

function xorSalts(a, b) {
  const r = new Uint8Array(64);
  for (let i = 0; i < 64; i++) r[i] = a[i] ^ b[i];
  return r;
}

function deriveKeyIv(randomBytes, isPrivate) {
  const salt = isPrivate ? xorSalts(SALT_C, SALT_D) : xorSalts(SALT_A, SALT_B);
  const h1 = crypto.createHash('sha512').update(Buffer.from(randomBytes)).digest();
  const fh = crypto.createHash('sha512').update(Buffer.concat([h1, Buffer.from(salt)])).digest();
  return { key: fh.subarray(0, 16), iv: fh.subarray(16, 32) };
}

const TRAE_HEADER_AES = Buffer.from([0x74, 0x63, 0x05, 0x10, 0x00, 0x00]);

function decryptTraeValue(b64) {
  const buf = Buffer.from(b64, 'base64');
  const header = buf.subarray(0, 6);
  const randomBytes = buf.subarray(6, 38);
  const encData = buf.subarray(38);
  const isAES =
    header[0] === 0x74 && header[1] === 0x63 && header[2] === 0x05 && header[3] === 0x10 && header[4] === 0 && header[5] === 0;
  const isPrivate = header[0] === 18 && header[1] === 57 && header[2] === 32 && header[3] === 32 && header[4] === 2 && header[5] === 3;
  if (!isAES && !isPrivate) throw new Error('未知的加密类型，Trae 可能已升级格式（header=' + header.toString('hex') + '）');
  const { key, iv } = deriveKeyIv(randomBytes, isPrivate);
  const d = crypto.createDecipheriv('aes-128-cbc', key, iv);
  const out = Buffer.concat([d.update(encData), d.final()]);
  const storedHash = out.subarray(0, 64);
  const plain = out.subarray(64);
  const calc = crypto.createHash('sha512').update(plain).digest();
  if (!storedHash.equals(calc)) throw new Error('解密校验失败，登录态格式可能已变更');
  return plain.toString('utf8');
}

/** 按 AES 类型重新加密（回写用）。写完自带一次自检。 */
function encryptTraeValue(plaintext) {
  const randomBytes = crypto.randomBytes(32);
  const { key, iv } = deriveKeyIv(randomBytes, false);
  const hash = crypto.createHash('sha512').update(Buffer.from(plaintext, 'utf8')).digest();
  const c = crypto.createCipheriv('aes-128-cbc', key, iv);
  const enc = Buffer.concat([c.update(Buffer.concat([hash, Buffer.from(plaintext, 'utf8')])), c.final()]);
  const b64 = Buffer.concat([TRAE_HEADER_AES, randomBytes, enc]).toString('base64');
  if (decryptTraeValue(b64) !== plaintext) throw new Error('回写自检失败，已放弃写入');
  return b64;
}

function findTraeStorage() {
  const appData = process.env.APPDATA || path.join(process.env.USERPROFILE || '', 'AppData', 'Roaming');
  const seen = new Set();
  for (const n of CFG.trae.products) {
    const file = path.join(appData, n, 'User', 'globalStorage', 'storage.json');
    const key = path.resolve(file).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    if (fs.existsSync(file)) return { file, product: n };
  }
  // L6 兜底：扫 %APPDATA% 下任意 *Trae*/User/globalStorage/storage.json
  try {
    for (const name of fs.readdirSync(appData)) {
      if (!/trae/i.test(name)) continue;
      const file = path.join(appData, name, 'User', 'globalStorage', 'storage.json');
      if (fs.existsSync(file)) return { file, product: name };
    }
  } catch (e) {
    /* 忽略 */
  }
  return null;
}

function findTraeDeviceId(storage, storageFile) {
  const key = Object.keys(storage).find((k) => /^iCubeAuthInfo:\/\/icube-dc:\d+/.test(k));
  if (key) {
    const m = key.match(/icube-dc:(\d{6,})/);
    if (m) return m[1];
  }
  try {
    const productDir = path.dirname(path.dirname(path.dirname(storageFile)));
    const logDir = path.join(productDir, 'logs', 'aha_log');
    if (!fs.existsSync(logDir)) return '';
    for (const f of fs.readdirSync(logDir).filter((n) => /aha_electron.*\.log$/.test(n))) {
      const text = fs.readFileSync(path.join(logDir, f), 'latin1');
      const m = text.match(/InitDeviceId[^\r\n]{0,120}?device_id:\s*(\d{6,})/);
      if (m) return m[1];
    }
  } catch (e) {
    /* 忽略 */
  }
  return '';
}

function readTraeAuth() {
  // 与 WorkBuddy 同理：存储文件可能正被客户端原子改写，瞬时读不到时重试几次再判定失败，
  // 避免把一次瞬时抖动误报成"Trae 未安装/未登录"并推送微信通知。
  let found = null;
  for (let i = 0; i < 4; i++) {
    found = findTraeStorage();
    if (found) {
      if (i > 0) log(`  ↩ 第 ${i + 1} 次尝试才读到 Trae 存储文件（瞬时抖动，已自动恢复）`);
      break;
    }
    if (i < 3) sleepSync(400);
  }
  if (!found) throw new Error('未找到 Trae 数据目录（未安装 TRAE SOLO CN / Trae CN，或从未登录）');
  const raw = readJSON(found.file);
  const enc = raw['iCubeAuthInfo://icube.cloudide'];
  if (!enc) throw new Error('storage.json 中缺少 iCubeAuthInfo://icube.cloudide 字段');
  const auth = enc.trim().startsWith('{') ? JSON.parse(enc) : JSON.parse(decryptTraeValue(enc));
  let expiredAt = 0;
  if (typeof auth.expiredAt === 'number') expiredAt = auth.expiredAt > 1e12 ? auth.expiredAt : auth.expiredAt * 1000;
  else if (auth.expiredAt) expiredAt = new Date(auth.expiredAt).getTime();
  return { ...auth, expiredAt, deviceId: findTraeDeviceId(raw, found.file), file: found.file, product: found.product, raw, encrypted: enc };
}

function traeHeaders(auth) {
  const h = {
    Authorization: 'Cloud-IDE-JWT ' + auth.token,
    'X-User-Region': 'CN',
    'User-Agent': 'Trae/0.1.43',
  };
  if (auth.deviceId) h['x-device-id'] = auth.deviceId;
  return h;
}

/** 用 refreshToken 换新 accessToken */
async function traeRefresh(refreshToken) {
  const r = await request('POST', CFG.endpoints.traeExchange, { 'User-Agent': 'Trae/0.1.43' }, {
    ClientID: CFG.trae.clientId,
    RefreshToken: refreshToken,
    ClientSecret: '-',
    UserID: '',
  });
  const res = r.json && r.json.Result;
  if (!res || !res.Token) {
    throw new Error(`refreshToken 失效或刷新被拒（HTTP ${r.status}）`);
  }
  let exp = res.TokenExpireAt || 0;
  if (exp > 1e12) exp = Math.floor(exp / 1000);
  if (!exp && res.TokenExpireDuration) exp = Math.floor(Date.now() / 1000) + res.TokenExpireDuration;
  return {
    token: res.Token,
    refreshToken: res.RefreshToken || refreshToken,
    expiredAt: exp ? exp * 1000 : Date.now() + 6 * 3600 * 1000,
  };
}

/** 把刷新后的凭证回写 storage.json（原子写 + 首写备份 + 保留其它所有键） */
function writeBackTrae(prev, fresh) {
  try {
    const bak = prev.file + '.checkin-bak';
    if (!fs.existsSync(bak)) {
      fs.copyFileSync(prev.file, bak); // 只备份第一次，保留最原始的登录态
    }
    const obj = JSON.parse(prev.encrypted.trim().startsWith('{') ? prev.encrypted : decryptTraeValue(prev.encrypted));
    obj.token = fresh.token;
    if (fresh.refreshToken) obj.refreshToken = fresh.refreshToken;
    obj.expiredAt = new Date(fresh.expiredAt).toISOString();
    const re = encryptTraeValue(JSON.stringify(obj));
    prev.raw['iCubeAuthInfo://icube.cloudide'] = re;
    writeAtomic(prev.file, JSON.stringify(prev.raw, null, '\t'));
    log('  💾 新凭证已回写 Trae 登录态文件（客户端不会掉登录）');
    return true;
  } catch (e) {
    log(`  ⚠ 回写 Trae 登录态失败（不影响本次签到，客户端下次启动会自行刷新）：${e.message}`);
    return false;
  }
}

/* ==================================================================
 * WorkBuddy 登录态
 * ================================================================== */

/** 同步睡眠。只会在重试路径上调用，正常路径不产生任何等待 */
function sleepSync(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch (e) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      /* 兜底：极少数环境不支持 Atomics.wait */
    }
  }
}

/** 探测路径存在性，返回 'ok' 或具体错误码（ENOENT / EACCES / EPERM / EBUSY …） */
function probePath(p) {
  try {
    fs.statSync(p);
    return 'ok';
  } catch (e) {
    return (e && e.code) || 'ERR';
  }
}

function findWorkBuddyTokenFileOnce() {
  if (process.env.WORKBUDDY_TOKEN_FILE && fs.existsSync(process.env.WORKBUDDY_TOKEN_FILE)) {
    return process.env.WORKBUDDY_TOKEN_FILE;
  }
  for (const c of CFG.workbuddy.tokenFiles) {
    const p = expand(c);
    if (p && fs.existsSync(p)) return p;
  }
  // L6 兜底：在常见根目录下按文件名扫描
  const roots = [process.env.LOCALAPPDATA, process.env.APPDATA].filter(Boolean);
  for (const root of roots) {
    try {
      for (const appName of fs.readdirSync(root)) {
        if (!/codebuddy|workbuddy/i.test(appName)) continue;
        const p = path.join(root, appName, 'Data', 'Public', 'Auth', 'workbuddy-desktop.info');
        if (fs.existsSync(p)) return p;
      }
    } catch (e) {
      /* 忽略 */
    }
  }
  return null;
}

/**
 * 找到 WorkBuddy 登录态文件（带重试）。
 * 实测存在「同一分钟内一次读不到、下一次又完全正常」的间歇性失败，推测是客户端/扩展
 * 在原子改写该文件时的短暂窗口。若不重试，这种瞬时抖动会被当成"凭证失效"，
 * 进而误推一条"签到失败"微信通知。故重试 4 次、间隔 400ms；首次命中则零等待。
 */
function findWorkBuddyTokenFile() {
  const ATTEMPTS = 4;
  for (let i = 0; i < ATTEMPTS; i++) {
    const hit = findWorkBuddyTokenFileOnce();
    if (hit) {
      if (i > 0) log(`  ↩ 第 ${i + 1} 次尝试才读到 WorkBuddy 登录文件（瞬时抖动，已自动恢复）`);
      return hit;
    }
    if (i < ATTEMPTS - 1) sleepSync(400);
  }
  return null;
}

/**
 * 找不到登录文件时的诊断信息：环境变量是否存在 + 每个候选路径的具体错误码。
 * 目的是让下一次真失败时能直接定位原因，而不是只看到一句"未找到"。
 */
function describeWorkBuddyCandidates() {
  const detail = [];
  const env = ['LOCALAPPDATA', 'APPDATA', 'USERPROFILE'].map(
    (k) => `${k}=${process.env[k] ? '有' : '缺失'}`
  );
  detail.push(`环境变量：${env.join('  ')}`);
  for (const c of CFG.workbuddy.tokenFiles) {
    const p = expand(c);
    detail.push(`  [${probePath(p)}] ${p}`);
  }
  const roots = [process.env.LOCALAPPDATA, process.env.APPDATA].filter(Boolean);
  for (const root of roots) {
    try {
      const names = fs.readdirSync(root).filter((n) => /codebuddy|workbuddy/i.test(n));
      detail.push(`  扫描 ${root} → 匹配 ${names.length} 个：${names.join(' , ') || '（无）'}`);
    } catch (e) {
      detail.push(`  扫描 ${root} 失败：${(e && e.code) || e.message}`);
    }
  }
  const first = CFG.workbuddy.tokenFiles.length ? probePath(expand(CFG.workbuddy.tokenFiles[0])) : 'ERR';
  return { summary: `${env.join('，')}；首个候选路径=${first}`, detail };
}

function readWorkBuddyAuth() {
  const file = findWorkBuddyTokenFile();
  if (!file) {
    let diag = { summary: '诊断不可用', detail: [] };
    try {
      diag = describeWorkBuddyCandidates();
    } catch (e) {
      /* 忽略 */
    }
    log('  🔍 登录文件诊断（用于定位原因）：');
    for (const l of diag.detail) log('     ' + l);
    throw new Error(
      `未找到 WorkBuddy 登录文件（已重试 4 次）。${diag.summary}。请确认已安装并登录 WorkBuddy 桌面端`
    );
  }
  const data = readJSON(file);
  const token = data.auth && data.auth.accessToken;
  let expiresAt = (data.auth && data.auth.expiresAt) || 0;
  if (expiresAt > 1e12) expiresAt = Math.floor(expiresAt); // 本来就是毫秒
  else if (expiresAt) expiresAt = expiresAt * 1000;
  return {
    ...data,
    token,
    expiresAt,
    refreshToken: (data.auth && data.auth.refreshToken) || '',
    file,
    nickname: (data.account && (data.account.nickname || data.account.phoneNumber)) || '未命名',
  };
}

/** 尝试调用刷新接口（当前公网域名 404，默认关闭；拿到正确域名后在 config.json 打开） */
async function workbuddyTryRefresh(auth) {
  if (!CFG.workbuddy.tryRefreshEndpoint || !auth.refreshToken) return null;
  const r = await request('POST', CFG.endpoints.workbuddyRefresh, {
    'X-Refresh-Token': auth.refreshToken,
    'X-Auth-Refresh-Source': 'plugin',
    'X-Domain': (auth.auth && auth.auth.domain) || 'www.codebuddy.cn',
  }, {});
  const t = r.json && r.json.data && r.json.data.data;
  if (r.status === 200 && t && t.accessToken) {
    log('  🔄 刷新接口返回新凭证');
    return {
      accessToken: t.accessToken,
      refreshToken: t.refreshToken || auth.refreshToken,
      expiresAt: Date.now() + (t.expiresIn || 5184000) * 1000,
    };
  }
  throw new Error(`刷新接口不可用（HTTP ${r.status}）`);
}

/** 拉起 WorkBuddy 客户端，让它自己刷新登录态文件，然后轮询等待新凭证 */
async function workbuddyLaunchAndWait(auth, state) {
  const exe = expand(CFG.workbuddy.appExe);
  if (!exe || !fs.existsSync(exe)) return null;

  // 限频：一天内最多拉起 2 次，避免凭证彻底失效时多次弹窗打扰
  const MAX_LAUNCH_PER_DAY = 2;
  const MIN_GAP_MS = 3 * 3600 * 1000;
  const today = localDate();
  const lw = (state.workbuddy && state.workbuddy.launch) || {};
  if (lw.date === today && (lw.count || 0) >= MAX_LAUNCH_PER_DAY) {
    log(`  ⏭ 今日已尝试拉起客户端 ${lw.count} 次，不再重复拉起`);
    return null;
  }
  if (lw.at && Date.now() - lw.at < MIN_GAP_MS) {
    log('  ⏭ 距上次拉起客户端不足 3 小时，跳过');
    return null;
  }

  log(`  🚀 尝试拉起 WorkBuddy 客户端自动刷新登录态…`);
  try {
    const child = spawn(exe, [], { detached: true, stdio: 'ignore' });
    child.unref();
  } catch (e) {
    log(`  ⚠ 启动客户端失败：${e.message}`);
    return null;
  }
  state.workbuddy = Object.assign({}, state.workbuddy, {
    launch: { date: today, count: lw.date === today ? (lw.count || 0) + 1 : 1, at: Date.now() },
  });
  saveState(state);

  const deadline = Date.now() + (CFG.workbuddy.launchWaitSeconds || 75) * 1000;
  while (Date.now() < deadline) {
    await sleep(5000);
    try {
      const again = readWorkBuddyAuth();
      if (again.expiresAt && again.expiresAt > Date.now() + 60 * 1000 && again.expiresAt !== auth.expiresAt) {
        log('  ✅ 客户端已刷新登录态');
        return again;
      }
    } catch (e) {
      /* 文件可能正在被写，稍后再试 */
    }
  }
  log('  ⚠ 等待客户端刷新超时');
  return null;
}

/* ==================================================================
 * 通知
 * ================================================================== */

/**
 * 发送通知。
 * 支持通道（config.json → notify.type）：
 *   pushplus   : 微信推送，url 留空则用官方地址，需要 token
 *   serverchan : Server酱 微信推送，url 留空则用 https://sctapi.ftqq.com/<token>.send
 *   wecom      : 企业微信群机器人 webhook（完全免费无限量）
 *   feishu     : 飞书自定义机器人 webhook
 *   bark       : iOS Bark
 * 凭证只存在于 config.json（本机），绝不打印、不写日志。
 */
async function notify(title, text) {
  const n = CFG.notify;
  if (!n || n.type === 'none') return;

  const full = `${title}\n${text}`;
  let url = n.url || '';
  let body;
  let ctype = 'application/json';

  if (n.type === 'pushplus') {
    if (!url) url = 'https://www.pushplus.plus/send';
    if (!n.token) {
      if (VERBOSE) log('  · 通知未发送：pushplus 缺少 token');
      return;
    }
    body = { token: n.token, title, content: full, template: 'txt' };
  } else if (n.type === 'serverchan') {
    if (!n.token) {
      if (VERBOSE) log('  · 通知未发送：serverchan 缺少 token');
      return;
    }
    if (!url) url = `https://sctapi.ftqq.com/${n.token}.send`;
    body = { title, desp: full };
  } else if (n.type === 'wecom') {
    if (!url) {
      if (VERBOSE) log('  · 通知未发送：wecom 缺少 webhook url');
      return;
    }
    body = { msgtype: 'text', text: { content: full } };
  } else if (n.type === 'feishu') {
    if (!url) {
      if (VERBOSE) log('  · 通知未发送：feishu 缺少 webhook url');
      return;
    }
    body = { msg_type: 'text', content: { text: full } };
  } else if (n.type === 'bark') {
    if (!url) {
      if (VERBOSE) log('  · 通知未发送：bark 缺少 url');
      return;
    }
    body = { title, body: text };
  } else {
    if (!url) return;
    body = { text: full };
  }

  try {
    const r = await requestOnce('POST', url, { 'Content-Type': ctype }, JSON.stringify(body), 15000);
    let ok = r.status >= 200 && r.status < 300;
    let detail = '';

    // 注意：PushPlus / Server酱 / 企业微信 都会用 HTTP 200 携带业务错误码，
    // 只看 HTTP 状态会把「token 无效」误判成发送成功，所以必须再校验响应体。
    if (ok && r.body) {
      try {
        const j = JSON.parse(r.body);
        if (n.type === 'pushplus' && j.code !== 200) {
          ok = false;
          detail = j.msg || 'code ' + j.code;
        } else if (n.type === 'serverchan' && j.code !== 0) {
          ok = false;
          detail = j.message || j.msg || 'code ' + j.code;
        } else if (n.type === 'wecom' && j.errcode !== 0) {
          ok = false;
          detail = j.errmsg || 'errcode ' + j.errcode;
        } else if (n.type === 'feishu' && j.code !== 0) {
          ok = false;
          detail = j.msg || 'code ' + j.code;
        }
      } catch (e) {
        /* 响应不是 JSON，按 HTTP 状态判断 */
      }
    }

    if (ok) log('  📣 通知已发送');
    else log(`  ⚠ 通知发送失败${detail ? '：' + detail : '（HTTP ' + r.status + '）'}`);
    return ok;
  } catch (e) {
    log(`  ⚠ 通知发送失败：${e.message}`);
    return false;
  }
}

function raiseNeedAction(lines) {
  const text = [
    `【签到需要人工处理】${ts()}`,
    ...lines.map((l) => '  - ' + l),
    '',
    '处理后本条可删除。常见处理：',
    '  1) 打开一次 WorkBuddy / Trae 客户端完成登录',
    '  2) 重新运行：node checkin.js --status 确认恢复',
  ].join('\n');
  try {
    fs.writeFileSync(NEED_ACTION_FILE, text, 'utf8');
  } catch (e) {
    /* 忽略 */
  }
}

/**
 * 是否发送失败通知（老板指定的规则）：
 *   复查发现签到失败，**且 WorkBuddy 处于登录状态**时才打扰 —— 说明人在电脑前、环境正常，
 *   失败属于真异常；若 WorkBuddy 没登录（人不在），失败是预期内的，不推送。
 */
async function maybeNotifyFailure(results) {
  const n = CFG.notify;
  if (!n || n.type === 'none' || !n.onFailure) return;

  const entries = Object.entries(results);
  const failed = entries.filter(([, r]) => !r.ok);
  const wbLoggedIn = results.workbuddy && results.workbuddy.loggedIn === true;

  if (!failed.length) return;
  if (!wbLoggedIn) {
    if (VERBOSE) log('  · 有失败项但 WorkBuddy 未登录，按规则不推送');
    return;
  }

  const label = { workbuddy: 'WorkBuddy', trae: 'Trae' };
  const lines = failed.map(([k, r]) => `${label[k] || k}：${r.msg}`).join('\n');
  await notify('签到未全部成功', `${lines}\n\n时间：${ts()}`);
}

function clearNeedAction() {
  try {
    if (fs.existsSync(NEED_ACTION_FILE)) fs.unlinkSync(NEED_ACTION_FILE);
  } catch (e) {
    /* 忽略 */
  }
}

/* ==================================================================
 * WorkBuddy 签到
 * ================================================================== */

async function doWorkBuddy(state, problems) {
  log('【WorkBuddy】');
  let auth;
  try {
    auth = readWorkBuddyAuth();
  } catch (e) {
    log('  ❌ ' + e.message);
    problems.push('WorkBuddy：' + e.message);
    return { ok: false, msg: e.message, needAction: true, loggedIn: false };
  }
  if (!auth.token) {
    const m = '登录文件里没有 accessToken，请重新登录 WorkBuddy';
    log('  ❌ ' + m);
    problems.push('WorkBuddy：' + m);
    return { ok: false, msg: m, needAction: true, loggedIn: false };
  }

  const ahead = (CFG.workbuddy.refreshAheadMinutes || 60) * 60 * 1000;
  const leftMs = auth.expiresAt ? auth.expiresAt - Date.now() : Infinity;

  if (VERBOSE) {
    log(`  账号：${auth.nickname}`);
    log(`  凭证剩余：${Number.isFinite(leftMs) ? Math.floor(leftMs / 86400000) + ' 天' : '未知'}`);
  }

  // ---- L2/L3 过期自动续期 ----
  if (leftMs < ahead) {
    log(`  ⚠ 凭证剩余不足 ${CFG.workbuddy.refreshAheadMinutes} 分钟，触发自动续期`);
    let fresh = null;

    // 路线 A：调刷新接口（需在 config.json 打开）
    try {
      fresh = await workbuddyTryRefresh(auth);
    } catch (e) {
      if (VERBOSE) log(`  · 刷新接口路线不可用：${e.message}`);
    }

    // 路线 B：拉起客户端让它自己刷新
    if (!fresh && CFG.workbuddy.launchAppOnExpiry) {
      fresh = await workbuddyLaunchAndWait(auth, state);
    }

    if (fresh) {
      auth.token = fresh.accessToken;
      auth.expiresAt = fresh.expiresAt;
      state.workbuddy = {
        accessTokenTail: String(fresh.accessToken).slice(-6),
        expiresAt: fresh.expiresAt,
        savedAt: Date.now(),
        source: 'auto-refresh',
      };
      saveState(state);
    } else {
      const m = 'WorkBuddy 凭证已过期且自动续期未成功，需要打开客户端登录一次';
      log('  ❌ ' + m);
      problems.push('WorkBuddy：' + m);
      return { ok: false, msg: m, needAction: true, loggedIn: true };
    }
  }

  // ---- 签到 ----
  const r = await request(
    'POST',
    CFG.endpoints.workbuddyCheckin,
    { Authorization: 'Bearer ' + auth.token, 'User-Agent': 'workbuddy-auto-checkin/1.1' },
    {}
  );
  const code = r.json ? r.json.code : null;
  const msg = (r.json && r.json.msg) || String(r.body || '').slice(0, 120) || '无返回';
  const ALREADY = /已签到|请明天再来|请勿重复|重复操作/;

  if (code === 0) {
    const d = (r.json && r.json.data) || {};
    log(`  ✅ 签到成功${d.credit ? `，获得 ${d.credit} 积分` : ''}${d.streak_days ? `（连续 ${d.streak_days} 天）` : ''}`);
    return { ok: true, msg: '签到成功', loggedIn: true };
  }
  if (ALREADY.test(String(msg))) {
    log(`  ✅ ${msg}（今天已领过）`);
    return { ok: true, msg: String(msg), loggedIn: true };
  }
  if (r.status === 401 || r.status === 403 || code === 401) {
    // 401 也可能是凭证刚失效，最后再兜一次：拉起客户端 + 重试一次
    if (CFG.workbuddy.launchAppOnExpiry) {
      const again = await workbuddyLaunchAndWait(auth, state);
      if (again && again.token) {
        const r2 = await request('POST', CFG.endpoints.workbuddyCheckin, { Authorization: 'Bearer ' + again.token }, {});
        if (r2.json && (r2.json.code === 0 || ALREADY.test(String(r2.json.msg || '')))) {
          log('  ✅ 续期后签到成功');
          return { ok: true, msg: '续期后签到成功', loggedIn: true };
        }
      }
    }
    const m = '登录凭证已失效，需要打开一次 WorkBuddy 客户端重新登录';
    log('  ❌ ' + m);
    problems.push('WorkBuddy：' + m);
    return { ok: false, msg: m, needAction: true, loggedIn: true };
  }
  log(`  ❌ 签到失败：HTTP ${r.status} ${msg}`);
  problems.push(`WorkBuddy：HTTP ${r.status} ${msg}`);
  return { ok: false, msg: String(msg), loggedIn: true };
}

/* ==================================================================
 * Trae 签到
 * ================================================================== */

async function doTrae(state, problems) {
  log('【Trae】');
  let auth;
  try {
    auth = readTraeAuth();
  } catch (e) {
    log('  ❌ ' + e.message);
    problems.push('Trae：' + e.message);
    return { ok: false, msg: e.message, needAction: true };
  }
  log(`  账号：${auth.account ? auth.account.username : auth.userId || '未知'}`);
  if (VERBOSE) log(`  数据目录：${auth.file}`);

  if (!auth.deviceId) {
    log('  ⚠ 未取到数字设备 ID，签到可能被服务端拒绝（打开一次 Trae 客户端后重试）');
  }

  const ahead = (CFG.trae.refreshAheadMinutes || 60) * 60 * 1000;
  const needRefresh = !auth.token || (auth.expiredAt && auth.expiredAt - Date.now() < ahead);

  // ---- L2/L3 token 自动续期 ----
  if (needRefresh) {
    log('  🔄 凭证即将/已过期，自动续期中…');
    const saved = (state.trae && state.trae.refreshToken) || '';
    const candidates = [auth.refreshToken, saved].filter(Boolean);
    let fresh = null;
    for (const rt of candidates) {
      try {
        fresh = await traeRefresh(rt);
        break;
      } catch (e) {
        if (VERBOSE) log(`  · 用某个 refreshToken 续期失败：${e.message}`);
      }
    }
    if (fresh) {
      auth.token = fresh.token;
      auth.expiredAt = fresh.expiredAt;
      auth.refreshToken = fresh.refreshToken;
      log('  ✅ 续期成功');
      state.trae = {
        refreshToken: fresh.refreshToken,
        expiresAt: fresh.expiredAt,
        savedAt: Date.now(),
        userId: auth.userId || '',
      };
      saveState(state);
      if (CFG.trae.writeBack && !NO_WRITEBACK) writeBackTrae(auth, fresh);
    } else {
      const m = 'Trae refreshToken 已失效，需要打开 Trae 客户端重新登录一次';
      log('  ❌ ' + m);
      problems.push('Trae：' + m);
      return { ok: false, msg: m, needAction: true };
    }
  } else if (VERBOSE) {
    log(`  凭证剩余：${Math.floor((auth.expiredAt - Date.now()) / 86400000)} 天`);
  }

  // ---- 查状态 ----
  let st = await request('POST', CFG.endpoints.traeStatus, traeHeaders(auth), {});
  // 401 说明 token 虽在有效期内但已失效 → 强制续期一次再试
  if (st.status === 401 || st.status === 403) {
    log('  🔄 状态查询 401，强制续期后重试…');
    const rt = auth.refreshToken || (state.trae && state.trae.refreshToken);
    try {
      const fresh = await traeRefresh(rt);
      auth.token = fresh.token;
      auth.expiredAt = fresh.expiredAt;
      auth.refreshToken = fresh.refreshToken;
      state.trae = { refreshToken: fresh.refreshToken, expiresAt: fresh.expiredAt, savedAt: Date.now() };
      saveState(state);
      if (CFG.trae.writeBack && !NO_WRITEBACK) writeBackTrae(auth, fresh);
      st = await request('POST', CFG.endpoints.traeStatus, traeHeaders(auth), {});
    } catch (e) {
      const m = 'Trae 凭证失效且续期失败，需要重新登录客户端';
      log('  ❌ ' + m);
      problems.push('Trae：' + m);
      return { ok: false, msg: m, needAction: true };
    }
  }

  const sj = st.json || {};
  if (st.status !== 200 || (sj.code !== 0 && sj.code !== undefined)) {
    const m = `状态查询失败：HTTP ${st.status} ${String(st.body).slice(0, 150)}`;
    log('  ❌ ' + m);
    problems.push('Trae：' + m);
    return { ok: false, msg: m };
  }
  if (sj.enable === false) {
    log('  ⚠ 该账号当前未开放签到活动');
    return { ok: false, msg: '活动未开放' };
  }
  const total = (sj.credits || 0) + (sj.extra_credits || 0);
  if (sj.checked_in) {
    log(`  ✅ 今天已签到（今日可得 ${total} 积分）`);
    return { ok: true, msg: '今天已签到' };
  }
  log(`  今日待领：${total} 积分（${sj.credits || 0} + 额外 ${sj.extra_credits || 0}）`);

  if (STATUS_ONLY) {
    log('  ℹ 仅查询模式，未执行领取');
    return { ok: true, msg: '待领取 ' + total };
  }

  // ---- 领取（服务器限流 9074 温和重试）----
  const tries = CFG.retry.traeBusy || 3;
  for (let attempt = 1; attempt <= tries; attempt++) {
    const cl = await request('POST', CFG.endpoints.traeClaim, traeHeaders(auth), {});
    const cj = cl.json || {};
    if (cl.status === 200 && (cj.code === 0 || cj.checked_in === true)) {
      log(`  ✅ 签到成功，本次获得：${cj.credits != null ? cj.credits : total} 积分`);
      return { ok: true, msg: '签到成功' };
    }
    const reason = String(cj.message || cj.msg || 'HTTP ' + cl.status);
    if (/已签到|already/i.test(reason)) {
      log(`  ✅ ${reason}`);
      return { ok: true, msg: reason };
    }
    const busy = cj.code === 9074 || /繁忙|busy|太多|try again|order parameters/i.test(reason);
    if (busy && attempt < tries) {
      const delayArr = CFG.retry.traeBusyDelayMs || [15000, 25000];
      const wait = delayArr[Math.min(attempt - 1, delayArr.length - 1)] + Math.floor(Math.random() * 5000);
      log(`  ⏳ 服务端未接受（第 ${attempt}/${tries} 次：${reason}），${Math.round(wait / 1000)}s 后重试…`);
      await sleep(wait);
      continue;
    }
    const m = `${reason}${cj.code != null ? '（code ' + cj.code + '）' : ''}`;
    log(`  ❌ 签到失败：${m}`);
    problems.push('Trae：' + m);
    return { ok: false, msg: m };
  }
  return { ok: false, msg: '重试后仍未成功' };
}

/* ==================================================================
 * 离线自检
 * ================================================================== */

function selfTest() {
  log('===== 离线自检（不发任何网络请求）=====');
  let pass = 0;
  let fail = 0;
  const check = (name, fn) => {
    try {
      const r = fn();
      log(`  ✅ ${name}${r ? '：' + r : ''}`);
      pass++;
    } catch (e) {
      log(`  ❌ ${name}：${e.message}`);
      fail++;
    }
  };

  check('Trae 存储目录发现', () => {
    const f = findTraeStorage();
    if (!f) throw new Error('未找到 storage.json');
    return f.product;
  });
  check('Trae 登录态解密', () => {
    const a = readTraeAuth();
    return `账号 ${a.account ? a.account.username : a.userId}，剩余 ${Math.max(0, Math.floor((a.expiredAt - Date.now()) / 86400000))} 天`;
  });
  check('Trae 设备 ID 提取', () => {
    const a = readTraeAuth();
    if (!a.deviceId) throw new Error('未取到数字设备 ID');
    return a.deviceId;
  });
  check('Trae 加解密往返一致', () => {
    const a = readTraeAuth();
    const plain = decryptTraeValue(a.encrypted);
    const re = encryptTraeValue(plain);
    if (decryptTraeValue(re) !== plain) throw new Error('往返不一致');
    return `${re.length} 字节，与原始 ${a.encrypted.length} 字节同长`;
  });
  check('Trae state.json 中的备用 refreshToken', () => {
    const s = loadState();
    const rt = s.trae && s.trae.refreshToken;
    if (!rt) return '（尚未产生，首次续期后写入）';
    return `已缓存，过期时间 ${new Date(s.trae.expiresAt).toLocaleString('zh-CN')}`;
  });
  check('WorkBuddy 登录文件发现', () => {
    const f = findWorkBuddyTokenFile();
    if (!f) throw new Error('未找到 workbuddy-desktop.info');
    return f;
  });
  check('WorkBuddy 凭证有效期', () => {
    const a = readWorkBuddyAuth();
    if (!a.token) throw new Error('无 accessToken');
    const d = Math.floor((a.expiresAt - Date.now()) / 86400000);
    if (d < 0) throw new Error(`已过期 ${-d} 天，需要登录客户端`);
    return `账号 ${a.nickname}，剩余 ${d} 天`;
  });
  check('WorkBuddy 客户端可执行文件', () => {
    const exe = expand(CFG.workbuddy.appExe);
    if (!exe || !fs.existsSync(exe)) throw new Error(`未找到 ${exe}（凭证过期时无法自动拉起客户端）`);
    return exe;
  });
  check('配置文件可读', () => JSON.stringify(CFG.endpoints).length > 0);
  check('日志目录可写', () => {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    return LOG_DIR;
  });

  log(`----- 自检结果：${pass} 项通过，${fail} 项失败 -----`);
  return fail === 0;
}

/* ==================================================================
 * 入口
 * ================================================================== */

(async () => {
  if (SELF_TEST) {
    const ok = selfTest();
    process.exit(ok ? 0 : 1);
  }
  if (DIAGNOSE) {
    log('===== 环境诊断（只读，不签到、不发通知）=====');
    log('【WorkBuddy 登录文件】');
    try {
      const d = describeWorkBuddyCandidates();
      for (const l of d.detail) log('  ' + l);
      const f = findWorkBuddyTokenFile();
      log(`  → 结论（含重试）：${f ? '已找到：' + f : '未找到（上面各路径的方括号即错误码，即原因）'}`);
      if (f) {
        const a = readJSON(f);
        log(`  → 凭证：accessToken=${a.auth && a.auth.accessToken ? '有' : '无'}（不显示内容）`);
      }
    } catch (e) {
      log('  → 诊断异常：' + e.message);
    }
    log('【Trae 存储文件】');
    try {
      const t = findTraeStorage();
      log(`  → 结论：${t ? `已找到：${t.file}（产品：${t.product}）` : '未找到'}`);
    } catch (e) {
      log('  → 诊断异常：' + e.message);
    }
    flushLog();
    process.exit(0);
  }
  if (NOTIFY_TEST) {
    const n = CFG.notify || {};
    if (!n.type || n.type === 'none') {
      log('❌ 通知通道未配置。请设置 config.json → notify.type');
      log('   可选：pushplus（微信）| serverchan（Server酱）| wecom（企业微信机器人）| feishu | bark');
      process.exit(1);
    }
    const needToken = n.type === 'pushplus' || n.type === 'serverchan';
    if (needToken && !n.token) {
      log(`❌ notify.type=${n.type} 缺少 token，请填写 config.json → notify.token`);
      process.exit(1);
    }
    if (!needToken && !n.url) {
      log(`❌ notify.type=${n.type} 缺少 url，请填写 config.json → notify.url`);
      process.exit(1);
    }
    log(`发送测试通知（通道：${n.type}）…`);
    const ok = await notify('签到助手测试', `如果你收到这条消息，说明通知通道配置成功。\n时间：${ts()}`);
    log(ok ? '✅ 已发送，请查看微信 / 客户端' : '⚠ 发送失败，请检查 token / url 是否正确');
    process.exit(ok ? 0 : 1);
  }

  log(`===== 每日签到${STATUS_ONLY ? '（仅查询）' : ''} ${ts()} =====`);
  const state = loadState();
  const problems = [];
  const results = {};

  try {
    results.workbuddy = await doWorkBuddy(state, problems);
  } catch (e) {
    log('  ❌ WorkBuddy 异常：' + e.message);
    problems.push('WorkBuddy 异常：' + e.message);
    results.workbuddy = { ok: false, msg: e.message, needAction: true };
  }
  try {
    results.trae = await doTrae(state, problems);
  } catch (e) {
    log('  ❌ Trae 异常：' + e.message);
    problems.push('Trae 异常：' + e.message);
    results.trae = { ok: false, msg: e.message, needAction: true };
  }

  // 测试用：手动传 --simulate-failure 时把 WorkBuddy 结果强制标记为失败，
  // 用于端到端验证「失败 → 微信通知」链路，不影响正常自动运行。
  if (SIMULATE_FAIL) {
    log('⚠ 模拟失败模式：结果已被强制标记为失败，仅用于验证通知链路');
    results.workbuddy = { ok: false, msg: '模拟失败（测试通知链路）', loggedIn: true };
  }

  const entries = Object.entries(results);
  const okCount = entries.filter(([, r]) => r.ok).length;
  const needAction = entries.some(([, r]) => r.needAction);

  state.lastRun = {
    at: Date.now(),
    ok: okCount === entries.length,
    detail: Object.fromEntries(entries.map(([k, v]) => [k, v.msg])),
  };
  saveState(state);

  log(`----- 结果：${okCount}/${entries.length} 成功 -----`);

  if (needAction || problems.length) raiseNeedAction(problems.length ? problems : ['签到未全部成功']);
  else clearNeedAction();

  // ---- 失败通知 ----
  // 规则：签到未全部成功，且 WorkBuddy 处于登录状态 → 推送（说明人机环境正常，失败属真异常）
  if (!STATUS_ONLY) await maybeNotifyFailure(results);

  if (okCount === entries.length && CFG.notify.onSuccess) {
    await notify('签到成功', `WorkBuddy + Trae 今日签到完成（${ts()}）`);
  }

  flushLog();
  // 显式退出：Node 的全局 keep-alive socket 会把进程吊住，计划任务里会一直显示"运行中"
  process.exit(okCount === entries.length ? 0 : needAction ? 2 : 1);
})();
