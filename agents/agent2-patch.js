const fs = require('fs');
const path = require('path');
const { callModel, extractJson, isMockMode } = require('../lib/openrouter');
const { searchRepoForBug } = require('../lib/repo-search');
const { getFileFromGitHub } = require('../lib/github');

const MODEL = process.env.AGENT2_MODEL || 'anthropic/claude-sonnet-4.5';
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
- "old_code" MUST be an exact, verbatim substring copied from the file, including original whitespace and formatting.
- "new_code" is the exact replacement code.
- Keep the patch minimal and clean.
- If you cannot confidently fix this bug, set can_fix to false and explain why in explanation.`;

const MOCK_KNOWLEDGE_BASE = [
  {
    match: /(delet|remov|wrong task|trash)/i,
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
    criticality: 'Medium',
    rank_score: 55,
    root_cause: 'The completed count filter uses a hardcoded false predicate.',
    old_code: 'el.textContent = tasks.filter(t => false).length; // wrong: should filter t.done, always 0',
    new_code: 'el.textContent = tasks.filter(t => t.done).length;',
    explanation: 'Replaced placeholder false filter with predicate checking `t.done` property.',
    commit_message: 'fix(app): compute completed tasks count dynamically from task done status',
  },
];

function mockPatch(bugSummary, targetFile, fileContent) {
  const haystack = `${bugSummary.title || ''} ${bugSummary.description || ''} ${bugSummary.actual_behavior || ''}`;
  const known = MOCK_KNOWLEDGE_BASE.find((k) => k.match.test(haystack) && fileContent.includes(k.old_code));

  if (!known) {
    return {
      can_fix: false,
      criticality: bugSummary.severity || 'Medium',
      rank_score: 30,
      root_cause: 'Target pattern not recognized in mock mode.',
      old_code: '',
      new_code: '',
      explanation: 'Mock mode recognizes seeded demo patterns. Supply an OPENROUTER_API_KEY for dynamic LLM patch generation across arbitrary code.',
      commit_message: '',
    };
  }

  return { can_fix: true, ...known };
}

async function generatePatch(bugSummary) {
  let targetFile = 'app.js';
  let fileContent = '';

  // 1. If GitHub configuration is available, try fetching file from GitHub REST API
  if (process.env.GITHUB_TOKEN && process.env.GITHUB_OWNER && process.env.GITHUB_REPO) {
    const ghRes = await getFileFromGitHub('app.js');
    if (ghRes.ok) {
      targetFile = 'app.js';
      fileContent = ghRes.content;
    }
  }

  // 2. Fallback to local Test directory
  if (!fileContent && fs.existsSync(LOCAL_TEST_DIR)) {
    const repoSearchResult = searchRepoForBug(LOCAL_TEST_DIR, bugSummary);
    targetFile = repoSearchResult.targetFile || 'app.js';
    const filePath = path.join(LOCAL_TEST_DIR, targetFile);
    if (fs.existsSync(filePath)) {
      fileContent = fs.readFileSync(filePath, 'utf8');
    }
  }

  if (!isMockMode()) {
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
        return { ...parsed, file: targetFile, source: 'llm', model: MODEL };
      }
      console.error('[agent2] Invalid LLM JSON response, falling back to mock logic.');
    } catch (err) {
      console.error('[agent2] Model call failed, falling back to mock:', err.message);
    }
  }

  return { ...mockPatch(bugSummary, targetFile, fileContent), file: targetFile, source: 'mock', model: null };
}

module.exports = { generatePatch };
