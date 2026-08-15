const store = require('./store');
const agent1 = require('../agents/agent1-validate');
const agent2 = require('../agents/agent2-patch');
const agent3 = require('../agents/agent3-deploy');

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const STAGE_PAUSE_MS = 600;

async function runPipeline(id) {
  try {
    store.update(id, (r) => ({ ...r, status: 'validating' }));
    await wait(STAGE_PAUSE_MS);

    const report = store.getById(id);
    if (!report) return;

    const a1 = await agent1.validate(report);

    if (!a1.valid) {
      store.update(id, (r) => ({ ...r, status: 'rejected', agent1: a1 }));
      return;
    }
    store.update(id, (r) => ({ ...r, status: 'validated', agent1: a1 }));

    await wait(STAGE_PAUSE_MS);
    store.update(id, (r) => ({ ...r, status: 'patching' }));
    const a2 = await agent2.generatePatch(a1, report);

    if (!a2.can_fix) {
      store.update(id, (r) => ({ ...r, status: 'needs_review', agent2: a2 }));
      return;
    }
    store.update(id, (r) => ({ ...r, status: 'patched', agent2: a2 }));

    await wait(STAGE_PAUSE_MS);
    store.update(id, (r) => ({ ...r, status: 'deploying' }));
    const a3 = await agent3.deploy(a2, id, report);

    if (!a3.applied) {
      store.update(id, (r) => ({ ...r, status: 'failed', agent3: a3 }));
      return;
    }

    // A push to GitHub was attempted (GITHUB_TOKEN/GITHUB_OWNER configured and
    // ENABLE_GITHUB_PUSH not disabled) but did not succeed — treat as a failed run
    // instead of silently reporting "deployed".
    if (a3.pushAttempted && !a3.pushed) {
      store.update(id, (r) => ({ ...r, status: 'failed', agent3: a3, error: a3.pushLog }));
      return;
    }

    store.update(id, (r) => ({ ...r, status: 'deployed', agent3: a3 }));
  } catch (err) {
    console.error(`[pipeline] Unhandled error processing ${id}:`, err);
    store.update(id, (r) => ({ ...r, status: 'failed', error: err.message }));
  }
}

async function retryReport(id) {
  const report = store.getById(id);
  if (!report) return { ok: false, error: 'Report not found' };
  store.update(id, (r) => ({
    ...r,
    status: 'new',
    agent1: undefined,
    agent2: undefined,
    agent3: undefined,
    error: undefined,
  }));
  runPipeline(id).catch((err) => console.error('[retry] pipeline error:', err));
  return { ok: true };
}

async function forceDeployReport(id) {
  const report = store.getById(id);
  if (!report || !report.agent2 || !report.agent2.can_fix) {
    return { ok: false, error: 'No valid patch available for deployment' };
  }
  store.update(id, (r) => ({ ...r, status: 'deploying' }));
  const a3 = await agent3.deploy(report.agent2, id, report);
  if (!a3.applied) {
    store.update(id, (r) => ({ ...r, status: 'failed', agent3: a3 }));
    return { ok: false, error: a3.reason };
  }

  if (a3.pushAttempted && !a3.pushed) {
    store.update(id, (r) => ({ ...r, status: 'failed', agent3: a3, error: a3.pushLog }));
    return { ok: false, error: a3.pushLog };
  }

  store.update(id, (r) => ({ ...r, status: 'deployed', agent3: a3 }));
  return { ok: true, agent3: a3 };
}

module.exports = { runPipeline, retryReport, forceDeployReport };
