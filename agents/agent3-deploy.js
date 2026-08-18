const fs = require('fs');
const path = require('path');
const { getFileFromGitHub, commitFileToGitHub, resolveRepoForReport } = require('../lib/github');

const LOCAL_TEST_DIR = path.join(__dirname, '..', '..', 'Test');

function normalizeCode(str) {
  return (str || '').replace(/\r\n/g, '\n');
}

function applyFindReplace(fileContent, oldCode, newCode) {
  if (!oldCode || typeof oldCode !== 'string') {
    return { ok: false, reason: 'Patch contained no old_code snippet.' };
  }

  const normContent = normalizeCode(fileContent);
  const normOld = normalizeCode(oldCode);
  const normNew = normalizeCode(newCode);

  const occurrences = normContent.split(normOld).length - 1;
  if (occurrences === 0) {
    const trimmedOld = normOld.trim();
    const trimmedOccurrences = normContent.split(trimmedOld).length - 1;
    if (trimmedOccurrences === 1) {
      const newContent = normContent.replace(trimmedOld, normNew.trim());
      return { ok: true, newContent };
    }
    // If new_code is already in the content, fix is already applied
    if (normNew && normContent.includes(normNew.trim())) {
      return { ok: true, newContent: normContent, alreadyApplied: true };
    }
    return { ok: false, reason: 'old_code snippet was not found verbatim in target file.' };
  }

  if (occurrences > 1) {
    return { ok: false, reason: `old_code snippet matched ${occurrences} locations (ambiguous patch).` };
  }

  const newContent = normContent.replace(normOld, normNew);
  return { ok: true, newContent };
}

function validateJsSyntax(code) {
  try {
    new Function(code);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function deploy(patch, reportId = 'RELEASE', report = {}) {
  if (!patch || !patch.file) {
    return { applied: false, reason: 'Invalid patch specification (missing target file).' };
  }

  const targetRepo = patch.targetRepo || await resolveRepoForReport(report);
  let fileContent = '';
  let fileSha = null;

  // 1. Fetch target file content dynamically from GitHub REST API
  if (process.env.GITHUB_TOKEN && process.env.GITHUB_OWNER) {
    let ghRes = await getFileFromGitHub(patch.file, process.env.GITHUB_OWNER, targetRepo);
    if (ghRes.ok) {
      fileContent = ghRes.content;
      fileSha = ghRes.sha;
    }
  }

  // 2. Secondary Fallback: Read from local Test directory if available
  const localFilePath = path.join(LOCAL_TEST_DIR, patch.file);
  if (!fileContent && fs.existsSync(localFilePath)) {
    fileContent = fs.readFileSync(localFilePath, 'utf8');
  }

  if (!fileContent) {
    return { applied: false, reason: `Target file "${patch.file}" could not be retrieved from GitHub repository "${targetRepo}".` };
  }

  // 3. Apply patch
  const result = applyFindReplace(fileContent, patch.old_code, patch.new_code);
  if (!result.ok) {
    return { applied: false, reason: result.reason };
  }

  // 4. Validate JS syntax if JS file
  if (patch.file.endsWith('.js')) {
    const syntaxCheck = validateJsSyntax(result.newContent);
    if (!syntaxCheck.ok) {
      return { applied: false, reason: `Patch introduced JavaScript syntax error: ${syntaxCheck.error}` };
    }
  }

  // 5. Update local disk file if present
  if (fs.existsSync(localFilePath)) {
    try {
      fs.writeFileSync(localFilePath, result.newContent, 'utf8');
    } catch (err) {
      /* ignore */
    }
  }

  const commitMsg = patch.commit_message || `fix(${patch.file}): automated patch for ${reportId}`;
  const tag = `release-${reportId.toLowerCase()}`;

  if (result.alreadyApplied) {
    return {
      applied: true,
      file: patch.file,
      targetRepo,
      commitHash: fileSha ? fileSha.slice(0, 7) : 'already-applied',
      commitMessage: commitMsg,
      tag,
      pushed: true,
      pushLog: `Fix is already verified & applied in target GitHub repo "${targetRepo}"`,
      deployedAt: new Date().toISOString(),
    };
  }

  let githubCommitRes = null;

  // 6. Commit and Push dynamically to target GitHub repo via API
  const githubConfigured = Boolean(process.env.GITHUB_TOKEN && process.env.GITHUB_OWNER);
  const pushEnabled = process.env.ENABLE_GITHUB_PUSH !== 'false'; // enabled unless explicitly disabled
  const pushAttempted = githubConfigured && pushEnabled;

  if (pushAttempted) {
    const owner = process.env.GITHUB_OWNER;
    githubCommitRes = await commitFileToGitHub(patch.file, result.newContent, commitMsg, fileSha, owner, targetRepo);
    if (!githubCommitRes.ok) {
      console.error(`[agent3-deploy] GitHub push failed for "${patch.file}" in ${owner}/${targetRepo}: ${githubCommitRes.error}`);
    }
  } else if (githubConfigured && !pushEnabled) {
    console.warn(`[agent3-deploy] GitHub push skipped for "${patch.file}" — ENABLE_GITHUB_PUSH is set to "false".`);
  } else {
    console.warn(`[agent3-deploy] GitHub push skipped for "${patch.file}" — GITHUB_TOKEN and/or GITHUB_OWNER not configured.`);
  }

  const pushed = pushAttempted ? Boolean(githubCommitRes && githubCommitRes.ok) : false;

  let pushLog;
  if (pushAttempted) {
    pushLog = githubCommitRes.ok
      ? `Pushed to GitHub repo "${targetRepo}": ${githubCommitRes.commitUrl}`
      : `GitHub push failed: ${githubCommitRes.error}`;
  } else if (githubConfigured && !pushEnabled) {
    pushLog = 'GitHub push disabled via ENABLE_GITHUB_PUSH=false. Local sync applied only.';
  } else {
    pushLog = 'GitHub not configured (missing GITHUB_TOKEN/GITHUB_OWNER). Local sync applied only.';
  }

  return {
    applied: true,
    file: patch.file,
    targetRepo,
    commitHash: pushed ? githubCommitRes.commitSha : 'local-commit',
    commitMessage: commitMsg,
    tag,
    pushAttempted,
    pushed,
    pushLog,
    deployedAt: new Date().toISOString(),
  };
}

module.exports = { deploy };
