const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { loadEnv } = require('./lib/env');
loadEnv();

const store = require('./lib/store');
const { runPipeline, retryReport, forceDeployReport } = require('./lib/pipeline');
const { isMockMode } = require('./lib/openrouter');

const PORT = process.env.PORT || 4000;
const SITE_TOKEN = process.env.SITE_TOKEN || 'site-token-taskflow-demo';
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = path.join(ROOT, 'data');
const UPLOADS_DIR = path.join(PUBLIC_DIR, 'uploads');
const LOCAL_TEST_DIR = path.join(ROOT, '..', 'Test');
const BACKUP_FILE = path.join(LOCAL_TEST_DIR, 'app.js.backup');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
};

function initSaaS() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

  if (!fs.existsSync(path.join(DATA_DIR, 'reports.json'))) {
    fs.writeFileSync(path.join(DATA_DIR, 'reports.json'), '[]');
  }

  const targetAppJs = path.join(LOCAL_TEST_DIR, 'app.js');
  if (fs.existsSync(targetAppJs) && !fs.existsSync(BACKUP_FILE)) {
    fs.copyFileSync(targetAppJs, BACKUP_FILE);
  }
}

function setCorsHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Site-Token, Authorization, Accept, X-Requested-With');
  res.setHeader('Access-Control-Max-Age', '86400');
}

function serveStatic(res, filePath) {
  fs.readFile(filePath, (err, data) => {
    setCorsHeaders(res);
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
    });
    res.end(data);
  });
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 5_000_000) req.destroy(new Error('Payload too large'));
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch (err) {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function json(res, status, obj) {
  setCorsHeaders(res);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

const server = http.createServer(async (req, res) => {
  try {
    // Set CORS headers on ALL incoming responses
    setCorsHeaders(res);

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      return res.end();
    }

    const url = new URL(req.url, `http://${req.headers.host}`);
    const pathname = decodeURIComponent(url.pathname);

    // ---- Widget CDN endpoint ----------------------------------------
    if (pathname === '/widget.js') {
      return serveStatic(res, path.join(PUBLIC_DIR, 'widget.js'));
    }

    // ---- Intake & API Routes -----------------------------------------
    if (pathname === '/api/bug-reports' && req.method === 'POST') {
      const token = req.headers['x-site-token'] || req.headers['authorization'];
      if (process.env.ENFORCE_SITE_TOKEN === 'true' && token !== SITE_TOKEN && token !== `Bearer ${SITE_TOKEN}`) {
        return json(res, 401, { error: 'Unauthorized: Invalid site token' });
      }

      const body = await readJsonBody(req);
      const description = (body.description || '').toString().trim().slice(0, 3000);
      if (!description) return json(res, 400, { error: 'description is required' });

      let screenshotUrl = null;
      if (body.screenshotBase64) {
        try {
          const match = body.screenshotBase64.match(/^data:image\/(\w+);base64,(.+)$/);
          if (match) {
            const ext = match[1];
            const base64Data = match[2];
            const filename = `shot-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.${ext}`;
            const filepath = path.join(UPLOADS_DIR, filename);
            fs.writeFileSync(filepath, Buffer.from(base64Data, 'base64'));
            screenshotUrl = `/uploads/${filename}`;
          }
        } catch (err) {
          console.error('[server] screenshot save error:', err.message);
        }
      }

      const id = `BUG-${crypto.randomUUID().split('-')[0].toUpperCase()}`;
      const report = {
        id,
        description,
        email: body.email || null,
        url: body.url || null,
        repo: body.repo || null,
        meta: body.meta || {},
        consoleErrors: Array.isArray(body.consoleErrors) ? body.consoleErrors.slice(0, 10) : [],
        screenshotName: body.screenshotName || null,
        screenshotUrl: screenshotUrl || null,
        status: 'new',
        createdAt: new Date().toISOString(),
      };

      store.create(report);
      runPipeline(id).catch((err) => console.error('[pipeline] unhandled error:', err));
      return json(res, 201, { id, status: 'submitted' });
    }

    if (pathname === '/api/reports' && req.method === 'GET') {
      return json(res, 200, store.getAll());
    }

    if (pathname === '/api/stats' && req.method === 'GET') {
      return json(res, 200, store.getStats());
    }

    if (pathname === '/api/config' && req.method === 'GET') {
      return json(res, 200, {
        mock: isMockMode(),
        siteToken: SITE_TOKEN,
        githubConfigured: Boolean(process.env.GITHUB_TOKEN && process.env.GITHUB_OWNER && process.env.GITHUB_REPO),
        githubRepo: `${process.env.GITHUB_OWNER || 'local'}/${process.env.GITHUB_REPO || 'Test'}`,
        models: {
          agent1: process.env.AGENT1_MODEL || 'meta-llama/llama-3.3-70b-instruct',
          agent2: process.env.AGENT2_MODEL || 'qwen/qwen-2.5-coder-32b-instruct',
        },
      });
    }

    if (pathname.match(/^\/api\/reports\/([\w-]+)\/retry$/) && req.method === 'POST') {
      const match = pathname.match(/^\/api\/reports\/([\w-]+)\/retry$/);
      const id = match[1];
      const result = await retryReport(id);
      return json(res, result.ok ? 200 : 400, result);
    }

    if (pathname.match(/^\/api\/reports\/([\w-]+)\/deploy$/) && req.method === 'POST') {
      const match = pathname.match(/^\/api\/reports\/([\w-]+)\/deploy$/);
      const id = match[1];
      const result = await forceDeployReport(id);
      return json(res, result.ok ? 200 : 400, result);
    }

    if (pathname === '/api/reset' && req.method === 'POST') {
      store.reset();
      const targetAppJs = path.join(LOCAL_TEST_DIR, 'app.js');
      if (fs.existsSync(BACKUP_FILE)) {
        fs.copyFileSync(BACKUP_FILE, targetAppJs);
      }
      return json(res, 200, { ok: true });
    }

    // ---- Static SaaS landing & dashboard ----------------------------
    if (pathname === '/') {
      return serveStatic(res, path.join(PUBLIC_DIR, 'index.html'));
    }
    const publicCandidate = path.join(PUBLIC_DIR, pathname);
    if (publicCandidate.startsWith(PUBLIC_DIR) && fs.existsSync(publicCandidate) && fs.statSync(publicCandidate).isFile()) {
      return serveStatic(res, publicCandidate);
    }

    json(res, 404, { error: 'Not found' });
  } catch (err) {
    console.error(err);
    json(res, 500, { error: err.message });
  }
});

initSaaS();
server.listen(PORT, () => {
  console.log(`\n================================================================`);
  console.log(`🚀 Bug_SaaS Autonomous Platform Running on http://localhost:${PORT}`);
  console.log(`   • Dashboard:   http://localhost:${PORT}/dashboard.html`);
  console.log(`   • Widget CDN:  http://localhost:${PORT}/widget.js`);
  console.log(`   • Intake API:  http://localhost:${PORT}/api/bug-reports`);
  console.log(`   • Mode:        ${isMockMode() ? 'MOCK MODE' : 'LIVE (OpenRouter)'}`);
  console.log(`================================================================\n`);
});
