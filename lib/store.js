const { getDb, rowToReport } = require('./db');
const firestoreDb = require('./firestoreDb');

function getDriver() {
  const driver = (process.env.DB_DRIVER || '').toLowerCase();
  if (driver === 'firestore') return 'firestore';
  if (driver === 'sqlite') return 'sqlite';

  // Auto-detect Firestore if credentials are provided without explicit driver flag
  if (process.env.FIREBASE_PROJECT_ID || process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    return 'firestore';
  }
  return 'sqlite';
}

function isFirestore() {
  return getDriver() === 'firestore';
}

async function getAll() {
  if (isFirestore()) {
    return firestoreDb.getAll();
  }
  const db = getDb();
  const rows = db.prepare('SELECT * FROM reports ORDER BY createdAt DESC').all();
  return rows.map(rowToReport);
}

async function getById(id) {
  if (isFirestore()) {
    return firestoreDb.getById(id);
  }
  const db = getDb();
  const row = db.prepare('SELECT * FROM reports WHERE id = ?').get(id);
  return rowToReport(row);
}

async function create(report) {
  if (isFirestore()) {
    return firestoreDb.create(report);
  }
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO reports (
      id, description, email, url, repo, meta, consoleErrors,
      screenshotName, screenshotUrl, status, createdAt, updatedAt,
      agent1, agent2, agent3, error
    ) VALUES (
      ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
    )
  `);

  stmt.run(
    report.id,
    report.description || '',
    report.email || null,
    report.url || null,
    report.repo || null,
    JSON.stringify(report.meta || {}),
    JSON.stringify(report.consoleErrors || []),
    report.screenshotName || null,
    report.screenshotUrl || null,
    report.status || 'new',
    report.createdAt || new Date().toISOString(),
    report.updatedAt || null,
    report.agent1 ? JSON.stringify(report.agent1) : null,
    report.agent2 ? JSON.stringify(report.agent2) : null,
    report.agent3 ? JSON.stringify(report.agent3) : null,
    report.error || null
  );

  return report;
}

async function update(id, patchFn) {
  if (isFirestore()) {
    return firestoreDb.update(id, patchFn);
  }

  const current = await getById(id);
  if (!current) return null;

  const patched = patchFn(current);
  patched.updatedAt = new Date().toISOString();

  const db = getDb();
  const stmt = db.prepare(`
    UPDATE reports SET
      description = ?,
      email = ?,
      url = ?,
      repo = ?,
      meta = ?,
      consoleErrors = ?,
      screenshotName = ?,
      screenshotUrl = ?,
      status = ?,
      createdAt = ?,
      updatedAt = ?,
      agent1 = ?,
      agent2 = ?,
      agent3 = ?,
      error = ?
    WHERE id = ?
  `);

  stmt.run(
    patched.description || '',
    patched.email || null,
    patched.url || null,
    patched.repo || null,
    JSON.stringify(patched.meta || {}),
    JSON.stringify(patched.consoleErrors || []),
    patched.screenshotName || null,
    patched.screenshotUrl || null,
    patched.status || 'new',
    patched.createdAt || current.createdAt,
    patched.updatedAt,
    patched.agent1 ? JSON.stringify(patched.agent1) : null,
    patched.agent2 ? JSON.stringify(patched.agent2) : null,
    patched.agent3 ? JSON.stringify(patched.agent3) : null,
    patched.error || null,
    id
  );

  return patched;
}

async function reset() {
  if (isFirestore()) {
    return firestoreDb.reset();
  }
  const db = getDb();
  db.prepare('DELETE FROM reports').run();
}

async function getStats() {
  if (isFirestore()) {
    return firestoreDb.getStats();
  }
  const db = getDb();
  const total = db.prepare('SELECT COUNT(*) as count FROM reports').get().count;
  const newCount = db.prepare("SELECT COUNT(*) as count FROM reports WHERE status IN ('new', 'validating')").get().count;
  const patched = db.prepare("SELECT COUNT(*) as count FROM reports WHERE status IN ('patched', 'deploying')").get().count;
  const deployed = db.prepare("SELECT COUNT(*) as count FROM reports WHERE status = 'deployed'").get().count;
  const attention = db.prepare("SELECT COUNT(*) as count FROM reports WHERE status IN ('rejected', 'needs_review', 'failed')").get().count;

  return {
    total,
    new: newCount,
    patched,
    deployed,
    attention,
  };
}

module.exports = { getAll, getById, create, update, reset, getStats, getDriver };

