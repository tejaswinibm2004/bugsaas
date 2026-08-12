const fs = require('fs');
const path = require('path');

const IGNORED_DIRS = new Set(['.git', 'node_modules', 'backups', 'data']);
const IGNORED_FILES = new Set(['widget.js']);
const ALLOWED_EXTS = new Set(['.js', '.html', '.css', '.json']);

function scanDirectory(dir, relativeTo = dir) {
  let results = [];
  if (!fs.existsSync(dir)) return results;

  const entries = fs.readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    const relPath = path.relative(relativeTo, fullPath).replace(/\\/g, '/');

    if (entry.isDirectory()) {
      if (!IGNORED_DIRS.has(entry.name)) {
        results = results.concat(scanDirectory(fullPath, relativeTo));
      }
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase();
      if (ALLOWED_EXTS.has(ext) && !IGNORED_FILES.has(entry.name)) {
        results.push({ relPath, fullPath, ext });
      }
    }
  }
  return results;
}

function searchRepoForBug(repoDir, bugSummary) {
  const files = scanDirectory(repoDir);
  if (files.length === 0) {
    return { targetFile: 'app.js', fileContent: '', candidates: [] };
  }

  const queryTerms = [];
  if (bugSummary.description) {
    queryTerms.push(...bugSummary.description.toLowerCase().match(/\b\w{3,}\b/g) || []);
  }
  if (bugSummary.suspected_area) {
    queryTerms.push(...bugSummary.suspected_area.toLowerCase().match(/\b\w{3,}\b/g) || []);
  }
  if (bugSummary.consoleErrors && Array.isArray(bugSummary.consoleErrors)) {
    queryTerms.push(...bugSummary.consoleErrors.join(' ').toLowerCase().match(/\b\w{3,}\b/g) || []);
  }

  const scoredFiles = files.map((file) => {
    let score = 0;
    try {
      const content = fs.readFileSync(file.fullPath, 'utf8');
      const lowerContent = content.toLowerCase();

      for (const term of queryTerms) {
        if (lowerContent.includes(term)) {
          score += 1;
        }
      }
      if (file.relPath === 'app.js' || file.relPath === 'index.html') {
        score += 2;
      }
      return { ...file, score, content };
    } catch (err) {
      return { ...file, score: 0, content: '' };
    }
  });

  scoredFiles.sort((a, b) => b.score - a.score);
  const primaryMatch = scoredFiles[0] || files[0];

  return {
    targetFile: primaryMatch.relPath,
    fileContent: primaryMatch.content,
    fullPath: primaryMatch.fullPath,
    candidates: scoredFiles.map((f) => ({ relPath: f.relPath, score: f.score })),
  };
}

module.exports = { scanDirectory, searchRepoForBug };
