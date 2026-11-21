const $ = (id) => document.getElementById(id);
const PARAMS = ['width', 'height', 'fps', 'frames', 'steps', 'cfg', 'seed', 'randomize', 'precision', 'refImageSize', 'scheduler'];
const ENUM_PARAMS = new Set(['precision', 'refImageSize', 'scheduler']);
const STATUS_LABEL = { queued: '排队中', running: '生成中', succeeded: '已完成', failed: '失败', blocked: '未就绪' };
const ACTIVE = new Set(['queued', 'running']);
const PUBLIC_MODE = !['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
const API_ORIGIN = PUBLIC_MODE ? 'http://127.0.0.1:9860' : location.origin;
const TOKEN_KEY = 'h3-paired-local-session-v1';
const MEDIA_KEY = 'h3-paired-local-media-v1';
const state = { status: null, uploads: [], uploadBusy: false, submitBusy: false, jobs: [], selectedId: null, selection: 0, timer: null, toastTimer: null, refreshing: false, draftRestored: false, pairToken: null, mediaToken: null };
try { if (PUBLIC_MODE) { state.pairToken = sessionStorage.getItem(TOKEN_KEY); state.mediaToken = sessionStorage.getItem(MEDIA_KEY); } } catch { /* Pairing can remain in memory when session storage is disabled. */ }

function apiUrl(path) { return new URL(path, `${API_ORIGIN}/`).href; }

async function api(path, options = {}) {
  // The per-process token protects loopback mutations from other browser origins.
  const mutation = options.method && !['GET', 'HEAD'].includes(options.method.toUpperCase());
  const timeoutMs = path.startsWith('/api/pair') ? 10000 : path === '/api/uploads' ? 60000 : path.startsWith('/api/jobs') ? 30000 : 20000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(apiUrl(path), { ...options, signal: controller.signal, credentials: 'omit', headers: { ...(PUBLIC_MODE && state.pairToken ? { Authorization: `Bearer ${state.pairToken}` } : {}), ...(mutation && state.status?.csrfToken ? { 'X-CSRF-Token': state.status.csrfToken } : {}), ...options.headers }, cache: 'no-store' });
    const json = await response.json().catch((error) => { if (controller.signal.aborted) throw error; return null; });
    if (!response.ok) {
      if (PUBLIC_MODE && response.status === 401) { state.pairToken = null; state.mediaToken = null; try { sessionStorage.removeItem(TOKEN_KEY); sessionStorage.removeItem(MEDIA_KEY); } catch {} $('pair-message').textContent = '配对已失效，请在本机连接器查看新连接码并重新连接。'; }
      throw new Error(typeof json?.error === 'string' ? json.error : json?.error?.message || json?.message || `本地服务请求失败（${response.status}）`);
    }
    if (!json) throw new Error('本地服务返回了无效响应，请刷新运行环境。');
    return json;
  } catch (error) {
    if (controller.signal.aborted) throw new Error(PUBLIC_MODE ? `连接本机引擎超时（${timeoutMs / 1000} 秒）。请使用 Chrome/Edge 并在站点设置允许“本地网络访问”，或点击“直接打开本机工作台”。` : `本机请求超时（${timeoutMs / 1000} 秒），请检查连接器和 ComfyUI 日志。`);
    if (PUBLIC_MODE && error instanceof TypeError) throw new Error('浏览器无法访问本机引擎。请先启动连接器，使用 Chrome/Edge 允许“本地网络访问”；内嵌浏览器不可用时，请直接打开本机工作台。');
    throw error;
  } finally { clearTimeout(timer); }
}

function params() {
  return Object.fromEntries(PARAMS.map((key) => [key, key === 'randomize' ? $(key).checked : ENUM_PARAMS.has(key) ? $(key).value : Number($(key).value)]));
}

function persistDraft() {
  // Only plain text and parameters are persisted; source image bytes stay out of browser storage.
  try { localStorage.setItem('h3-multiframe-draft-v1', JSON.stringify({ prompt: $('prompt').value, params: params() })); } catch { /* Storage may be disabled without preventing generation. */ }
}

function restoreDraft() {
  try {
    const draft = JSON.parse(localStorage.getItem('h3-multiframe-draft-v1') || 'null');
    if (!draft || typeof draft !== 'object') return;
    if (typeof draft.prompt === 'string') $('prompt').value = draft.prompt.slice(0, 12000);
    for (const key of PARAMS) {
      if (key === 'randomize' && typeof draft.params?.[key] === 'boolean') $(key).checked = draft.params[key];
      else if (ENUM_PARAMS.has(key) && typeof draft.params?.[key] === 'string' && [...$(key).options].some((option) => option.value === draft.params[key])) $(key).value = draft.params[key];
      else if (key !== 'randomize' && Number.isFinite(draft.params?.[key])) $(key).value = draft.params[key];
    }
    $('fps').value = 24; $('cfg').value = 1;
    state.draftRestored = true;
  } catch { /* A malformed old draft must not break the workbench. */ }
}

function updateParams() {
  const p = params();
  $('parameter-summary').textContent = `${p.width || '—'} × ${p.height || '—'} · ${p.steps || '—'} 步`;
  $('quality-preset').value = p.width === 1344 && p.height === 768 && p.steps === 50 ? 'quality' : p.width === 1344 && p.height === 768 && p.steps === 25 ? 'standard' : p.width === 1920 && p.height === 1088 && p.steps === 50 ? 'experimental' : 'custom';
  $('duration-estimate').textContent = Number.isFinite(p.frames / p.fps) && p.fps > 0 ? `预计时长 ${(p.frames / p.fps).toFixed(2)} 秒` : '请输入有效帧数和帧率';
  $('seed').disabled = p.randomize;
  for (const input of document.querySelectorAll('.reference-frame')) input.max = Math.max(1, p.frames - 2);
  $('prompt-count').textContent = `${$('prompt').value.length.toLocaleString('zh-CN')} 字`;
  for (const button of document.querySelectorAll('[data-size]')) {
    const [w, h] = button.dataset.size.split(',').map(Number);
    const active = p.width === w && p.height === h;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  }
  updateSubmit();
}

function setFormError(message) {
  $('form-error').textContent = message || '';
  $('form-error').hidden = !message;
}

function updateSubmit() {
  const busy = state.uploadBusy || state.submitBusy;
  const hasActive = state.jobs.some((job) => ACTIVE.has(job.status));
  const ready = state.status?.ready === true;
  const imagesReady = state.uploads.length > 0 && state.uploads.every((item) => item.id && !item.error);
  $('generate-button').disabled = !ready || !imagesReady || !$('prompt').value.trim() || busy || hasActive;
  $('generate-label').textContent = state.submitBusy ? '正在提交…' : state.uploadBusy ? '正在上传图片…' : hasActive ? '本地任务运行中' : '生成视频';
  $('generate-note').textContent = !ready ? '完成本地环境检查后即可生成 · 不调用云端 API' : hasActive ? '当前任务完成后可继续生成，避免重复占用显存' : '点击后将提交真实本地推理任务 · 不调用付费 API';
}

function showToast(message) {
  clearTimeout(state.toastTimer);
  $('toast').textContent = message;
  $('toast').hidden = false;
  state.toastTimer = setTimeout(() => { $('toast').hidden = true; }, 4000);
}

function renderStatus(data) {
  state.status = data;
  const ready = data.ready === true;
  const connected = data.comfy?.connected === true;
  $('connection-banner').classList.toggle('is-ready', ready);
  $('connection-banner').querySelector('.status-light').className = `status-light ${ready ? 'ready' : 'blocked'}`;
  $('connection-title').textContent = ready ? '本地引擎已就绪' : connected ? 'ComfyUI 已连接，生成环境尚未就绪' : '本地 ComfyUI 尚未连接';
  $('connection-description').textContent = data.message || (ready ? '上传参考图并填写提示词，即可提交本地多图参考任务。' : connected ? '请查看下方节点、模型和工作流检查结果。' : '请先启动本机 ComfyUI，然后点击“检查运行环境”。');
  $('connection-label').textContent = ready ? 'READY' : '尚未就绪';
  $('comfy-address').textContent = data.comfy?.url || 'http://127.0.0.1:8188';
  if (!PUBLIC_MODE && data.pairing?.pairCode) { $('local-pair-code').hidden = false; $('local-code-value').textContent = data.pairing.pairCode; }
  const checks = Array.isArray(data.checks) && data.checks.length ? data.checks : [{ label: 'ComfyUI 本地服务', ok: connected, detail: connected ? '连接正常。' : '无法连接本机 ComfyUI。' }];
  const fragment = document.createDocumentFragment();
  for (const check of checks) {
    const row = document.createElement('div'); row.className = 'check-row';
    const icon = document.createElement('span'); icon.className = `check-symbol ${check.ok ? 'ok' : 'fail'}`; icon.textContent = check.ok ? '✓' : '!'; icon.setAttribute('aria-hidden', 'true');
    const body = document.createElement('div');
    const label = document.createElement('strong'); label.textContent = check.label || check.id || '检查项';
    const detail = document.createElement('p'); detail.textContent = check.detail || (check.ok ? '已就绪' : '未就绪');
    body.append(label, detail); row.append(icon, body); fragment.append(row);
  }
  if (data.comfy?.gpu) {
    const row = document.createElement('div'); row.className = 'check-row';
    const icon = document.createElement('span'); icon.className = 'check-symbol pending'; icon.textContent = 'i'; icon.setAttribute('aria-hidden', 'true');
    const body = document.createElement('div');
    const label = document.createElement('strong'); label.textContent = '本机计算设备';
    const detail = document.createElement('p'); detail.textContent = `${Array.isArray(data.comfy.gpu) ? data.comfy.gpu.join(' / ') : data.comfy.gpu}${Number.isFinite(data.comfy.vramMB) ? ` · ${(data.comfy.vramMB / 1024).toFixed(1)} GB 显存` : ''}`;
    body.append(label, detail); row.append(icon, body); fragment.append(row);
  }
  $('environment-checks').replaceChildren(fragment);
  if (!state.draftRestored && data.defaults) {
    for (const key of PARAMS) {
      if (key === 'randomize' && typeof data.defaults[key] === 'boolean') $(key).checked = data.defaults[key];
      else if (ENUM_PARAMS.has(key) && typeof data.defaults[key] === 'string') $(key).value = data.defaults[key];
      else if (key !== 'randomize' && Number.isFinite(data.defaults[key])) $(key).value = data.defaults[key];
    }
    state.draftRestored = true;
  }
  updateParams();
}

async function refreshStatus() {
  if (state.refreshing) return;
  state.refreshing = true;
  $('refresh-status').disabled = true;
  $('refresh-status').classList.add('loading');
  try {
    if (PUBLIC_MODE && !state.pairToken) {
      await api('/api/pair-info');
      renderStatus({ ready: false, comfy: { connected: false }, message: '已找到本机连接器，输入 6 位连接码完成配对。', checks: [{ id: 'pairing', label: '网页与本机引擎配对', ok: false, detail: '在本机连接器页面查看连接码，输入上方连接框。' }] });
      $('connection-title').textContent = '等待连接你的本机引擎';
      return;
    }
    renderStatus(await api('/api/status'));
  }
  catch (error) {
    const detail = PUBLIC_MODE ? `无法连接本机引擎。请运行下载包内的启动脚本，并允许浏览器访问本地网络。${error.message}` : error.message;
    renderStatus({ ready: false, comfy: { connected: false }, message: detail, checks: [{ id: 'web-service', label: PUBLIC_MODE ? '本机连接器' : '网页后端服务', ok: false, detail }] });
  } finally {
    state.refreshing = false;
    $('refresh-status').disabled = false;
    $('refresh-status').classList.remove('loading');
  }
}

function clearImages() {
  state.selection += 1;
  for (const item of state.uploads) if (item.localUrl) URL.revokeObjectURL(item.localUrl);
  state.uploads = [];
  state.uploadBusy = false;
  $('file-input').value = '';
  $('upload-feedback').textContent = '';
  $('upload-feedback').classList.remove('error');
  renderReferences();
  updateSubmit();
}

function renderReferences() {
  $('upload-info').hidden = !state.uploads.length;
  $('drop-zone').classList.toggle('has-references', state.uploads.length > 0);
  $('upload-name').textContent = `${state.uploads.filter((item) => item.id).length} / ${state.uploads.length} 张已保存 · 最多 9 张`;
  const fragment = document.createDocumentFragment();
  state.uploads.forEach((item, index) => {
    const card = document.createElement('article'); card.className = `reference-card ${item.error ? 'has-error' : ''}`;
    const head = document.createElement('div'); head.className = 'reference-card-head';
    const img = document.createElement('img'); if (PUBLIC_MODE && !item.localUrl) img.crossOrigin = 'anonymous'; img.src = item.localUrl || safeLocalUrl(item.url); img.alt = `参考图 ${index + 1}：${item.name}`; img.className = 'reference-thumb';
    const title = document.createElement('div'); title.className = 'reference-title';
    const number = document.createElement('strong'); number.textContent = `参考图 ${index + 1} · <Picture ${index + 1}>`;
    const name = document.createElement('span'); name.textContent = item.name; name.title = item.name;
    const status = document.createElement('small'); status.className = item.error ? 'reference-error' : ''; status.textContent = item.error || (item.id ? `${item.width || '—'} × ${item.height || '—'} · ${formatBytes(item.bytes || 0)}` : '正在保存到本机…');
    title.append(number, name, status);
    const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'icon-button'; remove.textContent = '×'; remove.setAttribute('aria-label', `移除参考图 ${index + 1}`);
    remove.addEventListener('click', () => { if (item.localUrl) URL.revokeObjectURL(item.localUrl); state.uploads = state.uploads.filter((entry) => entry.key !== item.key); state.uploadBusy = state.uploads.some((entry) => entry.pending); renderReferences(); updateSubmit(); });
    head.append(img, title, remove);
    const fields = document.createElement('div'); fields.className = 'reference-fields';
    const roleLabel = document.createElement('label'); roleLabel.textContent = '参考用途';
    const role = document.createElement('select'); role.setAttribute('aria-label', `参考图 ${index + 1} 的用途`);
    for (const value of ['', '人物', '场景', '道具', '风格', '其他']) { const option = document.createElement('option'); option.value = value; option.textContent = value || '请选择（可选）'; role.append(option); }
    role.value = item.label || ''; role.addEventListener('change', () => { item.label = role.value; }); roleLabel.append(role);
    const frameLabel = document.createElement('label'); frameLabel.textContent = '中间帧约束（可选）';
    const frame = document.createElement('input'); frame.className = 'reference-frame'; frame.type = 'number'; frame.min = 1; frame.max = Math.max(1, params().frames - 2); frame.step = 1; frame.placeholder = '默认仅作参考'; frame.value = item.frameIndex ?? ''; frame.setAttribute('aria-label', `参考图 ${index + 1} 的中间帧编号`);
    frame.addEventListener('input', () => { item.frameIndex = frame.value === '' ? null : Number(frame.value); }); frameLabel.append(frame);
    const noteLabel = document.createElement('label'); noteLabel.className = 'reference-note-label'; noteLabel.textContent = '参考说明（可选）';
    const note = document.createElement('input'); note.type = 'text'; note.maxLength = 1000; note.placeholder = '例如：锁定人物外形，沿用服装和材质'; note.value = item.note || ''; note.setAttribute('aria-label', `参考图 ${index + 1} 的说明`); note.addEventListener('input', () => { item.note = note.value; }); noteLabel.append(note);
    fields.append(roleLabel, frameLabel, noteLabel); card.append(head, fields); fragment.append(card);
  });
  $('reference-list').replaceChildren(fragment);
  $('insert-reference-tags').disabled = !state.uploads.length;
}

async function selectImages(files) {
  if (!files?.length) return;
  setFormError('');
  if (PUBLIC_MODE && !state.pairToken) { setFormError('请先使用上方连接码连接本机引擎，再添加参考图。'); $('pair-code').focus(); $('file-input').value = ''; return; }
  const types = ['image/png', 'image/jpeg', 'image/webp'];
  const maxBytes = state.status?.limits?.uploadBytes ?? state.status?.limits?.maxUploadBytes;
  const remaining = 9 - state.uploads.length;
  if (remaining <= 0) { setFormError('每个镜头最多使用 9 张参考图，请先移除不需要的图片。'); return; }
  const selected = Array.from(files).slice(0, remaining);
  if (files.length > remaining) showToast(`最多 9 张参考图，本次只添加前 ${remaining} 张。`);
  const invalid = selected.find((file) => !types.includes(file.type) || !file.size || (Number.isFinite(maxBytes) && file.size > maxBytes));
  if (invalid) { setFormError(`无法添加“${invalid.name}”：请选择非空 PNG、JPG 或 WEBP${Number.isFinite(maxBytes) ? `，单张不超过 ${formatBytes(maxBytes)}` : ''}。`); return; }
  const selection = state.selection;
  const items = selected.map((file) => ({ key: crypto.randomUUID(), name: file.name, localUrl: URL.createObjectURL(file), bytes: file.size, label: '', note: '', frameIndex: null, pending: true, file }));
  state.uploads.push(...items);
  state.uploadBusy = true;
  $('file-input').value = '';
  $('upload-feedback').textContent = '正在将参考图保存到本机，未提交生成任务。';
  renderReferences(); updateSubmit();
  for (const item of items) {
    if (selection !== state.selection) return;
    if (!state.uploads.includes(item)) continue;
    try {
      if (!state.status?.csrfToken) renderStatus(await api('/api/status'));
      if (!state.status?.csrfToken) throw new Error('无法获取本机请求令牌，请检查网页服务后重试。');
      const uploaded = await api('/api/uploads', { method: 'POST', headers: { 'Content-Type': item.file.type, 'X-Filename': encodeURIComponent(item.file.name) }, body: item.file });
      if (!uploaded.id) throw new Error('上传响应缺少图片标识。');
      if (selection !== state.selection || !state.uploads.includes(item)) continue;
      Object.assign(item, uploaded, { pending: false }); delete item.file;
    } catch (error) { item.pending = false; item.error = error.message; delete item.file; }
    if (selection === state.selection) { state.uploadBusy = state.uploads.some((entry) => entry.pending); renderReferences(); updateSubmit(); }
  }
  if (selection !== state.selection) return;
  const failed = state.uploads.filter((item) => item.error).length;
  $('upload-feedback').textContent = failed ? `${failed} 张上传失败，请移除后重新添加。` : '参考图已保存到本机，尚未提交生成任务。';
  $('upload-feedback').classList.toggle('error', failed > 0);
}

function formatBytes(bytes) {
  return bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.ceil(bytes / 1024))} KB`;
}

function safeLocalUrl(value) {
  if (typeof value !== 'string' || !value) return null;
  try {
    const url = new URL(value, `${API_ORIGIN}/`);
    if (url.origin !== API_ORIGIN || !/^https?:$/.test(url.protocol)) return null;
    // This read-only token is restricted to opaque media routes; the full bearer never enters URLs.
    if (PUBLIC_MODE && state.mediaToken && /^\/api\/(?:uploads\/[a-zA-Z0-9-]+|jobs\/[a-zA-Z0-9-]+\/video)$/.test(url.pathname)) url.searchParams.set('media_token', state.mediaToken);
    return url.href;
  } catch { return null; }
}

function renderJob(job) {
  if (!job) return;
  const label = STATUS_LABEL[job.status] || job.status || '未知状态';
  $('output-status').textContent = label;
  $('output-status').className = `neutral-badge ${job.status || ''}`;
  const videoUrl = job.status === 'succeeded' ? safeLocalUrl(job.videoUrl) : null;
  const failed = job.status === 'failed' || job.status === 'blocked';
  $('output-empty').hidden = true;
  $('video-player').hidden = !videoUrl;
  $('job-working').hidden = Boolean(videoUrl);
  $('job-working').classList.toggle('is-error', failed || (job.status === 'succeeded' && !videoUrl));
  $('job-working-title').textContent = job.status === 'succeeded' && !videoUrl ? '任务结束，但暂无可播放视频' : label;
  $('job-working-message').textContent = job.message || (job.status === 'queued' ? '等待本机 ComfyUI 执行任务。' : job.status === 'running' ? '正在本地推理，耗时取决于模型、参数和显卡。' : job.status === 'succeeded' ? '请检查本地输出文件和视频保存节点。' : '任务未完成。请检查运行环境和 ComfyUI 日志。');
  $('job-progress').hidden = failed || job.status === 'succeeded';
  if (Number.isFinite(job.progress)) $('job-progress').value = Math.max(0, Math.min(100, job.progress));
  else $('job-progress').removeAttribute('value'); // An indeterminate bar never invents inference progress.
  if (videoUrl && $('video-player').dataset.currentUrl !== videoUrl) {
    $('video-player').src = videoUrl; $('video-player').dataset.currentUrl = videoUrl;
  } else if (!videoUrl) {
    $('video-player').pause(); $('video-player').removeAttribute('src'); delete $('video-player').dataset.currentUrl;
  }
  const downloadUrl = videoUrl ? safeLocalUrl(job.downloadUrl || job.videoUrl) : null;
  $('download-video').hidden = !downloadUrl;
  if (downloadUrl) $('download-video').href = downloadUrl;
  else $('download-video').removeAttribute('href');
  const p = job.params || {};
  $('output-details').textContent = [p.width && p.height ? `${p.width} × ${p.height}` : null, p.fps ? `${p.fps} fps` : null, p.frames && p.fps ? `${(p.frames / p.fps).toFixed(2)} 秒` : null].filter(Boolean).join(' · ') || label;
  $('output-job-id').textContent = `任务 ${job.id}`;
}

function renderJobs() {
  $('history-count').textContent = String(state.jobs.length);
  if (!state.jobs.length) {
    const empty = document.createElement('p'); empty.className = 'history-empty'; empty.textContent = '还没有生成记录。完成第一个镜头后，会保存在这里。'; $('job-list').replaceChildren(empty); updateSubmit(); return;
  }
  if (!state.jobs.some((job) => job.id === state.selectedId)) state.selectedId = state.jobs[0].id;
  const fragment = document.createDocumentFragment();
  for (const job of state.jobs) {
    const card = document.createElement('button'); card.type = 'button'; card.className = `history-card ${job.id === state.selectedId ? 'selected' : ''}`; card.setAttribute('aria-label', `查看任务：${STATUS_LABEL[job.status] || job.status}，${job.prompt || job.id}`);
    const uploadUrl = safeLocalUrl(job.uploadUrls?.[0] || job.uploadUrl);
    let thumb;
    if (uploadUrl) { thumb = document.createElement('img'); if (PUBLIC_MODE) thumb.crossOrigin = 'anonymous'; thumb.src = uploadUrl; thumb.alt = ''; thumb.loading = 'lazy'; thumb.className = 'history-thumb'; }
    else { thumb = document.createElement('span'); thumb.className = 'history-thumb history-thumb-empty'; thumb.textContent = 'H3'; }
    const body = document.createElement('span'); body.className = 'history-card-body';
    const prompt = document.createElement('span'); prompt.className = 'history-prompt'; prompt.textContent = job.prompt || '图生视频任务';
    const meta = document.createElement('span'); meta.className = 'history-meta'; meta.textContent = `${job.uploadUrls?.length || 0} 张参考 · ${job.params?.width || '—'} × ${job.params?.height || '—'} · ${job.params?.frames || '—'} 帧 · ${job.id}`;
    body.append(prompt, meta);
    const time = document.createElement('span'); time.className = 'history-time'; const date = new Date(job.createdAt); time.textContent = Number.isNaN(date.getTime()) ? '' : date.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
    const badge = document.createElement('span'); badge.className = `neutral-badge ${job.status || ''}`; badge.textContent = STATUS_LABEL[job.status] || job.status;
    card.append(thumb, body, time, badge);
    card.addEventListener('click', () => { state.selectedId = job.id; renderJobs(); });
    fragment.append(card);
  }
  $('job-list').replaceChildren(fragment);
  renderJob(state.jobs.find((job) => job.id === state.selectedId));
  updateSubmit();
}

async function loadJobs() {
  if (PUBLIC_MODE && !state.pairToken) { $('job-list').replaceChildren(Object.assign(document.createElement('p'), { className: 'history-empty', textContent: '连接本机引擎后，将显示当前电脑的任务记录。' })); return; }
  try {
    const data = await api('/api/jobs');
    if (!Array.isArray(data.jobs)) throw new Error('任务列表格式无效。');
    state.jobs = data.jobs.slice().sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    renderJobs();
  } catch (error) {
    if (state.jobs.some((job) => ACTIVE.has(job.status))) showToast(`任务状态暂时无法更新：${error.message}`);
    else if (!state.jobs.length) { const p = document.createElement('p'); p.className = 'history-empty'; p.textContent = `无法读取本地任务：${error.message}`; $('job-list').replaceChildren(p); }
  } finally { schedulePolling(); }
}

function schedulePolling() {
  clearTimeout(state.timer);
  if (state.jobs.some((job) => ACTIVE.has(job.status))) state.timer = setTimeout(loadJobs, 2000);
}

$('generation-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  setFormError('');
  if (!state.status?.ready) { setFormError('本地环境尚未就绪。请先检查节点、模型和工作流。'); return; }
  if (!state.uploads.length || !state.uploads.every((item) => item.id && !item.error)) { setFormError('请上传 1–9 张参考图，并移除上传失败的图片。'); $('drop-zone').focus(); return; }
  if (!$('prompt').value.trim()) { setFormError('请填写视频生成提示词。'); $('prompt').focus(); return; }
  if (state.submitBusy || state.uploadBusy || state.jobs.some((job) => ACTIVE.has(job.status))) return;
  const invalid = [...$('generation-form').querySelectorAll('input[type=number]')].find((input) => !input.disabled && !input.checkValidity());
  if (invalid) { $('advanced-params').open = true; invalid.reportValidity(); return; }
  state.submitBusy = true; updateSubmit(); persistDraft();
  try {
    const references = state.uploads.map((item) => ({ uploadId: item.id, label: item.label || '', note: item.note || '', frameIndex: item.frameIndex ?? null }));
    const data = await api('/api/jobs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ workflow: 'multiframe_reference', uploadIds: state.uploads.map((item) => item.id), references, prompt: $('prompt').value.trim(), params: params() }) });
    if (!data.job?.id) throw new Error('提交响应缺少任务标识。');
    state.jobs = [data.job, ...state.jobs.filter((job) => job.id !== data.job.id)]; state.selectedId = data.job.id; renderJobs(); schedulePolling(); showToast('任务已提交到本地 ComfyUI。');
  } catch (error) {
    setFormError(error.message);
    // A lost HTTP response does not prove ComfyUI rejected the job: re-read before enabling retry.
    await Promise.all([refreshStatus(), loadJobs()]);
  }
  finally { state.submitBusy = false; updateSubmit(); }
});

$('drop-zone').addEventListener('click', (event) => { if (event.target !== $('file-input')) $('file-input').click(); });
$('drop-zone').addEventListener('keydown', (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); $('file-input').click(); } });
$('file-input').addEventListener('change', () => selectImages($('file-input').files));
$('drop-zone').addEventListener('dragover', (event) => { event.preventDefault(); $('drop-zone').classList.add('is-dragover'); });
$('drop-zone').addEventListener('dragleave', () => $('drop-zone').classList.remove('is-dragover'));
$('drop-zone').addEventListener('drop', (event) => { event.preventDefault(); $('drop-zone').classList.remove('is-dragover'); selectImages(event.dataTransfer.files); });
$('remove-image').addEventListener('click', clearImages);
$('insert-reference-tags').addEventListener('click', () => {
  const field = $('prompt');
  const text = state.uploads.map((item, index) => `<Picture ${index + 1}>${item.label ? `（${item.label}）` : ''}`).join('、');
  field.setRangeText(text, field.selectionStart, field.selectionEnd, 'end'); field.focus(); state.draftRestored = true; updateParams(); persistDraft();
});
$('refresh-status').addEventListener('click', async () => { await refreshStatus(); await loadJobs(); });
for (const id of [...PARAMS, 'prompt']) $(id).addEventListener('input', () => { state.draftRestored = true; updateParams(); persistDraft(); });
for (const button of document.querySelectorAll('[data-size]')) button.addEventListener('click', () => { const [w, h] = button.dataset.size.split(','); $('width').value = w; $('height').value = h; state.draftRestored = true; updateParams(); persistDraft(); });
$('quality-preset').addEventListener('change', () => {
  const quality = $('quality-preset').value;
  if (quality === 'custom') return;
  $('width').value = quality === 'experimental' ? 1920 : 1344;
  $('height').value = quality === 'experimental' ? 1088 : 768;
  $('steps').value = quality === 'standard' ? 25 : 50;
  state.draftRestored = true; updateParams(); persistDraft();
});
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') { refreshStatus(); loadJobs(); } });
$('pair-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!PUBLIC_MODE || !$('pair-form').reportValidity()) return;
  $('pair-button').disabled = true; $('pair-message').textContent = '正在连接本机引擎…';
  try {
    const result = await api('/api/pair', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: $('pair-code').value.trim() }) });
    if (!result.token || !result.mediaToken) throw new Error('连接器返回的配对信息不完整。');
    state.pairToken = result.token; state.mediaToken = result.mediaToken;
    try { sessionStorage.setItem(TOKEN_KEY, result.token); sessionStorage.setItem(MEDIA_KEY, result.mediaToken); } catch {}
    $('pair-code').value = ''; $('pair-message').textContent = '已连接。图片、提示词与视频只在当前电脑处理。';
    await Promise.all([refreshStatus(), loadJobs()]);
  } catch (error) { $('pair-message').textContent = `连接失败：${error.message} 请确认本机连接器正在运行，连接码正确，并允许本地网络权限。`; }
  finally { $('pair-button').disabled = false; }
});
$('copy-pair-code').addEventListener('click', async () => { try { await navigator.clipboard.writeText($('local-code-value').textContent); showToast('连接码已复制，请只用于自己的浏览器。'); } catch { showToast('请手动复制页面上的连接码。'); } });
$('download-video').addEventListener('click', async (event) => {
  if (!PUBLIC_MODE) return;
  event.preventDefault();
  const job = state.jobs.find((item) => item.id === state.selectedId);
  const url = job && safeLocalUrl(job.downloadUrl || job.videoUrl);
  if (!url || !state.pairToken) return;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60000);
  try {
    showToast('正在从本机准备下载…');
    const response = await fetch(url, { signal: controller.signal, headers: { Authorization: `Bearer ${state.pairToken}` }, credentials: 'omit', cache: 'no-store' });
    if (!response.ok) throw new Error(`下载失败（${response.status}）`);
    const blobUrl = URL.createObjectURL(await response.blob());
    const anchor = document.createElement('a'); anchor.href = blobUrl; anchor.download = `H3-${job.id}.mp4`; document.body.append(anchor); anchor.click(); anchor.remove(); setTimeout(() => URL.revokeObjectURL(blobUrl), 60000);
  } catch (error) { showToast(controller.signal.aborted ? '视频下载超时。请在本机工作台下载，或检查浏览器本地网络权限。' : error.message); }
  finally { clearTimeout(timer); }
});
$('public-pair-panel').hidden = !PUBLIC_MODE;
if (PUBLIC_MODE) $('video-player').crossOrigin = 'anonymous';
restoreDraft(); renderReferences(); updateParams();
await Promise.all([refreshStatus(), loadJobs()]);
