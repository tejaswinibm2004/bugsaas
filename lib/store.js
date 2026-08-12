const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, '..', 'data', 'reports.json');

function ensureDataDir() {
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  if (!fs.existsSync(DB_PATH)) {
    fs.writeFileSync(DB_PATH, '[]', 'utf8');
  }
}

function load() {
  ensureDataDir();
  try {
    const raw = fs.readFileSync(DB_PATH, 'utf8');
    return JSON.parse(raw || '[]');
  } catch (err) {
    return [];
  }
}

function save(reports) {
  ensureDataDir();
  const tempPath = `${DB_PATH}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(reports, null, 2), 'utf8');
  fs.renameSync(tempPath, DB_PATH);
}

function getAll() {
  return load().sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

function getById(id) {
  return load().find((r) => r.id === id) || null;
}

function create(report) {
  const reports = load();
  reports.push(report);
  save(reports);
  return report;
}

function update(id, patchFn) {
  const reports = load();
  const idx = reports.findIndex((r) => r.id === id);
  if (idx === -1) return null;
  reports[idx] = patchFn(reports[idx]);
  reports[idx].updatedAt = new Date().toISOString();
  save(reports);
  return reports[idx];
}

function reset() {
  save([]);
}

function getStats() {
  const reports = load();
  return {
    total: reports.length,
    new: reports.filter((r) => r.status === 'new' || r.status === 'validating').length,
    patched: reports.filter((r) => r.status === 'patched' || r.status === 'deploying').length,
    deployed: reports.filter((r) => r.status === 'deployed').length,
    attention: reports.filter((r) => ['rejected', 'needs_review', 'failed'].includes(r.status)).length,
  };
}

module.exports = { getAll, getById, create, update, reset, getStats };
