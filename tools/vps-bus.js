/**
 * VPS Agent Bus — HTTP message relay + file sharing for cross-user Claude coordination
 *
 * Two roles:
 *   admin  — full access (read all, send as anyone, list all files, delete)
 *   guest  — send messages to coordinator, read own messages, upload/download shared files
 *
 * Auth: Bearer token in Authorization header
 *
 * Endpoints:
 *   POST   /bus/send             { from, to, subject, body }
 *   GET    /bus/messages          ?to=name&status=new
 *   PATCH  /bus/messages/:id      { status: "read" }
 *   POST   /bus/files/upload      multipart: file field + optional "name" field
 *   GET    /bus/files              list shared files
 *   GET    /bus/files/:filename    download a file
 *   DELETE /bus/files/:filename    admin only
 *   GET    /bus/health
 *
 * Usage: BUS_ADMIN_TOKEN=xxx BUS_GUEST_TOKEN=yyy node vps-bus.js
 * Port: 3099 (nginx proxies /bus/ to this)
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = 3099;
const DATA_DIR = path.join(__dirname, 'bus-data');
const MSG_FILE = path.join(DATA_DIR, 'messages.json');
const FILES_DIR = path.join(DATA_DIR, 'shared-files');
const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50MB per file (arcade games with sprites)
const MAX_TOTAL_FILES = 200;
const MAX_TOTAL_SIZE = 500 * 1024 * 1024; // 500MB total quota

const ADMIN_TOKEN = process.env.BUS_ADMIN_TOKEN;
const GUEST_TOKEN = process.env.BUS_GUEST_TOKEN;
const GUEST_AGENT = process.env.BUS_GUEST_AGENT || 'friend';

if (!ADMIN_TOKEN || !GUEST_TOKEN) {
  console.error('Set BUS_ADMIN_TOKEN and BUS_GUEST_TOKEN env vars');
  process.exit(1);
}

// --- Storage ---
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(FILES_DIR)) fs.mkdirSync(FILES_DIR, { recursive: true });

function loadMessages() {
  if (fs.existsSync(MSG_FILE)) return JSON.parse(fs.readFileSync(MSG_FILE, 'utf8'));
  return [];
}

function saveMessages(msgs) {
  fs.writeFileSync(MSG_FILE, JSON.stringify(msgs, null, 2));
}

// File metadata index
const META_FILE = path.join(DATA_DIR, 'file-meta.json');
function loadFileMeta() {
  if (fs.existsSync(META_FILE)) return JSON.parse(fs.readFileSync(META_FILE, 'utf8'));
  return [];
}
function saveFileMeta(meta) {
  fs.writeFileSync(META_FILE, JSON.stringify(meta, null, 2));
}

// --- Auth ---
function getRole(req) {
  const auth = req.headers.authorization || '';
  const token = auth.replace(/^Bearer\s+/i, '');
  if (token === ADMIN_TOKEN) return 'admin';
  if (token === GUEST_TOKEN) return 'guest';
  return null;
}

// --- HTTP helpers ---
function json(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function parseBody(req, maxSize = 50000) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', c => { body += c; if (body.length > maxSize) reject(new Error('too large')); });
    req.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
  });
}

function parseRawBody(req, maxSize) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', c => { size += c.length; if (size > maxSize) reject(new Error('file too large (2MB max)')); chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

// Sanitize filename — only allow safe chars
function safeName(name) {
  return name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 100);
}

// --- Server ---
const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-Filename');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const url = new URL(req.url, `http://localhost:${PORT}`);
  const parts = url.pathname.replace(/^\/bus\/?/, '').split('/').filter(Boolean);

  // Health check — no auth
  if (parts[0] === 'health') return json(res, 200, { status: 'ok', time: new Date().toISOString(), guestAgent: GUEST_AGENT });

  // Auth required
  const role = getRole(req);
  if (!role) return json(res, 401, { error: 'unauthorized' });

  // ─── MESSAGES ──────────────────────────────────────────────────────

  // POST /bus/send
  if (req.method === 'POST' && parts[0] === 'send') {
    try {
      const body = await parseBody(req);
      if (!body.to || !body.body) return json(res, 400, { error: 'to and body required' });

      const from = role === 'admin' ? (body.from || 'coordinator') : GUEST_AGENT;

      if (role === 'guest' && body.to !== 'coordinator' && body.to !== 'all') {
        return json(res, 403, { error: 'guest can only send to coordinator or all' });
      }

      const msgs = loadMessages();
      const msg = {
        id: crypto.randomUUID(),
        from,
        to: body.to,
        subject: body.subject || '',
        body: body.body,
        status: 'new',
        created: new Date().toISOString(),
      };
      msgs.push(msg);
      while (msgs.length > 200) msgs.shift();
      saveMessages(msgs);

      console.log(`[${msg.created}] ${from} -> ${body.to}: ${(body.subject || body.body).slice(0, 60)}`);
      return json(res, 201, { id: msg.id });
    } catch (e) {
      return json(res, 400, { error: e.message });
    }
  }

  // GET /bus/messages
  if (req.method === 'GET' && parts[0] === 'messages' && !parts[1]) {
    const msgs = loadMessages();
    let filtered = msgs;
    const to = url.searchParams.get('to');
    const status = url.searchParams.get('status');

    // Guest can read ALL messages (full context for reviews) — write is still restricted
    if (to) {
      filtered = filtered.filter(m => m.to === to || m.to === 'all');
    }
    if (status) filtered = filtered.filter(m => m.status === status);

    return json(res, 200, { messages: filtered });
  }

  // PATCH /bus/messages/:id
  if (req.method === 'PATCH' && parts[0] === 'messages' && parts[1]) {
    const msgs = loadMessages();
    const msg = msgs.find(m => m.id === parts[1]);
    if (!msg) return json(res, 404, { error: 'not found' });

    if (role === 'guest' && msg.to !== GUEST_AGENT && msg.to !== 'all') {
      return json(res, 403, { error: 'not your message' });
    }

    try {
      const body = await parseBody(req);
      if (body.status) msg.status = body.status;
      saveMessages(msgs);
      return json(res, 200, { ok: true });
    } catch (e) {
      return json(res, 400, { error: e.message });
    }
  }

  // ─── FILE SHARING ──────────────────────────────────────────────────

  // POST /bus/files/upload — raw body, filename in X-Filename header or query
  if (req.method === 'POST' && parts[0] === 'files' && parts[1] === 'upload') {
    const rawName = req.headers['x-filename'] || url.searchParams.get('name') || 'upload.txt';
    const filename = safeName(rawName);
    if (!filename) return json(res, 400, { error: 'invalid filename' });

    const meta = loadFileMeta();
    if (meta.length >= MAX_TOTAL_FILES && !meta.find(m => m.name === filename)) {
      return json(res, 400, { error: `max ${MAX_TOTAL_FILES} files — delete some first` });
    }

    // Check total quota
    const totalUsed = meta.reduce((sum, m) => sum + (m.size || 0), 0);
    if (totalUsed >= MAX_TOTAL_SIZE) {
      const usedMB = (totalUsed / 1024 / 1024).toFixed(0);
      return json(res, 400, { error: `quota full (${usedMB}MB / ${MAX_TOTAL_SIZE / 1024 / 1024}MB) — delete some files` });
    }

    try {
      const data = await parseRawBody(req, MAX_FILE_SIZE);
      const filePath = path.join(FILES_DIR, filename);
      fs.writeFileSync(filePath, data);

      const entry = meta.find(m => m.name === filename);
      const info = {
        name: filename,
        size: data.length,
        uploadedBy: role === 'admin' ? 'coordinator' : GUEST_AGENT,
        uploadedAt: new Date().toISOString(),
      };
      if (entry) Object.assign(entry, info);
      else meta.push(info);
      saveFileMeta(meta);

      console.log(`[FILE] ${info.uploadedBy} uploaded ${filename} (${data.length} bytes)`);
      return json(res, 201, { name: filename, size: data.length });
    } catch (e) {
      return json(res, 400, { error: e.message });
    }
  }

  // GET /bus/files — list shared files + quota
  if (req.method === 'GET' && parts[0] === 'files' && !parts[1]) {
    const meta = loadFileMeta();
    const totalUsed = meta.reduce((sum, m) => sum + (m.size || 0), 0);
    return json(res, 200, {
      files: meta,
      quota: {
        usedBytes: totalUsed,
        usedMB: +(totalUsed / 1024 / 1024).toFixed(1),
        maxMB: MAX_TOTAL_SIZE / 1024 / 1024,
        fileCount: meta.length,
        maxFiles: MAX_TOTAL_FILES,
      },
    });
  }

  // GET /bus/files/:filename — download
  if (req.method === 'GET' && parts[0] === 'files' && parts[1]) {
    const filename = safeName(parts[1]);
    const filePath = path.join(FILES_DIR, filename);
    if (!fs.existsSync(filePath)) return json(res, 404, { error: 'file not found' });

    const data = fs.readFileSync(filePath);
    const ext = path.extname(filename).toLowerCase();
    const mimeTypes = { '.txt': 'text/plain', '.json': 'application/json', '.js': 'text/javascript',
      '.ts': 'text/typescript', '.html': 'text/html', '.css': 'text/css', '.md': 'text/markdown',
      '.sol': 'text/plain', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml' };
    res.writeHead(200, {
      'Content-Type': mimeTypes[ext] || 'application/octet-stream',
      'Content-Length': data.length,
      'Content-Disposition': `inline; filename="${filename}"`,
    });
    res.end(data);
    return;
  }

  // DELETE /bus/files/:filename — admin or guest (guest can only delete files they uploaded)
  if (req.method === 'DELETE' && parts[0] === 'files' && parts[1]) {
    const filename = safeName(parts[1]);
    if (role === 'guest') {
      const meta = loadFileMeta();
      const entry = meta.find(m => m.name === filename);
      if (entry && entry.uploadedBy !== GUEST_AGENT) return json(res, 403, { error: 'can only delete your own files' });
    }
    const filePath = path.join(FILES_DIR, filename);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    const meta = loadFileMeta().filter(m => m.name !== filename);
    saveFileMeta(meta);
    return json(res, 200, { ok: true });
  }

  return json(res, 404, { error: 'not found' });
});

server.listen(PORT, () => {
  console.log(`[BUS] Agent Bus running on port ${PORT}`);
  console.log(`[BUS] Guest agent: "${GUEST_AGENT}"`);
  console.log(`[BUS] File sharing: ${FILES_DIR} (${MAX_FILE_SIZE / 1024 / 1024}MB max per file, ${MAX_TOTAL_FILES} files max)`);
  console.log(`[BUS] Admin: full access | Guest: messages + file upload/download`);
});
