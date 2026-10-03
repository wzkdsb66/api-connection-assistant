import { SECRET_KEYS, writeSecret, deleteSecret } from '../../../secrets.js';

const MODULE_ID = 'api-connection-assistant';
const DEFAULT_SETTINGS = Object.freeze({
    sites: [],
    groups: [],
    activeSiteId: null,
    floatWindowEnabled: false,
    floatWindowPosition: null,
    autoSyncFloat: true,
    language: 'auto',
});
const FETCH_TIMEOUT_MS = 15000;
const SUPPORTED_LANGUAGES = ['zh-cn', 'en'];

const expandedSiteModels = new Set();
const languageDictionaries = new Map();
const attemptedLanguages = new Set();
let currentLanguage = 'zh-cn';
let editorSiteId = null;
let editorModelChoices = [];
let activeGroupFilter = 'all';
let pendingGenerationSiteId = null;
let generationStartedHandler = null;
let generationEndedHandler = null;

// ---------- i18n ----------

function detectBrowserLanguage() {
    const lang = String(document.documentElement.lang ?? '').toLowerCase();
    return lang.startsWith('zh') ? 'zh-cn' : 'en';
}

function resolveWantedLanguage(settings) {
    const wanted = settings.language ?? 'auto';
    if (SUPPORTED_LANGUAGES.includes(wanted)) return wanted;
    return detectBrowserLanguage();
}

async function loadLanguage(preferred) {
    const candidates = [preferred, ...SUPPORTED_LANGUAGES].filter((language) => SUPPORTED_LANGUAGES.includes(language));
    for (const language of candidates) {
        if (languageDictionaries.has(language)) return language;
        if (attemptedLanguages.has(language)) continue;
        attemptedLanguages.add(language);
        try {
            const response = await fetch(new URL(`i18n/${language}.json`, import.meta.url).href);
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            languageDictionaries.set(language, await response.json());
            return language;
        } catch (error) {
            console.warn(`[api-connection-assistant] failed to load i18n/${language}.json`, error);
        }
    }
    return null;
}

function tr(key, vars) {
    const dictionary = languageDictionaries.get(currentLanguage);
    let template = dictionary?.[key] ?? key;
    if (vars) {
        template = template.replace(/\{(\w+)\}/g, (match, name) => (vars[name] ?? match));
    }
    return template;
}

function toastTitle() {
    return tr('settings.title');
}

function applyTranslations(root) {
    if (!root?.querySelectorAll) return;
    root.querySelectorAll('[data-tr]').forEach((element) => {
        element.textContent = tr(element.dataset.tr);
    });
    root.querySelectorAll('[data-tr-placeholder]').forEach((element) => {
        element.placeholder = tr(element.dataset.trPlaceholder);
    });
    root.querySelectorAll('[data-tr-title]').forEach((element) => {
        element.title = tr(element.dataset.trTitle);
    });
}

async function applyLanguage() {
    const settings = getSettings();
    const loaded = await loadLanguage(resolveWantedLanguage(settings));
    if (loaded) currentLanguage = loaded;
    applyTranslations(document.getElementById('aca-settings-root'));
    renderAll();
}

// ---------- 适配器层 ----------

const ADAPTERS = {
    'openai-compatible': {
        id: 'openai-compatible',
        async apply(site, secretId) {
            await runCommand('api', { quiet: 'true' }, 'custom');
            await runCommand('secret-id', { quiet: 'true', key: SECRET_KEYS.CUSTOM }, secretId);
            await runCommand('api-url', { api: 'custom', connect: 'true', quiet: 'true' }, normalizeApiUrl(site.apiUrl));
            if (site.model) await runCommand('model', { quiet: 'true' }, site.model);
        },
        async fetchModels(apiUrl, key) {
            const modelsUrl = `${normalizeApiUrl(apiUrl)}/models`;
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
            try {
                const response = await fetch(modelsUrl, {
                    method: 'GET',
                    headers: { Authorization: `Bearer ${key}` },
                    signal: controller.signal,
                });
                if (!response.ok) throw new Error(tr('err.http', { n: response.status }));
                const data = await response.json();
                return [...new Set(Array.isArray(data?.data)
                    ? data.data.map((item) => item?.id).filter((id) => typeof id === 'string' && id.length > 0)
                    : [])];
            } catch (error) {
                if (error?.name === 'AbortError') throw new Error(tr('err.timeout', { n: FETCH_TIMEOUT_MS / 1000 }));
                if (error instanceof TypeError) throw new Error(tr('err.cors'));
                throw error;
            } finally {
                clearTimeout(timeoutId);
            }
        },
    },
};

function getAdapter(site) {
    return ADAPTERS[site?.type] ?? ADAPTERS['openai-compatible'];
}

// ---------- 基础 ----------

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
    let changed = false;
    if (!Array.isArray(settings.sites)) settings.sites = [];
    if (!Array.isArray(settings.groups)) settings.groups = [];
    if (!settings.floatWindowPosition || typeof settings.floatWindowPosition !== 'object') settings.floatWindowPosition = null;
    if (!SUPPORTED_LANGUAGES.includes(settings.language) && settings.language !== 'auto') {
        settings.language = 'auto';
        changed = true;
    }
    let maxOrder = -1;
    for (const site of settings.sites) {
        if (!Array.isArray(site.keys)) { site.keys = []; changed = true; }
        if (!Array.isArray(site.secretIds)) { site.secretIds = []; changed = true; }
        if (!Array.isArray(site.models)) { site.models = []; changed = true; }
        if (!Number.isFinite(site.activeKeyIndex)) { site.activeKeyIndex = 0; changed = true; }
        if (!ADAPTERS[site.type]) {
            site.type = 'openai-compatible';
            changed = true;
        }
        if (!Number.isFinite(site.usageCount)) { site.usageCount = 0; changed = true; }
        if (!Number.isFinite(site.lastUsedAt)) { site.lastUsedAt = null; changed = true; }
        if (Number.isFinite(site.order)) maxOrder = Math.max(maxOrder, site.order);
    }
    for (const site of settings.sites) {
        if (!Number.isFinite(site.order)) {
            maxOrder += 1;
            site.order = maxOrder;
            changed = true;
        }
    }
    context.extensionSettings[MODULE_ID] = settings;
    if (changed) saveSettings();
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

function getSortedSites() {
    return [...getSites()].sort((a, b) => a.order - b.order);
}

function getGroupName(groupId) {
    if (!groupId) return tr('group.none');
    const group = getSettings().groups.find((item) => item.id === groupId);
    return group?.name ?? tr('group.none');
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
    if (!timestamp) return tr('meta.never');
    return new Date(timestamp).toLocaleString();
}

function normalizeApiUrl(apiUrl) {
    return String(apiUrl ?? '').trim().replace(/\/+$/, '');
}

function nextSiteOrder(sites) {
    return sites.length > 0 ? Math.max(...sites.map((site) => site.order)) + 1 : 0;
}

function showStatus(message, isError = false) {
    const status = document.getElementById('aca-editor-status');
    if (status) {
        status.textContent = message;
        status.classList.toggle('is-error', isError);
    }
    if (isError) toastr?.error?.(message, toastTitle());
}

// ---------- 密钥与切换 ----------

async function ensureKeySecret(site, keyIndex) {
    const key = site.keys?.[keyIndex];
    if (!key) throw new Error(tr('err.noSecretKey'));
    if (site.secretIds?.[keyIndex]) return site.secretIds[keyIndex];
    const secretId = await writeSecret(SECRET_KEYS.CUSTOM, key, `${site.name} #${keyIndex + 1}`);
    if (!secretId) throw new Error(tr('err.secretWrite'));
    site.secretIds[keyIndex] = secretId;
    saveSettings();
    return secretId;
}

async function runCommand(name, args, value) {
    const command = getContext().SlashCommandParser?.commands?.[name];
    if (!command) throw new Error(tr('err.noCommand', { name }));
    return command.callback(args ?? {}, value ?? '');
}

async function applySite(siteId, model) {
    const site = findSiteById(siteId);
    if (!site) throw new Error(tr('err.noSite'));
    if (site.models.length > 0) {
        site.model = model ?? site.model ?? site.models[0];
    } else if (model) {
        site.model = model;
    }
    const adapter = getAdapter(site);
    const secretId = await ensureKeySecret(site, site.activeKeyIndex);
    await adapter.apply(site, secretId);
    site.lastUsedAt = Date.now();
    const settings = getSettings();
    settings.activeSiteId = site.id;
    saveSettings();
    renderAll();
    return site;
}

async function rotateKey(siteId) {
    const site = findSiteById(siteId);
    if (!site) throw new Error(tr('err.noSite'));
    if (site.keys.length < 2) throw new Error(tr('toast.oneKey'));
    site.activeKeyIndex = (site.activeKeyIndex + 1) % site.keys.length;
    saveSettings();
    await applySite(siteId);
    toastr?.info?.(tr('toast.rotated', { i: site.activeKeyIndex + 1 }), toastTitle());
}

async function fetchSiteModels(apiUrl, key) {
    return getAdapter(null).fetchModels(apiUrl, key);
}

async function runFetchModels(siteId, button) {
    const originalText = button?.textContent ?? '';
    const site = findSiteById(siteId);
    if (!site) throw new Error(tr('err.noSite'));
    const key = site.keys?.[site.activeKeyIndex];
    if (!key) throw new Error(tr('err.needKeyFirst'));
    if (button) {
        button.disabled = true;
        button.textContent = tr('fetch.busy');
    }
    try {
        const models = await fetchSiteModels(site.apiUrl, key);
        site.models = models;
        if (site.models.length > 0 && !site.model) site.model = site.models[0];
        saveSettings();
        renderAll();
        if (editorSiteId === siteId) {
            editorModelChoices = findSiteById(siteId)?.models ?? [];
            document.getElementById('aca-editor-models').value = editorModelChoices.join('\n');
        }
        toastr?.success?.(models.length > 0 ? tr('toast.fetchOk', { n: models.length }) : tr('toast.fetchEmpty'), toastTitle());
    } catch (error) {
        renderAll();
        toastr?.warning?.(error?.message ?? String(error), toastTitle());
    } finally {
        if (button) {
            button.disabled = false;
            button.textContent = originalText;
        }
    }
}

// ---------- 排序 ----------

function moveSite(siteId, direction) {
    const settings = getSettings();
    const sites = getSortedSites();
    const index = sites.findIndex((site) => site.id === siteId);
    if (index < 0) return;
    const target = index + (direction === 'up' ? -1 : 1);
    if (target < 0 || target >= sites.length) return;
    const currentOrder = sites[index].order;
    sites[index].order = sites[target].order;
    sites[target].order = currentOrder;
    saveSettings();
    renderSiteList();
}

// ---------- 渲染 ----------

function renderGroupFilter() {
    const container = document.getElementById('aca-group-filter');
    if (!container) return;
    const settings = getSettings();
    const groups = [{ id: 'all', name: tr('filter.all') }, ...settings.groups];
    container.innerHTML = groups.map((group) => {
        const activeClass = activeGroupFilter === group.id ? ' is-active' : '';
        return `<button type="button" class="aca-group-chip${activeClass}" data-group-id="${escapeHtml(group.id)}">${escapeHtml(group.name)}</button>`;
    }).join('');
}

function getVisibleSites() {
    const sorted = getSortedSites();
    if (activeGroupFilter === 'all') return sorted;
    return sorted.filter((site) => (site.groupId ?? '') === activeGroupFilter);
}

function renderSiteList() {
    const container = document.getElementById('aca-site-list');
    if (!container) return;
    const settings = getSettings();
    const sites = getVisibleSites();
    if (settings.sites.length === 0) {
        container.innerHTML = `<div class="aca-empty">${tr('list.empty')}</div>`;
        return;
    }
    if (sites.length === 0) {
        container.innerHTML = `<div class="aca-empty">${tr('list.groupEmpty')}</div>`;
        return;
    }
    container.innerHTML = sites.map((site) => {
        const activeClass = site.id === settings.activeSiteId ? ' is-active' : '';
        const modelCount = site.models.length;
        const keyOk = site.keys.length > 0;
        const models = site.models.length > 0 ? site.models : (site.model ? [site.model] : []);
        const modelRows = models.length > 0
            ? models.map((model) => `<button type="button" class="aca-site-model${model === site.model ? ' is-active' : ''}" data-model="${escapeHtml(model)}" title="${escapeHtml(model)}">${escapeHtml(model)}</button>`).join('')
            : `<span class="aca-empty">${tr('models.empty')}</span>`;
        const usageBadge = site.usageCount > 0
            ? `<span class="aca-badge" title="${tr('badge.usageTip')}">${tr('badge.usage', { n: site.usageCount })}</span>`
            : '';
        return `
            <div class="aca-site-card${activeClass}" data-site-id="${escapeHtml(site.id)}">
                <div class="aca-site-badges">
                    <span class="aca-badge">${tr('badge.models', { n: modelCount })}</span>
                    <span class="aca-badge ${keyOk ? 'is-ok' : 'is-off'}">${keyOk ? tr('badge.keyOk') : tr('badge.keyOff')}</span>
                    ${site.keys.length > 1 ? `<span class="aca-badge">${tr('badge.keyIndex', { i: site.activeKeyIndex + 1, n: site.keys.length })}</span>` : ''}
                    ${usageBadge}
                </div>
                <div class="aca-site-models">${modelRows}</div>
                <div class="aca-site-meta">
                    <span title="${tr('meta.lastUsed')}">🕐 ${escapeHtml(formatTime(site.lastUsedAt))}</span>
                    <span title="${tr('meta.group')}">📍 ${escapeHtml(getGroupName(site.groupId))}</span>
                </div>
                <div class="aca-site-actions">
                    <button type="button" class="aca-action-primary" data-action="apply" title="${tr('action.useTip')}"><i class="fa-solid fa-plug"></i> ${tr('action.use')}</button>
                    <button type="button" class="aca-action-button" data-action="models" title="${tr('action.modelsTip')}"><i class="fa-solid fa-layer-group"></i> ${tr('action.models')}</button>
                    <button type="button" class="aca-action-button" data-action="rotate" title="${tr('action.rotateTip')}"><i class="fa-solid fa-key"></i></button>
                    <button type="button" class="aca-action-button" data-action="edit" title="${tr('action.edit')}"><i class="fa-solid fa-pen"></i></button>
                    <button type="button" class="aca-action-button" data-action="delete" title="${tr('action.delete')}"><i class="fa-solid fa-trash"></i></button>
                    <div class="aca-sort-buttons">
                        <button type="button" class="aca-sort-button" data-action="up" title="${tr('action.up')}">↑</button>
                        <button type="button" class="aca-sort-button" data-action="down" title="${tr('action.down')}">↓</button>
                    </div>
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
    const options = [`<option value="">${tr('group.none')}</option>`];
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
        select.innerHTML = `<option value="">${tr('list.noSites')}</option>`;
        status.innerHTML = '';
        return;
    }
    select.innerHTML = getSortedSites()
        .map((site) => `<option value="${escapeHtml(site.id)}"${site.id === settings.activeSiteId ? ' selected' : ''}>${escapeHtml(site.name)}</option>`)
        .join('');
    const site = settings.sites.find((item) => item.id === settings.activeSiteId);
    status.innerHTML = site ? `<span class="aca-api-model">${escapeHtml(site.model || tr('meta.noModel'))}</span>` : '';
}

function renderModelChips(site) {
    if (!expandedSiteModels.has(site.id)) return '';
    const models = site.models.length > 0 ? site.models : (site.model ? [site.model] : []);
    if (models.length === 0) return `<div class="aca-model-chips"><span class="aca-empty">${tr('models.empty')}</span></div>`;
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
    ball.title = tr('ball.title');
    document.getElementById('aca-float-title').textContent = tr('float.title');
    if (!enabled) return;
    const position = settings.floatWindowPosition;
    if (position && Number.isFinite(position.x) && Number.isFinite(position.y)) {
        floatRoot.style.left = `${Math.max(0, position.x)}px`;
        floatRoot.style.top = `${Math.max(0, position.y)}px`;
        floatRoot.style.right = 'auto';
    }
    const sites = getSortedSites();
    if (sites.length === 0) {
        list.innerHTML = `<div class="aca-empty">${tr('list.noSites')}</div>`;
        return;
    }
    list.innerHTML = sites.map((site) => `
        <div class="aca-float-item${site.id === settings.activeSiteId ? ' is-active' : ''}" data-site-id="${escapeHtml(site.id)}">
            <div class="aca-float-row">
                <button type="button" class="aca-float-name" title="${escapeHtml(site.name)}">${escapeHtml(site.name)}</button>
                <span class="aca-float-model" title="${escapeHtml(site.model || tr('meta.noModel'))}">${escapeHtml(site.model || tr('meta.noModel'))}</span>
                <button type="button" class="aca-action-button" data-action="models" title="${tr('float.toggleModels')}">模</button>
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
// ---------- 编辑器 ----------

function openEditor(siteId) {
    editorSiteId = siteId;
    const editor = document.getElementById('aca-editor');
    if (!editor) return;
    const site = siteId ? findSiteById(siteId) : null;
    editorModelChoices = site?.models ?? [];
    document.getElementById('aca-editor-title').textContent = site ? tr('editor.edit', { name: site.name }) : tr('editor.new');
    document.getElementById('aca-editor-name').value = site?.name ?? '';
    document.getElementById('aca-editor-url').value = site?.apiUrl ?? '';
    const keyInput = document.getElementById('aca-editor-key');
    keyInput.value = '';
    keyInput.placeholder = site ? tr('field.keyEditHint') : tr('field.keyPlaceholderNew');
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
        showStatus(tr('status.needName'), true);
        return;
    }
    if (!apiUrl) {
        showStatus(tr('status.needUrl'), true);
        return;
    }
    if (!/^https?:\/\//i.test(apiUrl)) {
        showStatus(tr('status.needScheme'), true);
        return;
    }
    const settings = getSettings();
    let site = editorSiteId ? findSiteById(editorSiteId) : null;
    if (!site && keys.length === 0) {
        showStatus(tr('status.needKey'), true);
        return;
    }
    try {
        if (!site) {
            site = {
                id: crypto.randomUUID(),
                name,
                apiUrl,
                type: 'openai-compatible',
                order: nextSiteOrder(settings.sites),
                keys,
                secretIds: [],
                activeKeyIndex: 0,
                models,
                model: models[0] ?? '',
                groupId: groupId || '',
                usageCount: 0,
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
        toastr?.success?.(tr('toast.saved', { name: site.name }), toastTitle());
    } catch (error) {
        showStatus(error?.message ?? String(error), true);
    }
}

async function deleteSite(siteId) {
    const site = findSiteById(siteId);
    if (!site) return;
    if (!window.confirm(tr('confirm.deleteSite', { name: site.name }))) return;
    try {
        for (const secretId of site.secretIds) {
            if (typeof secretId === 'string' && secretId.length > 0) {
                await deleteSecret(SECRET_KEYS.CUSTOM, secretId);
            }
        }
    } catch (error) {
        toastr?.warning?.(tr('toast.secretDeleteFail', { msg: error?.message ?? String(error) }), toastTitle());
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
    const rawName = window.prompt(tr('toast.groupPrompt'));
    const name = String(rawName ?? '').trim();
    if (!name) return;
    const settings = getSettings();
    if (settings.groups.some((group) => group.name === name)) {
        toastr?.warning?.(tr('toast.groupExists'), toastTitle());
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
        version: 2,
        exportedAt: new Date().toISOString(),
        groups: settings.groups,
        sites: getSortedSites().map((site) => ({
            name: site.name,
            apiUrl: site.apiUrl,
            type: site.type ?? 'openai-compatible',
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
    toastr?.success?.(includeKeys ? tr('io.exportSecure') : tr('io.exportPlain'), toastTitle());
}

async function importSites(file) {
    let payload = null;
    try {
        const text = await file.text();
        payload = JSON.parse(text);
    } catch {
        toastr?.error?.(tr('io.badJson'), toastTitle());
        return;
    }
    const sites = Array.isArray(payload?.sites) ? payload.sites : [];
    const groups = Array.isArray(payload?.groups) ? payload.groups : [];
    if (sites.length === 0 && groups.length === 0) {
        toastr?.warning?.(tr('io.nothing'), toastTitle());
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
                type: ADAPTERS[site?.type] ? site.type : 'openai-compatible',
                order: nextSiteOrder(settings.sites),
                keys,
                secretIds: [],
                activeKeyIndex: 0,
                models,
                model: models[0] ?? '',
                groupId,
                usageCount: 0,
                lastUsedAt: null,
            };
            settings.sites.push(newSite);
            if (keys.length > 0) await ensureKeySecret(newSite, 0);
            addedSites += 1;
        }
    }
    saveSettings();
    renderAll();
    toastr?.success?.(tr('toast.importDone', { s: addedSites, g: addedGroups }), toastTitle());
}

// ---------- 使用统计 ----------

function bindGenerationEvents(context) {
    const eventTypes = context.eventTypes;
    if (!eventTypes || !context.eventSource?.on) return;
    generationStartedHandler = () => {
        pendingGenerationSiteId = getSettings().activeSiteId;
    };
    generationEndedHandler = () => {
        const siteId = pendingGenerationSiteId;
        pendingGenerationSiteId = null;
        if (!siteId) return;
        const settings = getSettings();
        const site = settings.sites.find((item) => item.id === siteId);
        if (!site) return;
        site.usageCount = (site.usageCount ?? 0) + 1;
        site.lastUsedAt = Date.now();
        saveSettings();
        renderSiteList();
    };
    context.eventSource.on(eventTypes.GENERATION_STARTED, generationStartedHandler);
    context.eventSource.on(eventTypes.GENERATION_ENDED, generationEndedHandler);
}

function unbindGenerationEvents(context) {
    if (!generationStartedHandler && !generationEndedHandler) return;
    if (context?.eventSource?.removeListener && context?.eventTypes) {
        if (generationStartedHandler) context.eventSource.removeListener(context.eventTypes.GENERATION_STARTED, generationStartedHandler);
        if (generationEndedHandler) context.eventSource.removeListener(context.eventTypes.GENERATION_ENDED, generationEndedHandler);
    }
    generationStartedHandler = null;
    generationEndedHandler = null;
    pendingGenerationSiteId = null;
}

function resetUsageStats() {
    const settings = getSettings();
    for (const site of settings.sites) {
        site.usageCount = 0;
        site.lastUsedAt = null;
    }
    saveSettings();
    renderAll();
    toastr?.success?.(tr('settings.statsResetDone'), toastTitle());
}
// ---------- 悬浮窗 ----------

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
    ball.title = tr('ball.title');
    ball.textContent = '⚡';
    ball.classList.add('hidden');

    const floatRoot = document.createElement('div');
    floatRoot.id = 'aca-float-root';
    floatRoot.dataset.extensionId = MODULE_ID;
    floatRoot.classList.add('hidden');
    floatRoot.innerHTML = `
        <div class="aca-float-header">
            <span id="aca-float-title">${tr('float.title')}</span>
            <button type="button" class="aca-float-close" title="${tr('float.collapse')}">×</button>
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
                toastr?.success?.(tr('toast.switched', { name: site.name }), toastTitle());
            } catch (error) {
                toastr?.error?.(error?.message ?? String(error), toastTitle());
            }
            return;
        }
        if (button?.classList.contains('aca-model-chip')) {
            try {
                await applySite(siteId, button.dataset.model);
                toastr?.success?.(tr('toast.switchedModel', { name: site.name, model: button.dataset.model }), toastTitle());
            } catch (error) {
                toastr?.error?.(error?.message ?? String(error), toastTitle());
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
        <div class="aca-api-title">${tr('apiEntry.title')}</div>
        <div class="aca-api-controls">
            <select id="aca-api-select"></select>
            <button type="button" id="aca-api-apply" class="aca-action-primary" title="${tr('action.useTip')}"><i class="fa-solid fa-plug"></i> ${tr('apiEntry.apply')}</button>
            <button type="button" id="aca-api-fetch" class="aca-action-button" title="${tr('action.modelsTip')}">${tr('action.models')}</button>
            <span id="aca-api-result"></span>
        </div>
    `;
    entry.querySelector('#aca-api-apply')?.addEventListener('click', async () => {
        const siteId = document.getElementById('aca-api-select')?.value;
        if (!siteId) return;
        try {
            const site = await applySite(siteId);
            toastr?.success?.(tr('toast.switched', { name: site.name }), toastTitle());
        } catch (error) {
            toastr?.error?.(error?.message ?? String(error), toastTitle());
        }
    });
    entry.querySelector('#aca-api-fetch')?.addEventListener('click', async (event) => {
        const siteId = document.getElementById('aca-api-select')?.value;
        if (!siteId) return;
        await runFetchModels(siteId, event.currentTarget);
    });
    anchor.after(entry);
}

// ---------- 旧数据迁移 ----------

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
            name: String(profile.name ?? tr('site.untitled')),
            apiUrl: String(profile.apiUrl ?? ''),
            type: 'openai-compatible',
            order: nextSiteOrder(settings.sites),
            keys: profile.apiKey ? [String(profile.apiKey)] : [],
            secretIds: profile.secretId ? [String(profile.secretId)] : [],
            activeKeyIndex: 0,
            models,
            model: profile.model ?? models[0] ?? '',
            groupId: '',
            usageCount: 0,
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

// ---------- 生命周期 ----------

async function onActivate() {
    const context = getContext();
    const settings = getSettings();
    activeGroupFilter = 'all';
    migrateLegacyProfiles();
    if (!document.getElementById('aca-settings-root')) {
        const settingsHtml = await context.renderExtensionTemplateAsync('third-party/api-connection-assistant', 'settings', {});
        $('#extensions_settings2').append(settingsHtml);
    }
    bindSettingsControls(settings);
    await applyLanguage();
    if (!document.getElementById('aca-float-ball')) createFloatWindow();
    createApiEntry();
    bindGenerationEvents(context);
    renderAll();
}

function bindSettingsControls(settings) {
    const floatToggle = document.getElementById('aca-float-window-enabled');
    if (floatToggle) {
        floatToggle.checked = settings.floatWindowEnabled;
        floatToggle.addEventListener('change', () => {
            const currentSettings = getSettings();
            currentSettings.floatWindowEnabled = floatToggle.checked;
            saveSettings();
            renderFloatWindow();
            if (!floatToggle.checked) toastr?.info?.(tr('toast.floatOff'), toastTitle());
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
    const languageSelect = document.getElementById('aca-language');
    if (languageSelect) {
        languageSelect.value = settings.language ?? 'auto';
        languageSelect.addEventListener('change', async () => {
            const currentSettings = getSettings();
            currentSettings.language = languageSelect.value;
            saveSettings();
            await applyLanguage();
        });
    }
    document.getElementById('aca-stats-reset')?.addEventListener('click', resetUsageStats);
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
                showStatus(tr('status.fetchHint'), true);
                return;
            }
            const button = event.currentTarget;
            const originalText = button?.textContent ?? '';
            if (button) {
                button.disabled = true;
                button.textContent = tr('fetch.busy');
            }
            showStatus(tr('status.fetching'));
            try {
                const models = await fetchSiteModels(url, key);
                editorModelChoices = models;
                document.getElementById('aca-editor-models').value = models.join('\n');
                showStatus(models.length > 0 ? tr('toast.fetchOk', { n: models.length }) : tr('toast.fetchEmpty'));
            } catch (error) {
                showStatus(error?.message ?? String(error), true);
            } finally {
                if (button) {
                    button.disabled = false;
                    button.textContent = originalText;
                }
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
                    toastr?.success?.(tr('toast.switchedModelShort', { model: modelButton.dataset.model }), toastTitle());
                } catch (error) {
                    toastr?.error?.(error?.message ?? String(error), toastTitle());
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
                toastr?.success?.(tr('toast.switched', { name: site.name }), toastTitle());
            } catch (error) {
                toastr?.error?.(error?.message ?? String(error), toastTitle());
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
                toastr?.warning?.(error?.message ?? String(error), toastTitle());
            }
            return;
        }
        if (action === 'up') {
            moveSite(siteId, 'up');
            return;
        }
        if (action === 'down') {
            moveSite(siteId, 'down');
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
}

function onDisable() {
    try {
        unbindGenerationEvents(getContext());
    } catch {
        /* context may already be gone during shutdown */
    }
    document.getElementById('aca-settings-root')?.remove();
    document.getElementById('aca-float-ball')?.remove();
    document.getElementById('aca-float-root')?.remove();
    document.getElementById('aca-api-entry')?.remove();
}

export { onActivate, onDisable };