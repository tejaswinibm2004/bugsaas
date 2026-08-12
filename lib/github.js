/**
 * GitHub REST API Client Module
 * Provides direct GitHub repository access to fetch files and commit automated patches.
 */

function getHeaders() {
  const token = process.env.GITHUB_TOKEN;
  return {
    'Accept': 'application/vnd.github.v3+json',
    'User-Agent': 'BugSaaS-Agent',
    ...(token ? { 'Authorization': `Bearer ${token}` } : {}),
    'Content-Type': 'application/json',
  };
}

async function getFileFromGitHub(filePath, owner = process.env.GITHUB_OWNER, repo = process.env.GITHUB_REPO, branch = process.env.GITHUB_BRANCH || 'main') {
  if (!owner || !repo || !process.env.GITHUB_TOKEN) {
    return { ok: false, error: 'GitHub credentials not configured (GITHUB_TOKEN, GITHUB_OWNER, GITHUB_REPO).' };
  }

  const url = `https://api.github.com/repos/${owner}/${repo}/contents/${filePath}?ref=${branch}`;
  try {
    const res = await fetch(url, { headers: getHeaders() });
    if (!res.ok) {
      return { ok: false, error: `GitHub API error ${res.status}: ${res.statusText}` };
    }
    const data = await res.json();
    const content = Buffer.from(data.content, 'base64').toString('utf8');
    return { ok: true, content, sha: data.sha };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function commitFileToGitHub(filePath, newContent, message, sha = null, owner = process.env.GITHUB_OWNER, repo = process.env.GITHUB_REPO, branch = process.env.GITHUB_BRANCH || 'main') {
  if (!owner || !repo || !process.env.GITHUB_TOKEN) {
    return { ok: false, error: 'GitHub credentials missing.' };
  }

  // If sha is not provided, fetch current file sha first
  if (!sha) {
    const fetched = await getFileFromGitHub(filePath, owner, repo, branch);
    if (fetched.ok) {
      sha = fetched.sha;
    }
  }

  const url = `https://api.github.com/repos/${owner}/${repo}/contents/${filePath}`;
  const payload = {
    message,
    content: Buffer.from(newContent).toString('base64'),
    branch,
    ...(sha ? { sha } : {}),
    committer: {
      name: 'BugSaaS Deployment Agent',
      email: 'agent3@bug-saas.com',
    },
  };

  try {
    const res = await fetch(url, {
      method: 'PUT',
      headers: getHeaders(),
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const errText = await res.text();
      return { ok: false, error: `GitHub commit failed ${res.status}: ${errText}` };
    }

    const data = await res.json();
    return {
      ok: true,
      commitSha: data.commit.sha.slice(0, 7),
      commitUrl: data.commit.html_url,
      message,
    };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

module.exports = { getFileFromGitHub, commitFileToGitHub };
