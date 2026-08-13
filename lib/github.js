/**
 * GitHub REST API Client Module
 * Provides dynamic GitHub repository discovery, file reading, and automated commit pushing
 * across any repository connected to the authenticated GitHub account.
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

/**
 * Normalizes (owner, repo) arguments to ensure owner and repo names are never duplicated or misparsed.
 * E.g., if repo = "tejaswinibm2004/online-shop", parses owner = "tejaswinibm2004", repo = "online-shop".
 */
function normalizeRepoTarget(inputOwner, inputRepo) {
  let owner = (inputOwner || process.env.GITHUB_OWNER || '').trim();
  let repo = (inputRepo || process.env.GITHUB_REPO || 'test').trim();

  if (repo.includes('/')) {
    const parts = repo.split('/');
    if (parts[0] && parts[1]) {
      owner = parts[0];
      repo = parts[1];
    } else {
      repo = parts.filter(Boolean).pop();
    }
  }

  return { owner, repo };
}

/**
 * List all repositories accessible by the configured GITHUB_TOKEN / GITHUB_OWNER
 */
async function listUserRepos(owner = process.env.GITHUB_OWNER) {
  if (!process.env.GITHUB_TOKEN) return [];

  const normOwner = (owner || '').split('/')[0];
  const urls = [
    'https://api.github.com/user/repos?per_page=100&sort=updated',
    normOwner ? `https://api.github.com/users/${normOwner}/repos?per_page=100&sort=updated` : null,
  ].filter(Boolean);

  for (const url of urls) {
    try {
      const res = await fetch(url, { headers: getHeaders() });
      if (res.ok) {
        const repos = await res.json();
        if (Array.isArray(repos)) {
          return repos.map((r) => ({
            name: r.name,
            fullName: r.full_name,
            owner: r.owner ? r.owner.login : normOwner,
            defaultBranch: r.default_branch || 'main',
            htmlUrl: r.html_url,
          }));
        }
      }
    } catch (err) {
      console.warn('[github] listUserRepos error:', err.message);
    }
  }
  return [];
}

/**
 * Dynamically resolves the target repository for a bug report.
 * Matches by explicit report.repo, script data-repo, or URL domain/keywords.
 */
async function resolveRepoForReport(report = {}, owner = process.env.GITHUB_OWNER) {
  const userRepos = await listUserRepos(owner);

  // 1. If explicit repo was passed (e.g. report.repo or data-repo="tejaswinibm2004/online-shop")
  if (report.repo) {
    const rawRepo = report.repo.trim();
    const repoName = rawRepo.includes('/') ? rawRepo.split('/')[1] : rawRepo;
    const explicitLower = repoName.toLowerCase();
    const match = userRepos.find((r) => r.name.toLowerCase() === explicitLower || r.fullName.toLowerCase() === rawRepo.toLowerCase());
    if (match) return match.name;
    return repoName; // Return clean repository name
  }

  // 2. Derive keywords from report.url (e.g. https://online-shop-1xpk.onrender.com/ -> "online-shop")
  if (report.url) {
    try {
      const hostname = new URL(report.url).hostname.toLowerCase();
      const parts = hostname.split('.')[0].split('-');
      for (const part of parts) {
        if (part.length >= 3) {
          const match = userRepos.find((r) => r.name.toLowerCase() === part);
          if (match) return match.name;
        }
      }
    } catch (err) {
      /* ignore */
    }
  }

  // 3. Fallback to GITHUB_REPO env var or first available repository
  if (process.env.GITHUB_REPO) {
    const envRepo = process.env.GITHUB_REPO.trim();
    return envRepo.includes('/') ? envRepo.split('/')[1] : envRepo;
  }
  if (userRepos.length > 0) return userRepos[0].name;

  return 'online-shop';
}

async function getFileFromGitHub(filePath, inputOwner = process.env.GITHUB_OWNER, inputRepo = process.env.GITHUB_REPO || 'online-shop', branch = process.env.GITHUB_BRANCH || 'main') {
  const { owner, repo } = normalizeRepoTarget(inputOwner, inputRepo);

  if (!owner || !process.env.GITHUB_TOKEN) {
    return { ok: false, error: 'GitHub credentials not configured (GITHUB_TOKEN, GITHUB_OWNER).' };
  }

  const url = `https://api.github.com/repos/${owner}/${repo}/contents/${filePath}?ref=${branch}`;

  try {
    const res = await fetch(url, { headers: getHeaders() });
    if (!res.ok) {
      // Try with lowercase repo name if original failed
      if (repo !== repo.toLowerCase()) {
        const lowerUrl = `https://api.github.com/repos/${owner}/${repo.toLowerCase()}/contents/${filePath}?ref=${branch}`;
        const lowerRes = await fetch(lowerUrl, { headers: getHeaders() });
        if (lowerRes.ok) {
          const data = await lowerRes.json();
          const content = Buffer.from(data.content, 'base64').toString('utf8');
          return { ok: true, content, sha: data.sha, repo: repo.toLowerCase() };
        }
      }
      return { ok: false, error: `GitHub API error ${res.status}: ${res.statusText} (${url})` };
    }
    const data = await res.json();
    const content = Buffer.from(data.content, 'base64').toString('utf8');
    return { ok: true, content, sha: data.sha, repo };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function commitFileToGitHub(filePath, newContent, message, sha = null, inputOwner = process.env.GITHUB_OWNER, inputRepo = process.env.GITHUB_REPO || 'online-shop', branch = process.env.GITHUB_BRANCH || 'main') {
  const { owner, repo } = normalizeRepoTarget(inputOwner, inputRepo);

  if (!owner || !process.env.GITHUB_TOKEN) {
    return { ok: false, error: 'GitHub credentials missing.' };
  }

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
      // Retry with lowercase repo name
      if (repo !== repo.toLowerCase()) {
        const lowerUrl = `https://api.github.com/repos/${owner}/${repo.toLowerCase()}/contents/${filePath}`;
        const lowerRes = await fetch(lowerUrl, {
          method: 'PUT',
          headers: getHeaders(),
          body: JSON.stringify(payload),
        });
        if (lowerRes.ok) {
          const data = await lowerRes.json();
          return {
            ok: true,
            commitSha: data.commit.sha.slice(0, 7),
            commitUrl: data.commit.html_url,
            message,
            repo: repo.toLowerCase(),
          };
        }
      }
      const errText = await res.text();
      return { ok: false, error: `GitHub commit failed ${res.status}: ${errText}` };
    }

    const data = await res.json();
    return {
      ok: true,
      commitSha: data.commit.sha.slice(0, 7),
      commitUrl: data.commit.html_url,
      message,
      repo,
    };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

module.exports = {
  listUserRepos,
  resolveRepoForReport,
  getFileFromGitHub,
  commitFileToGitHub,
};
