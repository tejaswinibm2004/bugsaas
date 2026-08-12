const ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';

function isMockMode() {
  return !process.env.OPENROUTER_API_KEY || process.env.FORCE_MOCK === 'true';
}

async function callModel({ model, system, user, json = false }) {
  if (isMockMode()) {
    return { mock: true, content: null };
  }

  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://bug-saas-platform.local',
      'X-Title': 'BugSaaS Autonomous Platform',
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      temperature: 0.2,
      ...(json ? { response_format: { type: 'json_object' } } : {}),
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`OpenRouter ${res.status}: ${text.slice(0, 400)}`);
  }

  const data = await res.json();
  const content = data.choices && data.choices[0] && data.choices[0].message
    ? data.choices[0].message.content
    : '';
  return { mock: false, content, raw: data };
}

function extractJson(content) {
  if (!content) return null;
  let cleaned = content.trim();
  cleaned = cleaned.replace(/^```json\s*/i, '').replace(/^```\s*/, '').replace(/```$/, '').trim();
  try {
    return JSON.parse(cleaned);
  } catch (err) {
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        return JSON.parse(match[0]);
      } catch (err2) {
        return null;
      }
    }
    return null;
  }
}

module.exports = { callModel, extractJson, isMockMode };
