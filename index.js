import { SECRET_KEYS, writeSecret, deleteSecret } from '../../../secrets.js';

const MODULE_ID = 'api-connection-assistant';
const DEFAULT_SETTINGS = Object.freeze({
    sites: [],
    groups: [],
    activeSiteId: null,
    floatWindowEnabled: false,
    floatWindowPosition: null,
    autoSyncFloat: true,
});
const FETCH_TIMEOUT_MS = 15000;
const DEFAULT_GROUP_NAME = '未分组';
const expandedSiteModels = new Set();
let editorSiteId = null;
let editorModelChoices = [];
let activeGroupFilter = 'all';

function getContext() {
    const context = globalThis.SillyTavern?.getContext?.();
    if (!context) {
        throw new Error('SillyTavern context is unavailable');
    }
    return context;
}

function getSettings() {
    const context = getContext();
    const current = context.extensionSettings[MODULE_ID] ?? {};
    const settings = { ...DEFAULT_SETTINGS, ...current };
    if (!Array.isArray(settings.sites)) settings.sites = [];
    if (!Array.isArray(settings.groups)) settings.groups = [];
    if (!settings.floatWindowPosition || typeof settings.floatWindowPosition !== 'object') settings.floatWindowPosition = null;
    for (const site of settings.sites) {
        if (!Array.isArray(site.keys)) site.keys = [];
        if (!Array.isArray(site.secretIds)) site.secretIds = [];
        if (!Array.isArray(site.models)) site.models = [];
        if (!Number.isFinite(site.activeKeyIndex)) site.activeKeyIndex = 0;
    }
    context.extensionSettings[MODULE_ID] = settings;
    return settings;
}

function saveSettings() {
    getContext().saveSettingsDebounced?.();
}

function getSites() {
    return getSettings().sites;
}

function findSiteById(siteId) {
    return getSites().find((site) => site.id === siteId) ?? null;
}

function getGroupName(groupId) {
    if (!groupId) return DEFAULT_GROUP_NAME;
    const group = getSettings().groups.find((item) => item.id === groupId);
    return group?.name ?? DEFAULT_GROUP_NAME;
}

function parseMultiValues(text) {
    return String(text ?? '')
        .split(/[\n,，;；]/)
        .map((item) => item.trim())
        .filter((item) => item.length > 0);
}

function uniqueValues(values) {
    return [...new Set(values)];
}

function escapeHtml(value) {
    return String(value ?? '')
        .replaceAll('&', '&#38;')
        .replaceAll('<', '&#60;')
        .replaceAll('>', '&#62;')
        .replaceAll('"', '&#34;')
        .replaceAll("'", '&#39;');
}

function formatTime(timestamp) {
    if (!timestamp) return '从未使用';
    return new Date(timestamp).toLocaleString();
}

function normalizeApiUrl(apiUrl) {
    return String(apiUrl ?? '').trim().replace(/\/+$/, '');
}

function showStatus(message, isError = false) {
    const status = document.getElementById('aca-editor-status');
    if (status) {
        status.textContent = message;
        status.classList.toggle('is-error', isError);
    }
    if (isError) toastr?.error?.(message, 'API 连接助手');
}

async function ensureKeySecret(site, keyIndex) {
    const key = site.keys?.[keyIndex];
    if (!key) throw new Error('这个站点缺少密钥，请先编辑填写 API Key。');
    if (site.secretIds?.[keyIndex]) return site.secretIds[keyIndex];
    const secretId = await writeSecret(SECRET_KEYS.CUSTOM, key, `${site.name} #${keyIndex + 1}`);
    if (!secretId) throw new Error('写入酒馆密钥库失败。');
    site.secretIds[keyIndex] = secretId;
    saveSettings();
    return secretId;
}

async function runCommand(name, args, value) {
    const command = getContext().SlashCommandParser?.commands?.[name];
    if (!command) throw new Error(`当前酒馆缺少 /${name} 命令。`);
    return command.callback(args ?? {}, value ?? '');
}

async function applySite(siteId, model) {
    const site = findSiteById(siteId);
    if (!site) throw new Error('找不到这个站点。');
    if (site.models.length > 0) {
        site.model = model ?? site.model ?? site.models[0];
    } else if (model) {
        site.model = model;
    }
    const secretId = await ensureKeySecret(site, site.activeKeyIndex);
    await runCommand('api', { quiet: 'true' }, 'custom');
    await runCommand('secret-id', { quiet: 'true', key: SECRET_KEYS.CUSTOM }, secretId);
    await runCommand('api-url', { api: 'custom', connect: 'true', quiet: 'true' }, normalizeApiUrl(site.apiUrl));
    if (site.model) await runCommand('model', { quiet: 'true' }, site.model);
    site.lastUsedAt = Date.now();
    const settings = getSettings();
    settings.activeSiteId = site.id;
    saveSettings();
    renderAll();
    return site;
}

async function rotateKey(siteId) {
    const site = findSiteById(siteId);
    if (!site) throw new Error('找不到这个站点。');
    if (site.keys.length < 2) throw new Error('这个站点只有一个密钥。');
    site.activeKeyIndex = (site.activeKeyIndex + 1) % site.keys.length;
    saveSettings();
    await applySite(siteId);
    toastr?.info?.(`已切换到第 ${site.activeKeyIndex + 1} 把密钥`, 'API 连接助手');
}

async function fetchModels(siteId) {
    const site = findSiteById(siteId);
    if (!site) throw new Error('找不到这个站点。');
    const key = site.keys?.[site.activeKeyIndex];
    if (!key) throw new Error('请先为站点填写 API Key。');
    const modelsUrl = `${normalizeApiUrl(site.apiUrl)}/models`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
        const response = await fetch(modelsUrl, {
            method: 'GET',
            headers: { Authorization: `Bearer ${key}` },
            signal: controller.signal,
        });
        if (!response.ok) throw new Error(`站点返回 HTTP ${response.status}`);
        const data = await response.json();
        const models = uniqueValues(Array.isArray(data?.data)
            ? data.data.map((item) => item?.id).filter((id) => typeof id === 'string' && id.length > 0)
            : []);
        site.models = models;
        if (site.models.length > 0 && !site.model) site.model = site.models[0];
        saveSettings();
        return models;
    } catch (error) {
        if (error?.name === 'AbortError') throw new Error(`超过 ${FETCH_TIMEOUT_MS / 1000} 秒未响应`);
        if (error instanceof TypeError) throw new Error('无法访问站点：可能是跨域限制或网络问题。可手动填写模型 ID。');
        throw error;
    } finally {
        clearTimeout(timeoutId);
    }
}

async function runFetchModels(siteId, button) {
    const originalText = button?.textContent ?? '';
    if (button) button.disabled = true;
    if (button) button.textContent = '获取中…';
    try {
        const models = await fetchModels(siteId);
        renderAll();
        if (editorSiteId === siteId) {
            editorModelChoices = findSiteById(siteId)?.models ?? [];
            document.getElementById('aca-editor-models').value = editorModelChoices.join('\n');
        }
        toastr?.success?.(models.length > 0 ? `获取到 ${models.length} 个模型` : '站点未返回模型列表，可手动填写', 'API 连接助手');
    } catch (error) {
        renderAll();
        toastr?.warning?.(error?.message ?? String(error), 'API 连接助手');
    } finally {
        if (button) {
            button.disabled = false;
            button.textContent = originalText;
        }
    }
}

function renderGroupFilter() {
    const container = document.getElementById('aca-group-filter');
    if (!container) return;
    const settings = getSettings();
    const groups = [{ id: 'all', name: '全部' }, ...settings.groups];
    container.innerHTML = groups.map((group) => {
        const activeClass = activeGroupFilter === group.id ? ' is-active' : '';
        return `<button type="button" class="aca-group-chip${activeClass}" data-group-id="${escapeHtml(group.id)}">${escapeHtml(group.name)}</button>`;
    }).join('');
}

function getVisibleSites() {
    const settings = getSettings();
    if (activeGroupFilter === 'all') return settings.sites;
    return settings.sites.filter((site) => (site.groupId ?? '') === activeGroupFilter);
}

function renderSiteList() {
    const container = document.getElementById('aca-site-list');
    if (!container) return;
    const settings = getSettings();
    const sites = getVisibleSites();
    if (settings.sites.length === 0) {
        container.innerHTML = '<div class="aca-empty">还没有站点，点下面的「新增站点」添加。</div>';
        return;
    }
    if (sites.length === 0) {
        container.innerHTML = '<div class="aca-empty">这个分组下没有站点。</div>';
        return;
    }
    container.innerHTML = sites.map((site) => {
        const activeClass = site.id === settings.activeSiteId ? ' is-active' : '';
        const modelCount = site.models.length;
        const keyOk = site.keys.length > 0;
        const models = site.models.length > 0 ? site.models : (site.model ? [site.model] : []);
        const modelRows = models.length > 0
            ? models.map((model) => `<button type="button" class="aca-site-model${model === site.model ? ' is-active' : ''}" data-model="${escapeHtml(model)}" title="${escapeHtml(model)}">${escapeHtml(model)}</button>`).join('')
            : '<span class="aca-empty">暂无模型，点「模型」获取或手动填写</span>';
        return `
            <div class="aca-site-card${activeClass}" data-site-id="${escapeHtml(site.id)}">
                <div class="aca-site-badges">
                    <span class="aca-badge">${modelCount} MODELS</span>
                    <span class="aca-badge ${keyOk ? 'is-ok' : 'is-off'}">${keyOk ? 'KEY ✓' : 'KEY ✗'}</span>
                    ${site.keys.length > 1 ? `<span class="aca-badge">KEY ${site.activeKeyIndex + 1}/${site.keys.length}</span>` : ''}
                </div>
                <div class="aca-site-models">${modelRows}</div>
                <div class="aca-site-meta">
                    <span title="最近使用">🕐 ${escapeHtml(formatTime(site.lastUsedAt))}</span>
                    <span title="分组">📍 ${escapeHtml(getGroupName(site.groupId))}</span>
                </div>
                <div class="aca-site-actions">
                    <button type="button" class="aca-action-primary" data-action="apply" title="使用这个站点"><i class="fa-solid fa-plug"></i> 使用</button>
                    <button type="button" class="aca-action-button" data-action="models" title="获取 / 刷新模型"><i class="fa-solid fa-layer-group"></i> 模型</button>
                    <button type="button" class="aca-action-button" data-action="rotate" title="切换到下一把密钥"><i class="fa-solid fa-key"></i></button>
                    <button type="button" class="aca-action-button" data-action="edit" title="编辑"><i class="fa-solid fa-pen"></i></button>
                    <button type="button" class="aca-action-button" data-action="delete" title="删除"><i class="fa-solid fa-trash"></i></button>
                </div>
            </div>
        `;
    }).join('');
}

function renderEditorGroupSelect() {
    const select = document.getElementById('aca-editor-group');
    if (!select) return;
    const settings = getSettings();
    const site = editorSiteId ? findSiteById(editorSiteId) : null;
    const options = ['<option value="">未分组</option>'];
    for (const group of settings.groups) {
        const selected = site?.groupId === group.id ? ' selected' : '';
        options.push(`<option value="${escapeHtml(group.id)}"${selected}>${escapeHtml(group.name)}</option>`);
    }
    select.innerHTML = options.join('');
}

function renderEditor() {
    if (!editorSiteId) {
        editorModelChoices = [];
        return;
    }
    const site = findSiteById(editorSiteId);
    if (!site) return;
    if (editorModelChoices.length === 0 && site.models.length > 0) editorModelChoices = site.models;
    renderEditorGroupSelect();
}

function renderApiEntry() {
    const select = document.getElementById('aca-api-select');
    const status = document.getElementById('aca-api-result');
    if (!select || !status) return;
    const settings = getSettings();
    if (settings.sites.length === 0) {
        select.innerHTML = '<option value="">暂无站点</option>';
        status.innerHTML = '';
        return;
    }
    select.innerHTML = settings.sites
        .map((site) => `<option value="${escapeHtml(site.id)}"${site.id === settings.activeSiteId ? ' selected' : ''}>${escapeHtml(site.name)}</option>`)
        .join('');
    const site = settings.sites.find((item) => item.id === settings.activeSiteId);
    status.innerHTML = site ? `<span class="aca-api-model">${escapeHtml(site.model || '未设模型')}</span>` : '';
}

function renderModelChips(site) {
    if (!expandedSiteModels.has(site.id)) return '';
    const models = site.models.length > 0 ? site.models : (site.model ? [site.model] : []);
    if (models.length === 0) return '<div class="aca-model-chips"><span class="aca-empty">暂无模型</span></div>';
    const chips = models.map((model) => `<button type="button" class="aca-model-chip" data-model="${escapeHtml(model)}" title="${escapeHtml(model)}">${escapeHtml(model)}</button>`).join('');
    return `<div class="aca-model-chips">${chips}</div>`;
}

function renderFloatWindow() {
    const ball = document.getElementById('aca-float-ball');
    const floatRoot = document.getElementById('aca-float-root');
    const list = document.getElementById('aca-float-list');
    if (!ball || !floatRoot || !list) return;
    const settings = getSettings();
    const enabled = settings.floatWindowEnabled;
    ball.classList.toggle('hidden', !enabled);
    floatRoot.classList.toggle('hidden', !enabled);
    if (!enabled) return;
    const position = settings.floatWindowPosition;
    if (position && Number.isFinite(position.x) && Number.isFinite(position.y)) {
        floatRoot.style.left = `${Math.max(0, position.x)}px`;
        floatRoot.style.top = `${Math.max(0, position.y)}px`;
        floatRoot.style.right = 'auto';
    }
    if (settings.sites.length === 0) {
        list.innerHTML = '<div class="aca-empty">暂无站点</div>';
        return;
    }
    list.innerHTML = settings.sites.map((site) => `
        <div class="aca-float-item${site.id === settings.activeSiteId ? ' is-active' : ''}" data-site-id="${escapeHtml(site.id)}">
            <div class="aca-float-row">
                <button type="button" class="aca-float-name" title="${escapeHtml(site.name)}">${escapeHtml(site.name)}</button>
                <span class="aca-float-model" title="${escapeHtml(site.model)}">${escapeHtml(site.model || '未设模型')}</span>
                <button type="button" class="aca-action-button" data-action="models" title="展开 / 收起模型">模</button>
            </div>
            ${renderModelChips(site)}
        </div>
    `).join('');
}

function renderAll() {
    renderGroupFilter();
    renderSiteList();
    renderApiEntry();
    renderFloatWindow();
    renderEditor();
}


function openEditor(siteId) {
    editorSiteId = siteId;
    const editor = document.getElementById('aca-editor');
    if (!editor) return;
    const site = siteId ? findSiteById(siteId) : null;
    editorModelChoices = site?.models ?? [];
    document.getElementById('aca-editor-title').textContent = site ? `编辑：${site.name}` : '新增站点';
    document.getElementById('aca-editor-name').value = site?.name ?? '';
    document.getElementById('aca-editor-url').value = site?.apiUrl ?? '';
    document.getElementById('aca-editor-key').value = '';
    document.getElementById('aca-editor-key').placeholder = site ? '留空表示不修改密钥' : 'sk-...';
    document.getElementById('aca-editor-models').value = (site?.models ?? []).join('\n');
    document.getElementById('aca-editor-delete').classList.toggle('hidden', !site);
    renderEditorGroupSelect();
    showStatus('');
    editor.classList.remove('hidden');
    editor.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function closeEditor() {
    editorSiteId = null;
    editorModelChoices = [];
    document.getElementById('aca-editor')?.classList.add('hidden');
}

async function saveEditor() {
    const name = document.getElementById('aca-editor-name')?.value?.trim();
    const apiUrl = normalizeApiUrl(document.getElementById('aca-editor-url')?.value);
    const keys = uniqueValues(parseMultiValues(document.getElementById('aca-editor-key')?.value));
    const models = uniqueValues(parseMultiValues(document.getElementById('aca-editor-models')?.value));
    const groupId = document.getElementById('aca-editor-group')?.value ?? '';
    if (!name) {
        showStatus('请填写站点名称。', true);
        return;
    }
    if (!apiUrl) {
        showStatus('请填写 API URL。', true);
        return;
    }
    if (!/^https?:\/\//i.test(apiUrl)) {
        showStatus('API URL 必须以 http:// 或 https:// 开头。', true);
        return;
    }
    const settings = getSettings();
    let site = editorSiteId ? findSiteById(editorSiteId) : null;
    if (!site && keys.length === 0) {
        showStatus('新增站点时必须填写 API Key。', true);
        return;
    }
    try {
        if (!site) {
            site = {
                id: crypto.randomUUID(),
                name,
                apiUrl,
                keys,
                secretIds: [],
                activeKeyIndex: 0,
                models,
                model: models[0] ?? '',
                groupId: groupId || '',
                lastUsedAt: null,
            };
            settings.sites.push(site);
            await ensureKeySecret(site, 0);
        } else {
            const oldSecretIds = site.secretIds;
            site.name = name;
            site.apiUrl = apiUrl;
            site.models = models;
            site.model = models[0] ?? '';
            site.groupId = groupId || '';
            if (keys.length > 0) {
                site.keys = keys;
                site.secretIds = [];
                site.activeKeyIndex = 0;
                await ensureKeySecret(site, 0);
                for (const oldId of oldSecretIds) {
                    if (typeof oldId === 'string' && oldId.length > 0) {
                        await deleteSecret(SECRET_KEYS.CUSTOM, oldId);
                    }
                }
            }
        }
        saveSettings();
        closeEditor();
        renderAll();
        toastr?.success?.(`已保存「${site.name}」`, 'API 连接助手');
    } catch (error) {
        showStatus(error?.message ?? String(error), true);
    }
}

async function deleteSite(siteId) {
    const site = findSiteById(siteId);
    if (!site) return;
    if (!window.confirm(`确定删除「${site.name}」吗？这会同时删除它在酒馆密钥库中的密钥。`)) return;
    try {
        for (const secretId of site.secretIds) {
            if (typeof secretId === 'string' && secretId.length > 0) {
                await deleteSecret(SECRET_KEYS.CUSTOM, secretId);
            }
        }
    } catch (error) {
        toastr?.warning?.(`删除密钥失败：${error?.message ?? String(error)}`, 'API 连接助手');
    }
    const settings = getSettings();
    settings.sites = settings.sites.filter((item) => item.id !== siteId);
    if (settings.activeSiteId === siteId) settings.activeSiteId = null;
    expandedSiteModels.delete(siteId);
    saveSettings();
    if (editorSiteId === siteId) closeEditor();
    renderAll();
}

function createGroup() {
    const rawName = window.prompt('新分组名称：');
    const name = String(rawName ?? '').trim();
    if (!name) return;
    const settings = getSettings();
    if (settings.groups.some((group) => group.name === name)) {
        toastr?.warning?.('已存在同名分组。', 'API 连接助手');
        return;
    }
    settings.groups.push({ id: crypto.randomUUID(), name });
    saveSettings();
    renderGroupFilter();
    renderEditorGroupSelect();
}

function exportSites() {
    const settings = getSettings();
    const includeKeys = document.getElementById('aca-export-keys')?.checked ?? false;
    const payload = {
        schema: 'api-connection-assistant',
        version: 1,
        exportedAt: new Date().toISOString(),
        groups: settings.groups,
        sites: settings.sites.map((site) => ({
            name: site.name,
            apiUrl: site.apiUrl,
            model: site.model,
            models: site.models,
            groupId: site.groupId,
            ...(includeKeys ? { keys: site.keys } : {}),
        })),
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const now = new Date();
    const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}-${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}`;
    const link = document.createElement('a');
    link.href = url;
    link.download = `api-connection-assistant-${stamp}.json`;
    document.body.append(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    toastr?.success?.(includeKeys ? '已导出（包含密钥，请妥善保管）' : '已导出（不含密钥）', 'API 连接助手');
}

async function importSites(file) {
    let payload = null;
    try {
        const text = await file.text();
        payload = JSON.parse(text);
    } catch {
        toastr?.error?.('导入失败：文件不是合法 JSON。', 'API 连接助手');
        return;
    }
    const sites = Array.isArray(payload?.sites) ? payload.sites : [];
    const groups = Array.isArray(payload?.groups) ? payload.groups : [];
    if (sites.length === 0 && groups.length === 0) {
        toastr?.warning?.('文件里没有可导入的站点或分组。', 'API 连接助手');
        return;
    }
    const settings = getSettings();
    let addedSites = 0;
    let addedGroups = 0;
    const groupNameToId = new Map(settings.groups.map((group) => [group.name, group.id]));
    for (const group of groups) {
        const name = String(group?.name ?? '').trim();
        if (!name || groupNameToId.has(name)) continue;
        const id = crypto.randomUUID();
        settings.groups.push({ id, name });
        groupNameToId.set(name, id);
        addedGroups += 1;
    }
    for (const site of sites) {
        const name = String(site?.name ?? '').trim();
        const apiUrl = normalizeApiUrl(site?.apiUrl);
        if (!name || !apiUrl) continue;
        const keys = uniqueValues(parseMultiValues(site?.keys));
        const models = uniqueValues([...(Array.isArray(site?.models) ? site.models : []), ...(site?.model ? [site.model] : [])]);
        const existing = settings.sites.find((item) => item.name === name && normalizeApiUrl(item.apiUrl) === apiUrl);
        const groupId = site?.groupId && groupNameToId.has(String(site.groupId)) ? site.groupId : (groupNameToId.get(String(site?.groupId ?? '')) ?? '');
        if (existing) {
            existing.models = models.length > 0 ? models : existing.models;
            existing.model = models[0] ?? existing.model;
            existing.groupId = groupId || existing.groupId;
            if (keys.length > 0) {
                for (const oldId of existing.secretIds) {
                    if (typeof oldId === 'string' && oldId.length > 0) {
                        await deleteSecret(SECRET_KEYS.CUSTOM, oldId);
                    }
                }
                existing.keys = keys;
                existing.secretIds = [];
                existing.activeKeyIndex = 0;
                await ensureKeySecret(existing, 0);
            }
        } else {
            const newSite = {
                id: crypto.randomUUID(),
                name,
                apiUrl,
                keys,
                secretIds: [],
                activeKeyIndex: 0,
                models,
                model: models[0] ?? '',
                groupId,
                lastUsedAt: null,
            };
            settings.sites.push(newSite);
            if (keys.length > 0) await ensureKeySecret(newSite, 0);
            addedSites += 1;
        }
    }
    saveSettings();
    renderAll();
    toastr?.success?.(`导入完成：新增 ${addedSites} 个站点、${addedGroups} 个分组`, 'API 连接助手');
}

function makeFloatDraggable(floatRoot) {
    const header = floatRoot.querySelector('.aca-float-header');
    if (!header) return;
    let dragging = false;
    let offsetX = 0;
    let offsetY = 0;

    const clampToViewport = (x, y) => ({
        x: Math.min(Math.max(0, x), Math.max(0, window.innerWidth - floatRoot.offsetWidth)),
        y: Math.min(Math.max(0, y), Math.max(0, window.innerHeight - floatRoot.offsetHeight)),
    });

    header.addEventListener('pointerdown', (event) => {
        if (event.target.closest('button')) return;
        const rect = floatRoot.getBoundingClientRect();
        offsetX = event.clientX - rect.left;
        offsetY = event.clientY - rect.top;
        dragging = true;
        try {
            header.setPointerCapture(event.pointerId);
        } catch {
            /* pointer capture is best-effort */
        }
    });
    header.addEventListener('pointermove', (event) => {
        if (!dragging) return;
        const { x, y } = clampToViewport(event.clientX - offsetX, event.clientY - offsetY);
        floatRoot.style.left = `${x}px`;
        floatRoot.style.top = `${y}px`;
        floatRoot.style.right = 'auto';
    });
    const finishDrag = (event) => {
        if (!dragging) return;
        dragging = false;
        try {
            header.releasePointerCapture(event.pointerId);
        } catch {
            /* pointer capture is best-effort */
        }
        const rect = floatRoot.getBoundingClientRect();
        const settings = getSettings();
        settings.floatWindowPosition = { x: rect.left, y: rect.top };
        saveSettings();
    };
    header.addEventListener('pointerup', finishDrag);
    header.addEventListener('pointercancel', finishDrag);
}

function makeBallDraggable(ball, floatRoot) {
    let dragging = false;
    let moved = false;
    let offsetX = 0;
    let offsetY = 0;
    const clamp = (x, y) => ({
        x: Math.min(Math.max(0, x), Math.max(0, window.innerWidth - ball.offsetWidth)),
        y: Math.min(Math.max(0, y), Math.max(0, window.innerHeight - ball.offsetHeight)),
    });
    ball.addEventListener('pointerdown', (event) => {
        const rect = ball.getBoundingClientRect();
        offsetX = event.clientX - rect.left;
        offsetY = event.clientY - rect.top;
        dragging = true;
        moved = false;
        try {
            ball.setPointerCapture(event.pointerId);
        } catch {
            /* pointer capture is best-effort */
        }
    });
    ball.addEventListener('pointermove', (event) => {
        if (!dragging) return;
        const { x, y } = clamp(event.clientX - offsetX, event.clientY - offsetY);
        ball.style.left = `${x}px`;
        ball.style.top = `${y}px`;
        ball.style.right = 'auto';
        if (Math.abs(event.movementX) + Math.abs(event.movementY) > 1) moved = true;
    });
    const finishDrag = (event) => {
        if (!dragging) return;
        dragging = false;
        try {
            ball.releasePointerCapture(event.pointerId);
        } catch {
            /* pointer capture is best-effort */
        }
        if (moved) {
            const rect = ball.getBoundingClientRect();
            const settings = getSettings();
            settings.floatWindowPosition = { x: rect.left, y: rect.top };
            floatRoot.style.left = `${rect.left + 36}px`;
            floatRoot.style.top = `${rect.top + 36}px`;
            floatRoot.style.right = 'auto';
            saveSettings();
        }
    };
    ball.addEventListener('pointerup', (event) => {
        if (moved) {
            finishDrag(event);
            return;
        }
        dragging = false;
        floatRoot.classList.toggle('hidden');
    });
    ball.addEventListener('pointercancel', finishDrag);
}

function createFloatWindow() {
    const ball = document.createElement('button');
    ball.id = 'aca-float-ball';
    ball.type = 'button';
    ball.title = 'API 连接助手（可拖动）';
    ball.textContent = '⚡';
    ball.classList.add('hidden');

    const floatRoot = document.createElement('div');
    floatRoot.id = 'aca-float-root';
    floatRoot.dataset.extensionId = MODULE_ID;
    floatRoot.classList.add('hidden');
    floatRoot.innerHTML = `
        <div class="aca-float-header">
            <span>API 快切（按住拖动）</span>
            <button type="button" class="aca-float-close" title="收起">×</button>
        </div>
        <div id="aca-float-list"></div>
    `;
    floatRoot.querySelector('.aca-float-close')?.addEventListener('click', () => {
        floatRoot.classList.add('hidden');
    });
    floatRoot.addEventListener('click', async (event) => {
        const button = event.target.closest('button');
        const item = event.target.closest('.aca-float-item');
        if (!item) return;
        const siteId = item.dataset.siteId;
        const site = findSiteById(siteId);
        if (!site) return;
        if (button?.classList.contains('aca-float-name')) {
            try {
                await applySite(siteId);
                toastr?.success?.(`已切换到「${site.name}」`, 'API 连接助手');
            } catch (error) {
                toastr?.error?.(error?.message ?? String(error), 'API 连接助手');
            }
            return;
        }
        if (button?.classList.contains('aca-model-chip')) {
            try {
                await applySite(siteId, button.dataset.model);
                toastr?.success?.(`已切换到「${site.name}」的 ${button.dataset.model}`, 'API 连接助手');
            } catch (error) {
                toastr?.error?.(error?.message ?? String(error), 'API 连接助手');
            }
            return;
        }
        if (button?.dataset.action === 'models') {
            if (expandedSiteModels.has(siteId)) expandedSiteModels.delete(siteId);
            else expandedSiteModels.add(siteId);
            renderFloatWindow();
        }
    });
    makeFloatDraggable(floatRoot);
    makeBallDraggable(ball, floatRoot);
    document.body.append(ball, floatRoot);
}

function createApiEntry() {
    const anchor = document.querySelector('#main-API-selector-block');
    const mount = document.querySelector('#rm_api_block');
    if (!mount || !anchor) return;
    if (document.getElementById('aca-api-entry')) return;
    const entry = document.createElement('div');
    entry.id = 'aca-api-entry';
    entry.dataset.extensionId = MODULE_ID;
    entry.innerHTML = `
        <div class="aca-api-title">API 连接助手</div>
        <div class="aca-api-controls">
            <select id="aca-api-select"></select>
            <button type="button" id="aca-api-apply" class="aca-action-primary" title="使用这个站点"><i class="fa-solid fa-plug"></i> 应用</button>
            <button type="button" id="aca-api-fetch" class="aca-action-button" title="获取 / 刷新模型">模型</button>
            <span id="aca-api-result"></span>
        </div>
    `;
    entry.querySelector('#aca-api-apply')?.addEventListener('click', async () => {
        const siteId = document.getElementById('aca-api-select')?.value;
        if (!siteId) return;
        try {
            const site = await applySite(siteId);
            toastr?.success?.(`已切换到「${site.name}」`, 'API 连接助手');
        } catch (error) {
            toastr?.error?.(error?.message ?? String(error), 'API 连接助手');
        }
    });
    entry.querySelector('#aca-api-fetch')?.addEventListener('click', async (event) => {
        const siteId = document.getElementById('aca-api-select')?.value;
        if (!siteId) return;
        await runFetchModels(siteId, event.currentTarget);
    });
    anchor.after(entry);
}

function migrateLegacyProfiles() {
    const context = getContext();
    const legacy = context.extensionSettings[MODULE_ID]?.profiles;
    if (!Array.isArray(legacy) || legacy.length === 0) return;
    const settings = getSettings();
    for (const profile of legacy) {
        if (!profile || settings.sites.some((site) => site.name === profile.name)) continue;
        const models = Array.isArray(profile.models) ? profile.models : (profile.model ? [profile.model] : []);
        settings.sites.push({
            id: typeof profile.id === 'string' ? profile.id : crypto.randomUUID(),
            name: String(profile.name ?? '未命名站点'),
            apiUrl: String(profile.apiUrl ?? ''),
            keys: profile.apiKey ? [String(profile.apiKey)] : [],
            secretIds: profile.secretId ? [String(profile.secretId)] : [],
            activeKeyIndex: 0,
            models,
            model: profile.model ?? models[0] ?? '',
            groupId: '',
            lastUsedAt: null,
        });
    }
    delete context.extensionSettings[MODULE_ID].profiles;
    if (context.extensionSettings[MODULE_ID].activeProfileId && !settings.activeSiteId) {
        settings.activeSiteId = context.extensionSettings[MODULE_ID].activeProfileId;
    }
    delete context.extensionSettings[MODULE_ID].activeProfileId;
    saveSettings();
}

async function onActivate() {
    const context = getContext();
    const settings = getSettings();
    activeGroupFilter = 'all';
    migrateLegacyProfiles();
    if (!document.getElementById('aca-settings-root')) {
        const settingsHtml = await context.renderExtensionTemplateAsync('third-party/api-connection-assistant', 'settings', {});
        $('#extensions_settings2').append(settingsHtml);
    }
    if (!document.getElementById('aca-float-ball')) createFloatWindow();
    createApiEntry();

    const floatToggle = document.getElementById('aca-float-window-enabled');
    if (floatToggle) {
        floatToggle.checked = settings.floatWindowEnabled;
        floatToggle.addEventListener('change', () => {
            const currentSettings = getSettings();
            currentSettings.floatWindowEnabled = floatToggle.checked;
            saveSettings();
            renderFloatWindow();
            if (!floatToggle.checked) toastr?.info?.('悬浮窗已关闭，可随时在设置里打开', 'API 连接助手');
        });
    }
    const autoSync = document.getElementById('aca-auto-sync');
    if (autoSync) {
        autoSync.checked = settings.autoSyncFloat;
        autoSync.addEventListener('change', () => {
            const currentSettings = getSettings();
            currentSettings.autoSyncFloat = autoSync.checked;
            saveSettings();
        });
    }
    document.getElementById('aca-add-site')?.addEventListener('click', () => openEditor(null));
    document.getElementById('aca-editor-save')?.addEventListener('click', saveEditor);
    document.getElementById('aca-editor-cancel')?.addEventListener('click', closeEditor);
    document.getElementById('aca-editor-delete')?.addEventListener('click', () => {
        if (editorSiteId) deleteSite(editorSiteId);
    });
    document.getElementById('aca-editor-new-group')?.addEventListener('click', createGroup);
    document.getElementById('aca-editor-fetch-models')?.addEventListener('click', async (event) => {
        const siteId = editorSiteId;
        if (!siteId) {
            const url = normalizeApiUrl(document.getElementById('aca-editor-url')?.value);
            const key = parseMultiValues(document.getElementById('aca-editor-key')?.value)[0];
            if (!url || !key) {
                showStatus('请先填写 API URL 和 API Key，再获取模型。', true);
                return;
            }
            showStatus('正在获取模型…');
            try {
                const modelsUrl = `${normalizeApiUrl(url)}/models`;
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
                const response = await fetch(modelsUrl, {
                    method: 'GET',
                    headers: { Authorization: `Bearer ${key}` },
                    signal: controller.signal,
                });
                clearTimeout(timeoutId);
                if (!response.ok) throw new Error(`站点返回 HTTP ${response.status}`);
                const data = await response.json();
                const models = uniqueValues(Array.isArray(data?.data)
                    ? data.data.map((item) => item?.id).filter((id) => typeof id === 'string' && id.length > 0)
                    : []);
                editorModelChoices = models;
                document.getElementById('aca-editor-models').value = models.join('\n');
                showStatus(models.length > 0 ? `获取到 ${models.length} 个模型` : '站点未返回模型列表，可手动填写');
            } catch (error) {
                showStatus(error?.name === 'AbortError' ? '请求超时' : (error?.message ?? String(error)), true);
            }
            return;
        }
        await runFetchModels(siteId, event.currentTarget);
        editorModelChoices = findSiteById(siteId)?.models ?? [];
        document.getElementById('aca-editor-models').value = editorModelChoices.join('\n');
    });
    document.getElementById('aca-export')?.addEventListener('click', exportSites);
    document.getElementById('aca-import')?.addEventListener('click', () => document.getElementById('aca-import-file')?.click());
    document.getElementById('aca-import-file')?.addEventListener('change', async (event) => {
        const file = event.target?.files?.[0];
        if (file) await importSites(file);
        event.target.value = '';
    });

    document.getElementById('aca-site-list')?.addEventListener('click', async (event) => {
        const button = event.target.closest('button[data-action]');
        if (!button) {
            const modelButton = event.target.closest('button.aca-site-model');
            if (modelButton) {
                const siteId = modelButton.closest('.aca-site-card')?.dataset.siteId;
                if (!siteId) return;
                try {
                    await applySite(siteId, modelButton.dataset.model);
                    toastr?.success?.(`已切换到 ${modelButton.dataset.model}`, 'API 连接助手');
                } catch (error) {
                    toastr?.error?.(error?.message ?? String(error), 'API 连接助手');
                }
            }
            return;
        }
        const siteId = button.closest('.aca-site-card')?.dataset.siteId;
        if (!siteId) return;
        const action = button.dataset.action;
        if (action === 'apply') {
            try {
                const site = await applySite(siteId);
                toastr?.success?.(`已切换到「${site.name}」`, 'API 连接助手');
            } catch (error) {
                toastr?.error?.(error?.message ?? String(error), 'API 连接助手');
            }
            return;
        }
        if (action === 'models') {
            await runFetchModels(siteId, button);
            return;
        }
        if (action === 'rotate') {
            try {
                await rotateKey(siteId);
            } catch (error) {
                toastr?.warning?.(error?.message ?? String(error), 'API 连接助手');
            }
            return;
        }
        if (action === 'edit') openEditor(siteId);
        if (action === 'delete') deleteSite(siteId);
    });
    document.getElementById('aca-group-filter')?.addEventListener('click', (event) => {
        const chip = event.target.closest('button.aca-group-chip');
        if (!chip) return;
        activeGroupFilter = chip.dataset.groupId;
        renderGroupFilter();
        renderSiteList();
    });
    renderAll();
}

function onDisable() {
    document.getElementById('aca-settings-root')?.remove();
    document.getElementById('aca-float-ball')?.remove();
    document.getElementById('aca-float-root')?.remove();
    document.getElementById('aca-api-entry')?.remove();
}

export { onActivate, onDisable };


