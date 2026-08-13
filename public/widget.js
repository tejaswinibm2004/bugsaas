/**
 * Autonomous BugSaaS Embedded Customer Widget
 * Usage on customer site:
 * <script src="https://bug-saas.onrender.com/widget.js"
 *         data-saas-url="https://bug-saas.onrender.com"
 *         data-site-token="site-token-taskflow-demo"></script>
 */
(function () {
  const currentScript = document.currentScript;
  const saasUrl = (currentScript && currentScript.getAttribute('data-saas-url')) || window.location.origin;
  const siteToken = (currentScript && currentScript.getAttribute('data-site-token')) || 'site-token-taskflow-demo';
  const targetRepo = (currentScript && currentScript.getAttribute('data-repo')) || null;
  const API_ENDPOINT = `${saasUrl.replace(/\/$/, '')}/api/bug-reports`;

  const recentErrors = [];
  function pushError(msg, stack = '') {
    recentErrors.push({
      message: String(msg).slice(0, 300),
      stack: String(stack).slice(0, 500),
      timestamp: new Date().toISOString(),
    });
    if (recentErrors.length > 10) recentErrors.shift();
  }

  window.addEventListener('error', (e) => pushError(e.message || String(e.error), e.error ? e.error.stack : ''));
  window.addEventListener('unhandledrejection', (e) => pushError(`Unhandled Promise: ${e.reason}`, e.reason && e.reason.stack ? e.reason.stack : ''));

  function collectMeta() {
    return {
      userAgent: navigator.userAgent,
      platform: navigator.platform || 'unknown',
      language: navigator.language || 'unknown',
      viewport: `${window.innerWidth}x${window.innerHeight}`,
      screen: `${window.screen.width}x${window.screen.height}`,
      timestamp: new Date().toISOString(),
    };
  }

  function fileToBase64(file) {
    return new Promise((resolve, reject) => {
      if (!file) return resolve(null);
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = (err) => reject(err);
      reader.readAsDataURL(file);
    });
  }

  // Inject widget CSS
  const style = document.createElement('style');
  style.textContent = `
    .vbf-launcher {
      position: fixed; right: 24px; bottom: 24px; z-index: 99998;
      display: flex; align-items: center; gap: 10px;
      background: linear-gradient(135deg, #0f172a 0%, #1e293b 100%);
      color: #f8fafc; border: 1px solid rgba(255,255,255,0.15);
      padding: 12px 20px; border-radius: 9999px; font-size: 14px; font-weight: 600;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      cursor: pointer; box-shadow: 0 10px 25px -5px rgba(0, 0, 0, 0.4);
      transition: all 0.25s cubic-bezier(0.4, 0, 0.2, 1);
    }
    .vbf-launcher:hover { transform: translateY(-2px); box-shadow: 0 15px 30px -5px rgba(0, 0, 0, 0.5); background: #0f172a; }
    .vbf-overlay {
      position: fixed; inset: 0; background: rgba(15, 23, 42, 0.65); backdrop-filter: blur(4px);
      z-index: 99999; display: flex; align-items: flex-end; justify-content: flex-end;
      padding: 24px; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    }
    @media (min-width: 640px) { .vbf-overlay { align-items: center; justify-content: center; } }
    .vbf-panel {
      background: #ffffff; color: #0f172a; width: 100%; max-width: 440px;
      border-radius: 20px; padding: 26px; box-shadow: 0 25px 50px -12px rgba(0,0,0,0.35);
      border: 1px solid #e2e8f0; animation: vbfPop 0.2s cubic-bezier(0.16, 1, 0.3, 1);
    }
    @keyframes vbfPop { from { opacity: 0; transform: scale(0.95); } to { opacity: 1; transform: scale(1); } }
    .vbf-panel h2 { margin: 0 0 6px; font-size: 20px; font-weight: 700; color: #0f172a; letter-spacing: -0.02em; }
    .vbf-sub { margin: 0 0 18px; font-size: 13.5px; color: #64748b; line-height: 1.45; }
    .vbf-panel textarea {
      width: 100%; min-height: 110px; resize: vertical;
      border: 1px solid #cbd5e1; border-radius: 12px; padding: 14px;
      font-size: 14px; font-family: inherit; line-height: 1.5; box-sizing: border-box;
    }
    .vbf-panel textarea:focus, .vbf-panel input:focus { outline: none; border-color: #2563eb; box-shadow: 0 0 0 3px rgba(37,99,235,0.15); }
    .vbf-field { margin-top: 14px; }
    .vbf-field label { display: block; font-size: 12.5px; font-weight: 600; color: #475569; margin-bottom: 6px; }
    .vbf-field input[type=email], .vbf-field input[type=file] {
      width: 100%; border: 1px solid #cbd5e1; border-radius: 10px; padding: 10px 12px; font-size: 13.5px;
      font-family: inherit; box-sizing: border-box;
    }
    .vbf-actions { display: flex; justify-content: flex-end; gap: 10px; margin-top: 20px; }
    .vbf-btn { border: none; border-radius: 10px; padding: 11px 18px; font-size: 14px; font-weight: 600; cursor: pointer; font-family: inherit; transition: all 0.15s; }
    .vbf-btn-cancel { background: #f1f5f9; color: #475569; }
    .vbf-btn-cancel:hover { background: #e2e8f0; }
    .vbf-btn-send { background: #2563eb; color: #ffffff; }
    .vbf-btn-send:hover { background: #1d4ed8; }
    .vbf-btn-send:disabled { opacity: 0.6; cursor: not-allowed; }
    .vbf-status { font-size: 13px; margin-top: 12px; font-weight: 500; }
    .vbf-status.vbf-error { color: #dc2626; }
    .vbf-confirm { text-align: center; padding: 12px 6px; }
    .vbf-check {
      width: 52px; height: 52px; border-radius: 50%; background: #22c55e; color: #fff;
      display: flex; align-items: center; justify-content: center; font-size: 24px; font-weight: bold; margin: 0 auto 16px;
    }
  `;
  document.head.appendChild(style);

  // Launcher button
  const launcher = document.createElement('button');
  launcher.className = 'vbf-launcher';
  launcher.type = 'button';
  launcher.innerHTML = '🐞 Report a problem';
  document.body.appendChild(launcher);

  let overlay = null;

  function openModal() {
    overlay = document.createElement('div');
    overlay.className = 'vbf-overlay';
    overlay.innerHTML = `
      <div class="vbf-panel" role="dialog" aria-modal="true" aria-label="Report a problem">
        <div class="vbf-form-state">
          <h2>Report an issue</h2>
          <p class="vbf-sub">Describe what went wrong in your own words. Our AI pipeline will analyze and fix it automatically.</p>
          <textarea id="vbf-desc" placeholder="e.g. When I click the delete button on a task, it removes the wrong item from the list." autofocus></textarea>
          <div class="vbf-field">
            <label for="vbf-email">Your email (optional)</label>
            <input type="email" id="vbf-email" placeholder="alex@example.com">
          </div>
          <div class="vbf-field">
            <label for="vbf-file">Attach screenshot (optional)</label>
            <input type="file" id="vbf-file" accept="image/*">
          </div>
          <div class="vbf-status" id="vbf-status"></div>
          <div class="vbf-actions">
            <button type="button" class="vbf-btn vbf-btn-cancel" id="vbf-cancel">Cancel</button>
            <button type="button" class="vbf-btn vbf-btn-send" id="vbf-send">Submit report</button>
          </div>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    overlay.addEventListener('click', (e) => { if (e.target === overlay) closeModal(); });
    overlay.querySelector('#vbf-cancel').addEventListener('click', closeModal);
    overlay.querySelector('#vbf-send').addEventListener('click', submitReport);
  }

  function closeModal() {
    if (overlay) { overlay.remove(); overlay = null; }
  }

  async function submitReport() {
    const desc = overlay.querySelector('#vbf-desc').value.trim();
    const email = overlay.querySelector('#vbf-email').value.trim();
    const file = overlay.querySelector('#vbf-file').files[0];
    const statusEl = overlay.querySelector('#vbf-status');
    const sendBtn = overlay.querySelector('#vbf-send');

    if (desc.length < 6) {
      statusEl.textContent = 'Please describe what happened in a few more words.';
      statusEl.className = 'vbf-status vbf-error';
      return;
    }

    sendBtn.disabled = true;
    sendBtn.textContent = 'Submitting…';
    statusEl.textContent = '';

    try {
      const screenshotBase64 = file ? await fileToBase64(file) : null;

      const res = await fetch(API_ENDPOINT, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Site-Token': siteToken,
        },
        body: JSON.stringify({
          description: desc,
          email: email || null,
          url: window.location.href,
          repo: targetRepo,
          meta: collectMeta(),
          consoleErrors: recentErrors.slice(),
          screenshotName: file ? file.name : null,
          screenshotBase64,
        }),
      });

      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || `Server returned ${res.status}`);
      }

      const data = await res.json();
      showConfirmation(data.id);
    } catch (err) {
      statusEl.textContent = `Could not submit report: ${err.message}`;
      statusEl.className = 'vbf-status vbf-error';
      sendBtn.disabled = false;
      sendBtn.textContent = 'Submit report';
    }
  }

  function showConfirmation(id) {
    const panel = overlay.querySelector('.vbf-panel');
    panel.innerHTML = `
      <div class="vbf-confirm">
        <div class="vbf-check">✓</div>
        <h2>Report Received</h2>
        <p class="vbf-sub">Reference ID: <code style="background:#f1f5f9; padding:4px 8px; border-radius:6px; font-weight:600; color:#2563eb;">${id}</code></p>
        <p class="vbf-sub">Our autonomous multi-agent pipeline is validating and generating a live patch now.</p>
        <div class="vbf-actions" style="justify-content:center;">
          <button type="button" class="vbf-btn vbf-btn-send" id="vbf-done">Done</button>
        </div>
      </div>
    `;
    panel.querySelector('#vbf-done').addEventListener('click', closeModal);
  }

  launcher.addEventListener('click', openModal);

  function attachCustomTriggers() {
    const selector = '#reportBugBtn, #reportOrderIssueBtn, .report-bug-btn, [data-bug-report]';
    const targets = document.querySelectorAll(selector);
    targets.forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        openModal();
      });
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', attachCustomTriggers);
  } else {
    attachCustomTriggers();
  }
})();
