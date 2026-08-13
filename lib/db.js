const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_PATH = path.join(DATA_DIR, 'bugsaas.db');
const OLD_JSON_PATH = path.join(DATA_DIR, 'reports.json');

let dbInstance = null;

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function getDb() {
  if (!dbInstance) {
    ensureDataDir();
    dbInstance = new DatabaseSync(DB_PATH);
    initSchema(dbInstance);
    migrateFromJson(dbInstance);
  }
  return dbInstance;
}

function initSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS reports (
      id TEXT PRIMARY KEY,
      description TEXT NOT NULL,
      email TEXT,
      url TEXT,
      repo TEXT,
      meta TEXT DEFAULT '{}',
      consoleErrors TEXT DEFAULT '[]',
      screenshotName TEXT,
      screenshotUrl TEXT,
      status TEXT NOT NULL DEFAULT 'new',
      createdAt TEXT NOT NULL,
      updatedAt TEXT,
      agent1 TEXT,
      agent2 TEXT,
      agent3 TEXT,
      error TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_reports_status ON reports(status);
    CREATE INDEX IF NOT EXISTS idx_reports_created ON reports(createdAt DESC);
  `);
}

function migrateFromJson(db) {
  if (!fs.existsSync(OLD_JSON_PATH)) return;

  try {
    const countRow = db.prepare('SELECT COUNT(*) as count FROM reports').get();
    if (countRow && countRow.count > 0) return; // DB already has records

    const raw = fs.readFileSync(OLD_JSON_PATH, 'utf8');
    const reports = JSON.parse(raw || '[]');
    if (!Array.isArray(reports) || reports.length === 0) return;

    console.log(`[db] Migrating ${reports.length} report(s) from reports.json to SQLite database...`);

    const insertStmt = db.prepare(`
      INSERT OR REPLACE INTO reports (
        id, description, email, url, repo, meta, consoleErrors,
        screenshotName, screenshotUrl, status, createdAt, updatedAt,
        agent1, agent2, agent3, error
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      )
    `);

    for (const r of reports) {
      insertStmt.run(
        r.id,
        r.description || '',
        r.email || null,
        r.url || null,
        r.repo || null,
        JSON.stringify(r.meta || {}),
        JSON.stringify(r.consoleErrors || []),
        r.screenshotName || null,
        r.screenshotUrl || null,
        r.status || 'new',
        r.createdAt || new Date().toISOString(),
        r.updatedAt || null,
        r.agent1 ? JSON.stringify(r.agent1) : null,
        r.agent2 ? JSON.stringify(r.agent2) : null,
        r.agent3 ? JSON.stringify(r.agent3) : null,
        r.error || null
      );
    }

    fs.renameSync(OLD_JSON_PATH, `${OLD_JSON_PATH}.bak`);
    console.log(`[db] Auto-migration complete. Original reports.json backed up to reports.json.bak`);
  } catch (err) {
    console.error('[db] Error during JSON auto-migration:', err.message);
  }
}

function rowToReport(row) {
  if (!row) return null;
  return {
    id: row.id,
    description: row.description,
    email: row.email,
    url: row.url,
    repo: row.repo,
    meta: row.meta ? JSON.parse(row.meta) : {},
    consoleErrors: row.consoleErrors ? JSON.parse(row.consoleErrors) : [],
    screenshotName: row.screenshotName,
    screenshotUrl: row.screenshotUrl,
    status: row.status,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    agent1: row.agent1 ? JSON.parse(row.agent1) : undefined,
    agent2: row.agent2 ? JSON.parse(row.agent2) : undefined,
    agent3: row.agent3 ? JSON.parse(row.agent3) : undefined,
    error: row.error || undefined,
  };
}

module.exports = {
  getDb,
  rowToReport,
};
