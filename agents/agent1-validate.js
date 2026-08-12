const { callModel, extractJson, isMockMode } = require('../lib/openrouter');

const MODEL = process.env.AGENT1_MODEL || 'meta-llama/llama-3.3-70b-instruct';

const SYSTEM_PROMPT = `You are Agent 1 in an automated SaaS production bug-fix pipeline.
A customer site user submitted a bug report. Technical details (URL, browser, viewport, console stack errors, DOM path, screenshot) were automatically gathered by our embedded widget.

Your job:
1. Determine if this is a valid, actionable software bug report.
2. Produce a clear, technical bug summary for downstream patch generation.

CRITICAL VALIDATION RULES:
- ALL software bugs ARE VALID and MUST be accepted: functional bugs, typos, spelling mistakes, text copy errors, UI element misalignments, layout bugs, and visual defects.
- Mark typos and spelling errors as valid=true with severity="Low".
- ONLY reject reports if they are obvious spam (e.g., "asdfghjkl", "test test 123", random gibberish) or offensive harassment.

Respond with ONLY a JSON object formatted as follows:
{
  "valid": boolean,
  "rejection_reason": string or null,
  "title": string (under 12 words),
  "description": string (1-2 sentences, clear technical framing),
  "steps_to_reproduce": string[],
  "expected_behavior": string,
  "actual_behavior": string,
  "suspected_area": string (file or component, e.g. "index.html" or "app.js"),
  "severity": "Critical" | "High" | "Medium" | "Low",
  "confidence": number between 0 and 1
}`;

function mockValidate(report) {
  const desc = (report.description || '').trim();
  const lower = desc.toLowerCase();
  const valid = desc.length >= 5;

  let severity = 'Medium';
  if (/(color|colour|spacing|typo|spelling|text|title|label|heading|minor|small|slightly)/.test(lower)) severity = 'Low';
  if (/(wrong|delete|remove|lost|broken|error|fail|count)/.test(lower)) severity = 'High';
  if (/(crash|everything|always|every time|can'?t use|completely|totally broke)/.test(lower)) severity = 'Critical';

  let area = 'app.js';
  if (/(title|heading|text|typo|spelling|button|html|label)/.test(lower)) {
    area = 'index.html';
  }

  const steps = [
    `Navigate to customer application`,
    `Inspect area: ${area}`,
    `Observe reported behavior: ${desc.slice(0, 60)}`,
  ];

  return {
    valid,
    rejection_reason: valid ? null : 'Description is too brief or lacks actionable details.',
    title: valid ? (desc.length > 55 ? `${desc.slice(0, 52)}...` : desc) : 'Invalid Report',
    description: valid ? desc : desc || 'No detailed description provided.',
    steps_to_reproduce: valid ? steps : [],
    expected_behavior: 'The text or functional behavior should be accurate and error-free.',
    actual_behavior: desc,
    suspected_area: area,
    severity,
    confidence: valid ? 0.90 : 0.2,
  };
}

async function validate(report) {
  if (!isMockMode()) {
    try {
      let userPrompt = JSON.stringify({
        description: report.description,
        url: report.url,
        meta: report.meta,
        consoleErrors: report.consoleErrors,
        screenshotName: report.screenshotName,
      });

      const { content } = await callModel({
        model: MODEL,
        system: SYSTEM_PROMPT,
        user: userPrompt,
        json: true,
      });

      const parsed = extractJson(content);
      if (parsed && typeof parsed.valid === 'boolean') {
        return { ...parsed, source: 'llm', model: MODEL };
      }
      console.error('[agent1] Invalid LLM JSON response, falling back to mock logic.');
    } catch (err) {
      console.error('[agent1] Model call failed, falling back to mock:', err.message);
    }
  }

  return { ...mockValidate(report), source: 'mock', model: null };
}

module.exports = { validate };
