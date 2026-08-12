const board = document.getElementById('board');
const modeBadge = document.getElementById('mode-badge');
const refreshBtn = document.getElementById('refresh-btn');
const resetBtn = document.getElementById('reset-btn');

const statTotal = document.getElementById('stat-total');
const statActive = document.getElementById('stat-active');
const statDeployed = document.getElementById('stat-deployed');
const statAttention = document.getElementById('stat-attention');

const COLUMNS = [
  { key: 'reported', label: 'Reported', statuses: ['new', 'validating'] },
  { key: 'validated', label: 'Validated · Agent 1', statuses: ['validated', 'patching'] },
  { key: 'patched', label: 'Patched · Agent 2', statuses: ['patched', 'deploying'] },
  { key: 'deployed', label: 'Deployed · Agent 3', statuses: ['deployed'] },
  { key: 'attention', label: 'Needs attention', statuses: ['rejected', 'needs_review', 'failed'] },
];

const IN_PROGRESS_LABEL = {
  validating: 'Validating with Agent 1…',
  patching: 'Searching repo & generating patch…',
  deploying: 'Verifying & deploying fix…',
};

const expandedIds = new Set();

function columnFor(status) {
  return COLUMNS.find((c) => c.statuses.includes(status)) || COLUMNS[0];
}

function relTime(iso) {
  if (!iso) return '';
  const diff = Math.max(0, Date.now() - new Date(iso).getTime());
  const s = Math.floor(diff / 1000);
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return `${h}h ago`;
}

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function renderCard(r) {
  const title = (r.agent1 && r.agent1.title) || (r.description || '').slice(0, 70) || 'Bug Report';
  const severity = (r.agent2 && r.agent2.criticality) || (r.agent1 && r.agent1.severity) || 'Medium';
  const inProgress = IN_PROGRESS_LABEL[r.status];
  const isExpanded = expandedIds.has(r.id);

  const pills = [];
  if (severity) pills.push(`<span class="pill-tag pill-${severity}">${severity}</span>`);
  if (inProgress) pills.push(`<span class="spinner-pulse">${inProgress}</span>`);
  if (r.agent1 && r.agent1.source === 'mock') pills.push('<span class="pill-tag" style="background:#334155; color:#94a3b8;">mock</span>');

  let detail = '';

  detail += `<div class="detail-section">
    <div class="detail-heading">Reported Description</div>
    <div class="detail-text">${escapeHtml(r.description)}</div>
    ${r.url ? `<div style="font-size:11px; margin-top:4px; color:#64748b;">${escapeHtml(r.url)}</div>` : ''}
    ${r.screenshotUrl ? `<div style="margin-top:8px;"><a href="${r.screenshotUrl}" target="_blank" style="color:var(--accent-primary); font-size:12px;">View Screenshot Attachment ↗</a></div>` : ''}
  </div>`;

  if (r.agent1) {
    detail += `<div class="detail-section">
      <div class="detail-heading">Agent 1 — Technical Validation</div>`;
    if (!r.agent1.valid) {
      detail += `<div class="detail-text" style="color:var(--accent-danger);">Rejected: ${escapeHtml(r.agent1.rejection_reason)}</div>`;
    } else {
      detail += `<div class="detail-text"><strong>${escapeHtml(r.agent1.title)}</strong><br>${escapeHtml(r.agent1.description)}</div>`;
      if (r.agent1.steps_to_reproduce && r.agent1.steps_to_reproduce.length) {
        detail += `<ul style="margin:6px 0 0 16px;">${r.agent1.steps_to_reproduce.map((s) => `<li>${escapeHtml(s)}</li>`).join('')}</ul>`;
      }
    }
    detail += `</div>`;
  }

  if (r.agent2) {
    detail += `<div class="detail-section">
      <div class="detail-heading">Agent 2 — Patch (${escapeHtml(r.agent2.file || 'app.js')})</div>`;
    if (!r.agent2.can_fix) {
      detail += `<div class="detail-text" style="color:var(--accent-warning);">${escapeHtml(r.agent2.explanation || 'Needs manual engineering review.')}</div>`;
    } else {
      detail += `<div class="detail-text" style="margin-bottom:6px;">Root cause: ${escapeHtml(r.agent2.root_cause)}</div>`;
      detail += `<div class="diff-box old">- ${escapeHtml(r.agent2.old_code)}</div>`;
      detail += `<div class="diff-box new">+ ${escapeHtml(r.agent2.new_code)}</div>`;
      detail += `<div class="detail-text" style="font-size:11px; margin-top:4px;">Rank Priority Score: ${r.agent2.rank_score}/100</div>`;
    }
    detail += `</div>`;
  }

  if (r.agent3) {
    detail += `<div class="detail-section">
      <div class="detail-heading">Agent 3 — Deployment & Git</div>`;
    if (r.agent3.applied) {
      detail += `<div class="detail-text" style="color:var(--accent-success);">
        Commit: <code style="background:#090d16; padding:2px 6px; border-radius:4px;">${escapeHtml(r.agent3.commitHash)}</code><br>
        Tag: <code>${escapeHtml(r.agent3.tag || 'release')}</code><br>
        Status: ${escapeHtml(r.agent3.pushLog || 'Deployed')}
      </div>`;
    } else {
      detail += `<div class="detail-text" style="color:var(--accent-danger);">Deployment failed: ${escapeHtml(r.agent3.reason)}</div>`;
    }
    detail += `</div>`;
  }

  let actionsHtml = '<div class="card-actions">';
  if (['rejected', 'needs_review', 'failed'].includes(r.status)) {
    actionsHtml += `<button class="btn btn-secondary btn-xs action-retry" data-id="${r.id}">Retry Pipeline</button>`;
  }
  if (r.agent2 && r.agent2.can_fix && r.status !== 'deployed') {
    actionsHtml += `<button class="btn btn-xs action-deploy" data-id="${r.id}" style="background:#2563eb;">Deploy Patch</button>`;
  }
  actionsHtml += '</div>';

  return `
    <div class="report-card${isExpanded ? ' expanded' : ''}" data-id="${r.id}">
      <div class="card-title">${escapeHtml(title)}</div>
      <div class="card-meta">
        <div style="display:flex; gap:6px; align-items:center;">${pills.join('')}</div>
        <span class="card-time">${relTime(r.createdAt)}</span>
      </div>
      <div class="card-details">
        ${detail}
        ${actionsHtml}
      </div>
    </div>
  `;
}

function render(reports) {
  board.innerHTML = COLUMNS.map((col) => {
    const items = reports.filter((r) => columnFor(r.status).key === col.key);
    const body = items.length
      ? items.map(renderCard).join('')
      : `<div class="empty-state">No reports in this stage</div>`;
    return `
      <div class="column${col.key === 'attention' ? ' attention' : ''}">
        <div class="column-header">
          <span class="column-title">${col.label}</span>
          <span class="column-count">${items.length}</span>
        </div>
        <div class="card-list">${body}</div>
      </div>
    `;
  }).join('');

  board.querySelectorAll('.report-card').forEach((card) => {
    card.addEventListener('click', (e) => {
      if (e.target.closest('.card-actions')) return;
      const id = card.dataset.id;
      if (expandedIds.has(id)) expandedIds.delete(id); else expandedIds.add(id);
      card.classList.toggle('expanded');
    });
  });

  board.querySelectorAll('.action-retry').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const id = btn.dataset.id;
      btn.disabled = true;
      btn.textContent = 'Retrying…';
      await fetch(`/api/reports/${id}/retry`, { method: 'POST' });
      loadReports();
    });
  });

  board.querySelectorAll('.action-deploy').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const id = btn.dataset.id;
      btn.disabled = true;
      btn.textContent = 'Deploying…';
      await fetch(`/api/reports/${id}/deploy`, { method: 'POST' });
      loadReports();
    });
  });
}

async function loadStats() {
  try {
    const res = await fetch('/api/stats');
    const stats = await res.json();
    statTotal.textContent = stats.total;
    statActive.textContent = stats.new + stats.patched;
    statDeployed.textContent = stats.deployed;
    statAttention.textContent = stats.attention;
  } catch (err) {
    /* ignore */
  }
}

async function loadConfig() {
  try {
    const res = await fetch('/api/config');
    const cfg = await res.json();
    modeBadge.textContent = cfg.mock ? 'MOCK MODE' : `LIVE (${cfg.models.agent2})`;
    modeBadge.className = `badge ${cfg.mock ? 'badge-mock' : 'badge-live'}`;
  } catch (err) {
    modeBadge.textContent = 'OFFLINE';
  }
}

async function loadReports() {
  try {
    const res = await fetch('/api/reports');
    const reports = await res.json();
    render(reports);
    loadStats();
  } catch (err) {
    board.innerHTML = `<div class="empty-state">Unable to connect to SaaS backend.</div>`;
  }
}

refreshBtn.addEventListener('click', () => {
  loadConfig();
  loadReports();
});

resetBtn.addEventListener('click', async () => {
  if (!confirm('Reset demo state and restore original customer site codebase?')) return;
  await fetch('/api/reset', { method: 'POST' });
  expandedIds.clear();
  loadReports();
});

loadConfig();
loadReports();
setInterval(loadReports, 1500);
setInterval(loadConfig, 5000);
