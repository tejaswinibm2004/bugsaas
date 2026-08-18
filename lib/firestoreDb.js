const fs = require('fs');
const path = require('path');

let initializeApp, cert, getApps;
let getFirestore;

try {
  ({ initializeApp, cert, getApps } = require('firebase-admin/app'));
  ({ getFirestore } = require('firebase-admin/firestore'));
} catch (err) {
  // firebase-admin may not be installed yet
}

let dbInstance = null;

function getFirestoreDb() {
  if (dbInstance) return dbInstance;
  if (!initializeApp || !getFirestore) {
    throw new Error('firebase-admin package is not installed. Run `npm install firebase-admin` to enable Firestore support.');
  }

  if (getApps().length > 0) {
    dbInstance = getFirestore();
    return dbInstance;
  }

  // Option 1: File path to service account key JSON
  const keyPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (keyPath && fs.existsSync(keyPath)) {
    const serviceAccount = JSON.parse(fs.readFileSync(keyPath, 'utf8'));
    const app = initializeApp({
      credential: cert(serviceAccount),
      projectId: serviceAccount.project_id || process.env.FIREBASE_PROJECT_ID,
    });
    dbInstance = getFirestore(app);
    console.log('[firestore] Initialized via GOOGLE_APPLICATION_CREDENTIALS key file.');
    return dbInstance;
  }

  // Option 2: Environment variables
  const projectId = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  let privateKey = process.env.FIREBASE_PRIVATE_KEY;

  if (projectId && clientEmail && privateKey) {
    privateKey = privateKey.replace(/\\n/g, '\n');
    const app = initializeApp({
      credential: cert({
        projectId,
        clientEmail,
        privateKey,
      }),
      projectId,
    });
    dbInstance = getFirestore(app);
    console.log(`[firestore] Initialized via env credentials for project: ${projectId}`);
    return dbInstance;
  }

  // Option 3: Default application credentials or project ID only
  if (projectId) {
    const app = initializeApp({ projectId });
    dbInstance = getFirestore(app);
    console.log(`[firestore] Initialized with default credentials for project: ${projectId}`);
    return dbInstance;
  }

  throw new Error(
    'Firebase Firestore credentials not configured. Please set DB_DRIVER=sqlite or provide GOOGLE_APPLICATION_CREDENTIALS in .env.'
  );
}

async function syncFromSqliteIfEmpty() {
  try {
    const db = getFirestoreDb();
    const snapshot = await db.collection('reports').limit(1).get();
    if (!snapshot.empty) return; // Firestore already has data

    const sqliteDbFile = path.join(__dirname, '..', 'data', 'bugsaas.db');
    if (!fs.existsSync(sqliteDbFile)) return;

    const { getDb, rowToReport } = require('./db');
    const sqliteDb = getDb();
    const rows = sqliteDb.prepare('SELECT * FROM reports').all().map(rowToReport);
    if (!rows || rows.length === 0) return;

    console.log(`[firestore] Syncing ${rows.length} existing report(s) from local SQLite to Cloud Firestore...`);
    for (const r of rows) {
      if (r.id.startsWith('BUG-SQLITE-TEST')) continue; // Skip test records
      await create(r);
    }
    console.log('[firestore] Auto-sync to Cloud Firestore complete!');
  } catch (err) {
    console.error('[firestore] Error during auto-sync from SQLite:', err.message);
  }
}

function docToReport(doc) {
  if (!doc.exists) return null;
  const data = doc.data();
  return {
    id: doc.id,
    ...data,
  };
}

async function getAll() {
  const db = getFirestoreDb();
  const snapshot = await db.collection('reports').orderBy('createdAt', 'desc').get();
  const reports = [];
  snapshot.forEach((doc) => {
    reports.push(docToReport(doc));
  });
  return reports;
}

async function getById(id) {
  const db = getFirestoreDb();
  const doc = await db.collection('reports').doc(id).get();
  return docToReport(doc);
}

async function create(report) {
  const db = getFirestoreDb();
  const id = report.id;
  const docData = {
    description: report.description || '',
    email: report.email || null,
    url: report.url || null,
    repo: report.repo || null,
    meta: report.meta || {},
    consoleErrors: report.consoleErrors || [],
    screenshotName: report.screenshotName || null,
    screenshotUrl: report.screenshotUrl || null,
    status: report.status || 'new',
    createdAt: report.createdAt || new Date().toISOString(),
    updatedAt: report.updatedAt || null,
    agent1: report.agent1 || null,
    agent2: report.agent2 || null,
    agent3: report.agent3 || null,
    error: report.error || null,
  };

  await db.collection('reports').doc(id).set(docData);
  return { id, ...docData };
}

async function update(id, patchFn) {
  const current = await getById(id);
  if (!current) return null;

  const patched = patchFn(current);
  patched.updatedAt = new Date().toISOString();

  const db = getFirestoreDb();
  const updateData = {
    description: patched.description || '',
    email: patched.email || null,
    url: patched.url || null,
    repo: patched.repo || null,
    meta: patched.meta || {},
    consoleErrors: patched.consoleErrors || [],
    screenshotName: patched.screenshotName || null,
    screenshotUrl: patched.screenshotUrl || null,
    status: patched.status || 'new',
    createdAt: patched.createdAt || current.createdAt,
    updatedAt: patched.updatedAt,
    agent1: patched.agent1 || null,
    agent2: patched.agent2 || null,
    agent3: patched.agent3 || null,
    error: patched.error || null,
  };

  await db.collection('reports').doc(id).update(updateData);
  return { id, ...updateData };
}

async function reset() {
  const db = getFirestoreDb();
  const snapshot = await db.collection('reports').get();
  const batch = db.batch();
  snapshot.forEach((doc) => {
    batch.delete(doc.ref);
  });
  await batch.commit();
}

async function getStats() {
  const reports = await getAll();
  const total = reports.length;
  const newCount = reports.filter((r) => ['new', 'validating'].includes(r.status)).length;
  const patched = reports.filter((r) => ['patched', 'deploying'].includes(r.status)).length;
  const deployed = reports.filter((r) => r.status === 'deployed').length;
  const attention = reports.filter((r) => ['rejected', 'needs_review', 'failed'].includes(r.status)).length;

  return {
    total,
    new: newCount,
    patched,
    deployed,
    attention,
  };
}

module.exports = {
  getFirestoreDb,
  syncFromSqliteIfEmpty,
  getAll,
  getById,
  create,
  update,
  reset,
  getStats,
};
