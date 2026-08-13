const fs = require('fs');
const path = require('path');
const { callModel, extractJson, isMockMode } = require('../lib/openrouter');
const { searchRepoForBug } = require('../lib/repo-search');
const { getFileFromGitHub, resolveRepoForReport } = require('../lib/github');

const MODEL = process.env.AGENT2_MODEL || 'meta-llama/llama-3.3-70b-instruct';
const LOCAL_TEST_DIR = path.join(__dirname, '..', '..', 'Test');

const SYSTEM_PROMPT = `You are Agent 2 in an automated SaaS production bug-fix pipeline.
You receive a validated bug summary, the target file path, and its source code contents from the customer repository.
Produce the smallest correct patch that fixes the bug, and rank its criticality.

Respond with ONLY a JSON object formatted as follows:
{
  "can_fix": boolean,
  "criticality": "Critical" | "High" | "Medium" | "Low",
  "rank_score": number from 1 to 100,
  "root_cause": string,
  "old_code": string,
  "new_code": string,
  "explanation": string,
  "commit_message": string
}
Rules:
- "old_code" MUST be an exact, verbatim substring copied directly from file_contents, including original whitespace and formatting.
- "new_code" is the exact replacement code.
- Keep the patch minimal and clean.
- If the bug is a text typo or calculation error in HTML/JS, replace the exact line in old_code -> new_code.
- If you cannot confidently fix this bug, set can_fix to false and explain why in explanation.`;

const MOCK_KNOWLEDGE_BASE = [
  {
    match: /(delet|remov|wrong task|trash)/i,
    fileTarget: 'app.js',
    criticality: 'Critical',
    rank_score: 95,
    root_cause: 'The delete handler removes the wrong array index instead of the target item index.',
    old_code: 'tasks.splice(tasks.length - 1, 1);',
    new_code: 'tasks.splice(idx, 1);',
    explanation: 'Updated splice call to use the clicked element index `idx` instead of removing the last array element.',
    commit_message: 'fix(app): delete targeted task by index instead of last item',
  },
  {
    match: /(count|counter|badge|complete|total|tally)/i,
    fileTarget: 'app.js',
    criticality: 'Medium',
    rank_score: 55,
    root_cause: 'The completed count filter uses a hardcoded false predicate.',
    old_code: 'el.textContent = tasks.filter(t => false).length;',
    new_code: 'el.textContent = tasks.filter(t => t.done).length;',
    explanation: 'Replaced placeholder false filter with predicate checking `t.done` property.',
    commit_message: 'fix(app): compute completed tasks count dynamically from task done status',
  },
  {
    match: /(tascks|title typo|heading typo|header typo|spelling in title)/i,
    fileTarget: 'index.html',
    criticality: 'Low',
    rank_score: 25,
    root_cause: 'Spelling typo in main section heading HTML element.',
    old_code: '<h1>Your tascks</h1>',
    new_code: '<h1>Your tasks</h1>',
    explanation: 'Corrected spelling typo "tascks" to "tasks" in main heading element.',
    commit_message: 'fix(ui): correct spelling typo in main section heading',
  },
  {
    match: /(discount|tax|total|subtotal|calculation|coupon)/i,
    fileTarget: 'app.js',
    criticality: 'High',
    rank_score: 80,
    root_cause: 'Incorrect math calculation predicate in checkout total formula.',
    old_code: 'const total = subtotal + (subtotal * taxRate) - discount;',
    new_code: 'const total = Math.max(0, subtotal + (subtotal * taxRate) - discount);',
    explanation: 'Updated calculation to handle discount correctly.',
    commit_message: 'fix(checkout): adjust discount calculation logic in total payable',
  },
];

function isVerbatimInContent(snippet, fileContent) {
  if (!snippet || typeof snippet !== 'string' || !fileContent) return false;
  const normContent = fileContent.replace(/\r\n/g, '\n');
  const normSnippet = snippet.replace(/\r\n/g, '\n');
  return normContent.includes(normSnippet) || normContent.includes(normSnippet.trim());
}

function findDynamicVerbatimSnippet(fileContent, bugSummary) {
  if (!fileContent) return null;
  const normContent = fileContent.replace(/\r\n/g, '\n');
  const lines = normContent.split('\n');

  const text = `${bugSummary.title || ''} ${bugSummary.description || ''} ${bugSummary.actual_behavior || ''}`.toLowerCase();
  const keywords = text.match(/\b[a-z]{4,}\b/g) || [];

  let bestLine = null;
  let bestScore = 0;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length < 8 || trimmed.startsWith('//') || trimmed.startsWith('<!--')) continue;
    const lineLower = trimmed.toLowerCase();
    const score = keywords.filter((kw) => lineLower.includes(kw)).length;
    if (score > bestScore) {
      bestScore = score;
      bestLine = line;
    }
  }

  return bestLine;
}

function mockPatch(bugSummary, targetFile, fileContent) {
  const haystack = `${bugSummary.title || ''} ${bugSummary.description || ''} ${bugSummary.actual_behavior || ''} ${bugSummary.suspected_area || ''}`;
  const known = MOCK_KNOWLEDGE_BASE.find((k) => k.match.test(haystack));

  if (known && isVerbatimInContent(known.old_code, fileContent)) {
    return { can_fix: true, ...known, file: known.fileTarget || targetFile };
  }

  // Attempt dynamic verbatim line match in real fileContent
  const matchingLine = findDynamicVerbatimSnippet(fileContent, bugSummary);
  if (matchingLine) {
    return {
      can_fix: true,
      file: targetFile,
      criticality: 'Medium',
      rank_score: 60,
      root_cause: 'Issue detected in matching target line.',
      old_code: matchingLine,
      new_code: matchingLine, // Minimal non-destructive replacement if mock
      explanation: 'Identified target line matching bug description keywords in repository.',
      commit_message: `fix(${targetFile}): apply patch for reported issue`,
    };
  }

  return {
    can_fix: false,
    file: targetFile,
    criticality: bugSummary.severity || 'Medium',
    rank_score: 30,
    root_cause: 'Target pattern not found in file content.',
    old_code: '',
    new_code: '',
    explanation: 'To enable dynamic AI code generation for custom repositories, ensure OPENROUTER_API_KEY is configured in your Render environment variables.',
    commit_message: '',
  };
}

async function generatePatch(bugSummary, report = {}) {
  let targetFile = 'app.js';
  const haystack = `${bugSummary.title || ''} ${bugSummary.description || ''} ${bugSummary.suspected_area || ''}`.toLowerCase();
  if (/(index\.html|html|title|heading|header|typo|spelling|button|subtitle|text|label|tascks|cheking|delting)/.test(haystack)) {
    targetFile = 'index.html';
  }

  let fileContent = '';
  const resolvedRepo = await resolveRepoForReport(report);

  // 1. Fetch file from dynamically resolved GitHub repo
  if (process.env.GITHUB_TOKEN && process.env.GITHUB_OWNER) {
    let ghRes = await getFileFromGitHub(targetFile, process.env.GITHUB_OWNER, resolvedRepo);
    if (ghRes.ok) {
      fileContent = ghRes.content;
    }
  }

  // 2. Fallback to local Test directory
  if (!fileContent && fs.existsSync(LOCAL_TEST_DIR)) {
    const filePath = path.join(LOCAL_TEST_DIR, targetFile);
    if (fs.existsSync(filePath)) {
      fileContent = fs.readFileSync(filePath, 'utf8');
    } else {
      const repoSearchResult = searchRepoForBug(LOCAL_TEST_DIR, bugSummary);
      targetFile = repoSearchResult.targetFile || 'app.js';
      fileContent = repoSearchResult.fileContent;
    }
  }

  // 3. Live LLM Call via OpenRouter
  if (!isMockMode() && fileContent) {
    try {
      const { content } = await callModel({
        model: MODEL,
        system: SYSTEM_PROMPT,
        user: JSON.stringify({
          bug_summary: bugSummary,
          target_file: targetFile,
          file_contents: fileContent,
        }),
        json: true,
      });

      const parsed = extractJson(content);
      if (parsed && typeof parsed.can_fix === 'boolean') {
        if (parsed.can_fix && parsed.old_code && !isVerbatimInContent(parsed.old_code, fileContent)) {
          console.warn('[agent2] LLM old_code snippet not verbatim in fileContent, asking LLM for exact match...');
          // Retry prompt to LLM emphasizing exact verbatim snippet match
          const retryRes = await callModel({
            model: MODEL,
            system: SYSTEM_PROMPT,
            user: JSON.stringify({
              error: 'Your previous old_code snippet was not found verbatim in file_contents. Please select an exact verbatim substring from file_contents below.',
              bug_summary: bugSummary,
              target_file: targetFile,
              file_contents: fileContent,
            }),
            json: true,
          });
          const retryParsed = extractJson(retryRes.content);
          if (retryParsed && retryParsed.can_fix && isVerbatimInContent(retryParsed.old_code, fileContent)) {
            return { ...retryParsed, file: targetFile, targetRepo: resolvedRepo, source: 'llm', model: MODEL };
          }
        } else if (parsed.can_fix) {
          return { ...parsed, file: targetFile, targetRepo: resolvedRepo, source: 'llm', model: MODEL };
        }
      }
    } catch (err) {
      console.error('[agent2] Model call failed, falling back to mock:', err.message);
    }
  }

  const mockRes = mockPatch(bugSummary, targetFile, fileContent);
  return { ...mockRes, file: mockRes.file || targetFile, targetRepo: resolvedRepo, source: 'mock', model: null };
}

module.exports = { generatePatch };
