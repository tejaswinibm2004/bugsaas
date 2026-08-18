const assert = require('assert');
const path = require('path');
const http = require('http');
const { loadEnv } = require('../lib/env');

loadEnv();

let passCount = 0;
let failCount = 0;

function test(name, fn) {
  return async () => {
    try {
      await fn();
      console.log(`  ✅ PASS: ${name}`);
      passCount++;
    } catch (err) {
      console.error(`  ❌ FAIL: ${name}`);
      console.error(`     Error: ${err.message}`);
      failCount++;
    }
  };
}

async function runAllTests() {
  console.log('\n================================================================');
  console.log('🧪 Running Bug_SaaS Autonomous Platform Automated Tests');
  console.log('================================================================\n');

  // Test Suite 1: SQLite Store
  console.log('📦 Test Suite 1: SQLite Database Driver');
  process.env.DB_DRIVER = 'sqlite';
  const sqliteStore = require('../lib/store');

  await test('SQLite - Create Bug Report', async () => {
    const report = await sqliteStore.create({
      id: 'BUG-SQLITE-TEST-1',
      description: 'SQLite test bug report description',
      status: 'new',
      createdAt: new Date().toISOString(),
    });
    assert.strictEqual(report.id, 'BUG-SQLITE-TEST-1');
  })();

  await test('SQLite - Fetch Report by ID', async () => {
    const fetched = await sqliteStore.getById('BUG-SQLITE-TEST-1');
    assert.strictEqual(fetched.id, 'BUG-SQLITE-TEST-1');
    assert.strictEqual(fetched.description, 'SQLite test bug report description');
  })();

  await test('SQLite - Update Report Status', async () => {
    const updated = await sqliteStore.update('BUG-SQLITE-TEST-1', (r) => ({ ...r, status: 'validated' }));
    assert.strictEqual(updated.status, 'validated');
  })();

  await test('SQLite - Fetch Stats', async () => {
    const stats = await sqliteStore.getStats();
    assert.strictEqual(typeof stats.total, 'number');
    assert.ok(stats.total >= 1);
  })();

  // Test Suite 2: Cloud Firestore Store
  console.log('\n🔥 Test Suite 2: Cloud Firestore Driver (Live Project: bugsaas)');
  process.env.DB_DRIVER = 'firestore';
  process.env.GOOGLE_APPLICATION_CREDENTIALS = path.join(__dirname, '..', 'serviceAccountKey.json');
  const firestoreStore = require('../lib/store');

  await test('Firestore - Connection & Driver Detection', async () => {
    assert.strictEqual(firestoreStore.getDriver(), 'firestore');
  })();

  await test('Firestore - Create Bug Report', async () => {
    const report = await firestoreStore.create({
      id: 'BUG-FIRESTORE-TEST-1',
      description: 'Cloud Firestore test bug report description',
      status: 'new',
      createdAt: new Date().toISOString(),
    });
    assert.strictEqual(report.id, 'BUG-FIRESTORE-TEST-1');
  })();

  await test('Firestore - Fetch Report by ID', async () => {
    const fetched = await firestoreStore.getById('BUG-FIRESTORE-TEST-1');
    assert.ok(fetched, 'Report should be returned from Firestore');
    assert.strictEqual(fetched.id, 'BUG-FIRESTORE-TEST-1');
    assert.strictEqual(fetched.description, 'Cloud Firestore test bug report description');
  })();

  await test('Firestore - Update Report Patch State', async () => {
    const updated = await firestoreStore.update('BUG-FIRESTORE-TEST-1', (r) => ({ ...r, status: 'patched' }));
    assert.strictEqual(updated.status, 'patched');
  })();

  await test('Firestore - Fetch Aggregated Stats', async () => {
    const stats = await firestoreStore.getStats();
    assert.strictEqual(typeof stats.total, 'number');
    assert.ok(stats.total >= 1);
    assert.ok(stats.patched >= 1);
  })();

  await test('Firestore - Cleanup & Reset Test Record', async () => {
    await firestoreStore.reset();
    const stats = await firestoreStore.getStats();
    assert.strictEqual(stats.total, 0);
  })();

  console.log('\n================================================================');
  console.log(`📊 Test Summary: ${passCount} Passed | ${failCount} Failed`);
  console.log('================================================================\n');

  if (failCount > 0) {
    process.exit(1);
  }
}

runAllTests().catch((err) => {
  console.error('Fatal test runner failure:', err);
  process.exit(1);
});
