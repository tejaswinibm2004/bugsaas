const fs = require('fs');
const path = require('path');
const { callModel, extractJson, isMockMode } = require('../lib/openrouter');
const { searchRepoForBug } = require('../lib/repo-search');
const { getFileFromGitHub } = require('../lib/github');

const MODEL = process.env.AGENT2_MODEL || 'qwen/qwen-2.5-coder-32b-instruct';
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
- If the bug is a text typo or spelling error in HTML/JS, fix the spelling in old_code -> new_code.
- If you cannot confidently fix this bug, set can_fix to false and explain why in explanation.`;

const MOCK_KNOWLEDGE_BASE = [
  // Functional Bug 1: Delete Task
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
  // Functional Bug 2: Completed Counter
  {
    match: /(count|counter|badge|complete|total|tally)/i,
    fileTarget: 'app.js',
    criticality: 'Medium',
    rank_score: 55,
    root_cause: 'The completed count filter uses a hardcoded false predicate.',
    old_code: 'el.textContent = tasks.filter(t => false).length; // wrong: should filter t.done, always 0',
    new_code: 'el.textContent = tasks.filter(t => t.done).length;',
    explanation: 'Replaced placeholder false filter with predicate checking `t.done` property.',
    commit_message: 'fix(app): compute completed tasks count dynamically from task done status',
  },
  // Cosmetic Bug 3: Title Typo ("Your tascks")
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
  // Cosmetic Bug 4: Subtitle Typo ("cheking" / "delting")
  {
    match: /(cheking|delting|subtitle typo|description typo)/i,
    fileTarget: 'index.html',
    criticality: 'Low',
    rank_score: 20,
    root_cause: 'Spelling typos in page subtitle paragraph text.',
    old_code: '<p class="subtitle">Try cheking off a task, or delting one that isnt the last item in the list.</p>',
    new_code: '<p class="subtitle">Try checking off a task, or deleting one that isn\'t the last item in the list.</p>',
    explanation: 'Corrected typos "cheking" and "delting" in subtitle text.',
    commit_message: 'fix(ui): correct typos in page subtitle description',
  },
  // Cosmetic Bug 5: Button Typo ("Ad Task")
  {
    match: /(ad task|add task|button typo|submit button)/i,
    fileTarget: 'index.html',
    criticality: 'Low',
    rank_score: 22,
    root_cause: 'Spelling typo in form submit button text.',
    old_code: '<button type="submit">Ad Task</button>',
    new_code: '<button type="submit">Add Task</button>',
    explanation: 'Corrected button label typo from "Ad Task" to "Add Task".',
    commit_message: 'fix(ui): correct submit button label spelling',
  },
];

function mockPatch(bugSummary, targetFile, fileContent) {
  const haystack = `${bugSummary.title || ''} ${bugSummary.description || ''} ${bugSummary.actual_behavior || ''} ${bugSummary.suspected_area || ''}`;
  const known = MOCK_KNOWLEDGE_BASE.find((k) => k.match.test(haystack));

  if (known) {
    return { can_fix: true, ...known, file: known.fileTarget || targetFile };
  }

  // Fallbacks if haystack didn't match keyword regex directly
  if (targetFile === 'index.html' || /html/i.test(targetFile)) {
    return {
      can_fix: true,
      file: 'index.html',
      criticality: 'Low',
      rank_score: 25,
      root_cause: 'Spelling typo in HTML element.',
      old_code: '<h1>Your tascks</h1>',
      new_code: '<h1>Your tasks</h1>',
      explanation: 'Corrected spelling typo in section heading.',
      commit_message: 'fix(ui): correct spelling typo in heading',
    };
  }

  return {
    can_fix: false,
    file: targetFile,
    criticality: bugSummary.severity || 'Medium',
    rank_score: 30,
    root_cause: 'Target pattern not recognized in mock mode.',
    old_code: '',
    new_code: '',
    explanation: 'Mock mode recognizes seeded demo patterns. Supply OPENROUTER_API_KEY in Render environment variables for dynamic LLM patch generation.',
    commit_message: '',
  };
}

async function generatePatch(bugSummary) {
  let targetFile = 'app.js';

  // Determine target file based on bug description or suspected area
  const haystack = `${bugSummary.title || ''} ${bugSummary.description || ''} ${bugSummary.suspected_area || ''}`.toLowerCase();
  if (/(index\.html|html|title|heading|header|typo|spelling|button|subtitle|text|label|tascks|cheking|delting)/.test(haystack)) {
    targetFile = 'index.html';
  }

  let fileContent = '';

  // 1. If GitHub configuration is available, try fetching file from GitHub REST API
  if (process.env.GITHUB_TOKEN && process.env.GITHUB_OWNER && process.env.GITHUB_REPO) {
    let ghRes = await getFileFromGitHub(targetFile);
    if (!ghRes.ok && process.env.GITHUB_REPO !== process.env.GITHUB_REPO.toLowerCase()) {
      // Retry with lowercase repo name
      ghRes = await getFileFromGitHub(targetFile, process.env.GITHUB_OWNER, process.env.GITHUB_REPO.toLowerCase());
    }
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

  const mockRes = mockPatch(bugSummary, targetFile, fileContent);
  return { ...mockRes, file: mockRes.file || targetFile, source: 'mock', model: null };
}

module.exports = { generatePatch };
