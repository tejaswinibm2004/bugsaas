const fs = require('fs');
const path = require('path');
const { commitFileToGitHub } = require('../lib/github');

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

async function deploy(patch, reportId = 'RELEASE') {
  if (!patch || !patch.file) {
    return { applied: false, reason: 'Invalid patch specification (missing target file).' };
  }

  const localFilePath = path.join(LOCAL_TEST_DIR, patch.file);
  let fileContent = '';

  if (fs.existsSync(localFilePath)) {
    fileContent = fs.readFileSync(localFilePath, 'utf8');
  }

  if (!fileContent) {
    return { applied: false, reason: `Target file not found: ${patch.file}` };
  }

  const result = applyFindReplace(fileContent, patch.old_code, patch.new_code);
  if (!result.ok) {
    return { applied: false, reason: result.reason };
  }

  // Syntax check
  if (patch.file.endsWith('.js')) {
    const syntaxCheck = validateJsSyntax(result.newContent);
    if (!syntaxCheck.ok) {
      return { applied: false, reason: `Patch introduced JavaScript syntax error: ${syntaxCheck.error}` };
    }
  }

  // 1. Update local Test directory file if it exists
  if (fs.existsSync(localFilePath)) {
    fs.writeFileSync(localFilePath, result.newContent, 'utf8');
  }

  const commitMsg = patch.commit_message || `fix(${patch.file}): automated patch for ${reportId}`;
  const tag = `release-${reportId.toLowerCase()}`;
  let githubCommitRes = null;

  // 2. Commit and Push to GitHub via GitHub API if GITHUB_TOKEN is configured
  if (process.env.GITHUB_TOKEN && process.env.GITHUB_OWNER && process.env.GITHUB_REPO) {
    githubCommitRes = await commitFileToGitHub(patch.file, result.newContent, commitMsg);
  }

  return {
    applied: true,
    file: patch.file,
    commitHash: githubCommitRes && githubCommitRes.ok ? githubCommitRes.commitSha : 'local-commit',
    commitMessage: commitMsg,
    tag,
    pushed: githubCommitRes ? githubCommitRes.ok : false,
    pushLog: githubCommitRes ? (githubCommitRes.ok ? `Pushed to GitHub: ${githubCommitRes.commitUrl}` : githubCommitRes.error) : 'Local sync applied',
    deployedAt: new Date().toISOString(),
  };
}

module.exports = { deploy };
