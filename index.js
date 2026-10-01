const MODULE_ID = 'api-connection-assistant';
const DEFAULT_SETTINGS = Object.freeze({
    profiles: [],
    activeProfileId: null,
    floatWindowEnabled: false,
    floatWindowPosition: null,
    floatBallPosition: null,
});
const FETCH_TIMEOUT_MS = 15000;

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
    if (!Array.isArray(settings.profiles)) {
        settings.profiles = [];
    }
    if (!settings.floatWindowPosition || typeof settings.floatWindowPosition !== 'object') {
        settings.floatWindowPosition = null;
    }
    if (!settings.floatBallPosition || typeof settings.floatBallPosition !== 'object') {
        settings.floatBallPosition = null;
    }
    context.extensionSettings[MODULE_ID] = settings;
    return settings;
}

function saveSettings() {
    getContext().saveSettingsDebounced?.();
}

function getProfiles() {
    return getSettings().profiles;
}

function findProfileById(profileId) {
    return getProfiles().find((profile) => profile.id === profileId) ?? null;
}

function escapeHtml(value) {
    return String(value ?? '')
        .replaceAll('&', '&#38;')
        .replaceAll('<', '&#60;')
        .replaceAll('>', '&#62;')
        .replaceAll('"', '&#34;')
        .replaceAll("'", '&#39;');
}

function normalizeApiUrl(apiUrl) {
    return String(apiUrl ?? '').trim().replace(/\/+$/, '');
}

function showEditorStatus(message, isError = false) {
    const status = document.getElementById('aca-modal-status');
    if (status) {
        status.textContent = message;
        status.classList.toggle('is-error', isError);
    }
}

async function ensureSecret(profile) {
    if (!profile.apiKey) {
        throw new Error('这个配置缺少密钥，请先编辑并填写密钥。');
    }
    if (profile.secretId) {
        return profile.secretId;
    }
    const { SECRET_KEYS, writeSecret } = await import('../../../secrets.js');
    const secretId = await writeSecret(SECRET_KEYS.CUSTOM, profile.apiKey, profile.name);
    if (!secretId) {
        throw new Error('写入酒馆密钥库失败。');
    }
    profile.secretId = secretId;
    saveSettings();
    return secretId;
}

async function runCommand(name, args, value) {
    const command = getContext().SlashCommandParser?.commands?.[name];
    if (!command) {
        throw new Error(`当前酒馆缺少 /${name} 命令。`);
    }
    return command.callback(args ?? {}, value ?? '');
}

async function applyProfileById(profileId) {
    const profile = findProfileById(profileId);
    if (!profile) {
        throw new Error('找不到这个 API 配置。');
    }
    const secretId = await ensureSecret(profile);
    await runCommand('api', { quiet: 'true' }, 'custom');
    await runCommand('secret-id', { quiet: 'true', key: 'api_key_custom' }, secretId);
    await runCommand('api-url', { api: 'custom', connect: 'true', quiet: 'true' }, normalizeApiUrl(profile.apiUrl));
    if (profile.model) {
        await runCommand('model', { quiet: 'true' }, profile.model);
    }
    const settings = getSettings();
    settings.activeProfileId = profile.id;
    saveSettings();
    renderAll();
    toastr?.success?.(`已切换到「${profile.name}」`, 'API 连接助手');
}

async function fetchModelsForProfile(profileId) {
    const profile = findProfileById(profileId);
    if (!profile) {
        throw new Error('找不到这个 API 配置。');
    }
    if (!profile.apiKey) {
        throw new Error('请先在编辑里填写密钥。');
    }
    const modelsUrl = `${normalizeApiUrl(profile.apiUrl)}/models`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
        const response = await fetch(modelsUrl, {
            method: 'GET',
            headers: { Authorization: `Bearer ${profile.apiKey}` },
            signal: controller.signal,
        });
        if (!response.ok) {
            throw new Error(`站点返回 HTTP ${response.status}`);
        }
        const data = await response.json();
        const models = Array.isArray(data?.data)
            ? data.data.map((item) => item?.id).filter((id) => typeof id === 'string' && id.length > 0)
            : [];
        profile.models = models;
        saveSettings();
        return models;
    } catch (error) {
        const isNetworkError = error instanceof TypeError;
        const reason = isNetworkError
            ? '无法访问站点：可能是跨域限制或网络问题'
            : (error?.name === 'AbortError' ? `超过 ${FETCH_TIMEOUT_MS / 1000} 秒未响应` : (error?.message ?? String(error)));
        throw new Error(reason);
    } finally {
        clearTimeout(timeoutId);
    }
}

async function runFetchModels(profileId, button) {
    const originalText = button.textContent;
    button.disabled = true;
    button.textContent = '拉取中…';
    try {
        const models = await fetchModelsForProfile(profileId);
        renderAll();
        if (editorProfileId === profileId) {
            editorModelChoices = models;
            renderModalModelChoices();
        }
        toastr?.success?.(`获取到 ${models.length} 个模型`, 'API 连接助手');
    } catch (error) {
        renderAll();
        toastr?.warning?.(error?.message ?? String(error), '拉取模型');
    } finally {
        button.disabled = false;
        button.textContent = originalText;
    }
}

function renderSettingsList() {
    const container = document.getElementById('aca-profile-list');
    if (!container) {
        return;
    }
    const settings = getSettings();
    if (settings.profiles.length === 0) {
        container.innerHTML = '<div class="aca-empty">还没有 API 配置，点下面的按钮新增。</div>';
        return;
    }
    container.innerHTML = settings.profiles.map((profile) => {
        const activeClass = profile.id === settings.activeProfileId ? ' is-active' : '';
        return `
            <div class="aca-profile-row${activeClass}" data-profile-id="${escapeHtml(profile.id)}">
                <span class="aca-profile-name" title="${escapeHtml(profile.name)}">${escapeHtml(profile.name)}</span>
                <span class="aca-profile-meta" title="${escapeHtml(profile.apiUrl)}">${escapeHtml(profile.apiUrl)}</span>
                <span class="aca-profile-model" title="${escapeHtml(profile.model)}">${escapeHtml(profile.model || '未设模型')}</span>
                <button type="button" class="aca-button menu_button" data-action="apply">应用</button>
                <button type="button" class="aca-button menu_button" data-action="models">拉模型</button>
                <button type="button" class="aca-button menu_button" data-action="edit">编辑</button>
            </div>
        `;
    }).join('');
}

function renderModalModelChoices() {
    const select = document.getElementById('aca-modal-model-select');
    if (!select) {
        return;
    }
    if (editorModelChoices.length === 0) {
        select.innerHTML = '<option value="">暂无模型列表</option>';
        return;
    }
    const currentModel = document.getElementById('aca-modal-model')?.value ?? '';
    select.innerHTML = editorModelChoices
        .map((model) => `<option value="${escapeHtml(model)}"${model === currentModel ? ' selected' : ''}>${escapeHtml(model)}</option>`)
        .join('');
}

function renderApiEntry() {
    const select = document.getElementById('aca-api-select');
    const status = document.getElementById('aca-api-result');
    if (!select || !status) {
        return;
    }
    const settings = getSettings();
    if (settings.profiles.length === 0) {
        select.innerHTML = '<option value="">暂无 API 配置</option>';
        status.innerHTML = '';
        return;
    }
    select.innerHTML = settings.profiles
        .map((profile) => `<option value="${escapeHtml(profile.id)}"${profile.id === settings.activeProfileId ? ' selected' : ''}>${escapeHtml(profile.name)}</option>`)
        .join('');
    const activeProfile = settings.profiles.find((profile) => profile.id === settings.activeProfileId);
    status.innerHTML = activeProfile
        ? `<span class="aca-api-model">${escapeHtml(activeProfile.model || '未设模型')}</span>`
        : '';
}

function renderModelChips(profile) {
    if (!expandedProfileModels.has(profile.id)) {
        return '';
    }
    const models = Array.isArray(profile.models) ? profile.models : [];
    const chips = models.length > 0
        ? models.map((model) => `<button type="button" class="aca-model-chip" data-model="${escapeHtml(model)}" title="${escapeHtml(model)}">${escapeHtml(model)}</button>`).join('')
        : '<span class="aca-empty">还没有模型列表，点「拉」先获取。</span>';
    return `<div class="aca-model-chips">${chips}</div>`;
}

function renderFloatWindow() {
    const ball = document.getElementById('aca-float-ball');
    const floatRoot = document.getElementById('aca-float-root');
    const list = document.getElementById('aca-float-list');
    if (!ball || !floatRoot || !list) {
        return;
    }
    const settings = getSettings();
    const enabled = settings.floatWindowEnabled;
    ball.classList.toggle('hidden', !enabled);
    floatRoot.classList.toggle('hidden', !enabled);
    if (!enabled) {
        return;
    }
    const ballPosition = settings.floatBallPosition;
    if (ballPosition && Number.isFinite(ballPosition.x) && Number.isFinite(ballPosition.y)) {
        ball.style.left = `${Math.max(0, ballPosition.x)}px`;
        ball.style.top = `${Math.max(0, ballPosition.y)}px`;
        ball.style.right = 'auto';
    }
    const windowPosition = settings.floatWindowPosition;
    if (windowPosition && Number.isFinite(windowPosition.x) && Number.isFinite(windowPosition.y)) {
        floatRoot.style.left = `${Math.max(0, windowPosition.x)}px`;
        floatRoot.style.top = `${Math.max(0, windowPosition.y)}px`;
        floatRoot.style.right = 'auto';
    }
    if (settings.profiles.length === 0) {
        list.innerHTML = '<div class="aca-empty">暂无 API 配置</div>';
        return;
    }
    list.innerHTML = settings.profiles.map((profile) => `
        <div class="aca-float-item${profile.id === settings.activeProfileId ? ' is-active' : ''}" data-profile-id="${escapeHtml(profile.id)}">
            <div class="aca-float-row">
                <button type="button" class="aca-float-name" title="${escapeHtml(profile.name)}">${escapeHtml(profile.name)}</button>
                <span class="aca-float-model" title="${escapeHtml(profile.model)}">${escapeHtml(profile.model || '未设模型')}</span>
                <button type="button" class="aca-button menu_button" data-action="models" title="展开/收起模型">模</button>
                <button type="button" class="aca-button menu_button" data-action="fetch" title="拉取模型列表">拉</button>
            </div>
            ${renderModelChips(profile)}
        </div>
    `).join('');
}

function renderAll() {
    renderSettingsList();
    renderApiEntry();
    renderFloatWindow();
}

function ensureModal() {
    if (document.getElementById('aca-modal-backdrop')) {
        return;
    }
    const backdrop = document.createElement('div');
    backdrop.id = 'aca-modal-backdrop';
    backdrop.dataset.extensionId = MODULE_ID;
    backdrop.innerHTML = `
        <div class="aca-modal" role="dialog" aria-modal="true">
            <div class="aca-modal-title" id="aca-modal-title">新增 API 配置</div>
            <div class="aca-modal-card">
                <label class="aca-field">
                    <span>配置命名</span>
                    <input type="text" id="aca-modal-name" placeholder="例如：白天主力站">
                </label>
                <label class="aca-field">
                    <span>网址</span>
                    <input type="text" id="aca-modal-url" placeholder="https://example.com/v1">
                </label>
                <label class="aca-field">
                    <span>密钥</span>
                    <input type="password" id="aca-modal-key" placeholder="sk-...">
                </label>
                <label class="aca-field">
                    <span>模型</span>
                    <div class="aca-model-controls">
                        <input type="text" id="aca-modal-model" placeholder="model-id">
                        <select id="aca-modal-model-select"></select>
                        <button type="button" id="aca-modal-fetch" class="menu_button">拉取模型</button>
                    </div>
                </label>
                <div class="aca-modal-actions">
                    <button type="button" id="aca-modal-save" class="menu_button aca-primary">保存</button>
                    <button type="button" id="aca-modal-cancel" class="menu_button">取消</button>
                    <button type="button" id="aca-modal-delete" class="menu_button aca-danger hidden">删除</button>
                </div>
                <div id="aca-modal-status" class="aca-modal-status"></div>
            </div>
        </div>
    `;
    backdrop.querySelector('#aca-modal-cancel')?.addEventListener('click', closeModal);
    backdrop.querySelector('#aca-modal-save')?.addEventListener('click', saveModal);
    backdrop.querySelector('#aca-modal-delete')?.addEventListener('click', () => {
        if (editorProfileId) {
            deleteProfileById(editorProfileId);
        }
    });
    backdrop.querySelector('#aca-modal-fetch')?.addEventListener('click', async (event) => {
        const profileId = editorProfileId;
        if (!profileId) {
            showEditorStatus('请先保存配置，再拉取模型列表。', true);
            return;
        }
        await runFetchModels(profileId, event.currentTarget);
    });
    backdrop.querySelector('#aca-modal-model-select')?.addEventListener('change', (event) => {
        const modelInput = document.getElementById('aca-modal-model');
        if (modelInput && event.target.value) {
            modelInput.value = event.target.value;
        }
    });
    backdrop.addEventListener('click', (event) => {
        if (event.target === backdrop) {
            closeModal();
        }
    });
    document.body.append(backdrop);
}

function openModal(profileId) {
    ensureModal();
    editorProfileId = profileId;
    const backdrop = document.getElementById('aca-modal-backdrop');
    if (!backdrop) {
        return;
    }
    const profile = profileId ? findProfileById(profileId) : null;
    editorModelChoices = profile?.models ?? [];
    document.getElementById('aca-modal-title').textContent = profile ? `编辑：${profile.name}` : '新增 API 配置';
    document.getElementById('aca-modal-name').value = profile?.name ?? '';
    document.getElementById('aca-modal-url').value = profile?.apiUrl ?? '';
    document.getElementById('aca-modal-key').value = '';
    document.getElementById('aca-modal-key').placeholder = profile ? '留空表示不修改密钥' : 'sk-...';
    document.getElementById('aca-modal-model').value = profile?.model ?? '';
    document.getElementById('aca-modal-delete').classList.toggle('hidden', !profile);
    renderModalModelChoices();
    showEditorStatus('');
    backdrop.classList.add('is-open');
}

function closeModal() {
    editorProfileId = null;
    editorModelChoices = [];
    document.getElementById('aca-modal-backdrop')?.classList.remove('is-open');
}

async function saveModal() {
    const name = document.getElementById('aca-modal-name')?.value?.trim();
    const apiUrl = normalizeApiUrl(document.getElementById('aca-modal-url')?.value);
    const apiKey = document.getElementById('aca-modal-key')?.value?.trim();
    const model = document.getElementById('aca-modal-model')?.value?.trim();
    if (!name) {
        showEditorStatus('请填写配置名称。', true);
        return;
    }
    if (!apiUrl) {
        showEditorStatus('请填写 API 地址。', true);
        return;
    }
    if (!/^https?:\/\//i.test(apiUrl)) {
        showEditorStatus('API 地址必须以 http:// 或 https:// 开头。', true);
        return;
    }
    const settings = getSettings();
    let profile = editorProfileId ? findProfileById(editorProfileId) : null;
    try {
        if (!profile) {
            if (!apiKey) {
                showEditorStatus('新增配置时必须填写密钥。', true);
                return;
            }
            profile = {
                id: crypto.randomUUID(),
                name,
                apiUrl,
                apiKey,
                secretId: null,
                model,
                models: [],
            };
            settings.profiles.push(profile);
            await ensureSecret(profile);
        } else {
            profile.name = name;
            profile.apiUrl = apiUrl;
            profile.model = model;
            if (apiKey) {
                const { SECRET_KEYS, deleteSecret } = await import('../../../secrets.js');
                const oldSecretId = profile.secretId;
                profile.apiKey = apiKey;
                profile.secretId = null;
                await ensureSecret(profile);
                if (oldSecretId && oldSecretId !== profile.secretId) {
                    await deleteSecret(SECRET_KEYS.CUSTOM, oldSecretId);
                }
            }
        }
        saveSettings();
        closeModal();
        renderAll();
        toastr?.success?.(`已保存「${profile.name}」`, 'API 连接助手');
    } catch (error) {
        showEditorStatus(error?.message ?? String(error), true);
    }
}

async function deleteProfileById(profileId) {
    const profile = findProfileById(profileId);
    if (!profile) {
        return;
    }
    if (!window.confirm(`确定删除「${profile.name}」吗？这会同时删除它在酒馆密钥库中的密钥。`)) {
        return;
    }
    try {
        if (profile.secretId) {
            const { SECRET_KEYS, deleteSecret } = await import('../../../secrets.js');
            await deleteSecret(SECRET_KEYS.CUSTOM, profile.secretId);
        }
    } catch (error) {
        toastr?.warning?.(`删除密钥失败：${error?.message ?? String(error)}`, 'API 连接助手');
    }
    const settings = getSettings();
    settings.profiles = settings.profiles.filter((item) => item.id !== profileId);
    if (settings.activeProfileId === profileId) {
        settings.activeProfileId = null;
    }
    expandedProfileModels.delete(profileId);
    saveSettings();
    closeModal();
    renderAll();
}

function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
}

function makeDraggable(dragHandle, target, positionKey, onClickCheck) {
    let dragging = false;
    let moved = false;
    let offsetX = 0;
    let offsetY = 0;
    dragHandle.addEventListener('pointerdown', (event) => {
        if (onClickCheck?.(event)) {
            return;
        }
        const rect = target.getBoundingClientRect();
        offsetX = event.clientX - rect.left;
        offsetY = event.clientY - rect.top;
        dragging = true;
        moved = false;
        dragHandle.setPointerCapture(event.pointerId);
    });
    dragHandle.addEventListener('pointermove', (event) => {
        if (!dragging) {
            return;
        }
        const x = clamp(event.clientX - offsetX, 0, Math.max(0, window.innerWidth - target.offsetWidth));
        const y = clamp(event.clientY - offsetY, 0, Math.max(0, window.innerHeight - target.offsetHeight));
        target.style.left = `${x}px`;
        target.style.top = `${y}px`;
        target.style.right = 'auto';
        moved = true;
    });
    dragHandle.addEventListener('pointerup', (event) => {
        if (!dragging) {
            return;
        }
        dragging = false;
        dragHandle.releasePointerCapture(event.pointerId);
        if (moved) {
            const rect = target.getBoundingClientRect();
            const settings = getSettings();
            settings[positionKey] = { x: rect.left, y: rect.top };
            saveSettings();
        }
    });
    return () => moved;
}

function createFloatWindow() {
    const ball = document.createElement('button');
    ball.id = 'aca-float-ball';
    ball.type = 'button';
    ball.title = 'API 连接助手';
    ball.textContent = '⚡';
    ball.classList.add('hidden');
    ball.addEventListener('click', () => {
        document.getElementById('aca-float-root')?.classList.toggle('hidden');
    });

    const floatRoot = document.createElement('div');
    floatRoot.id = 'aca-float-root';
    floatRoot.dataset.extensionId = MODULE_ID;
    floatRoot.classList.add('hidden');
    floatRoot.innerHTML = `
        <div class="aca-float-header">
            <span>API 快切</span>
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
        if (!item) {
            return;
        }
        const profileId = item.dataset.profileId;
        const profile = findProfileById(profileId);
        if (!profile) {
            return;
        }
        if (button?.classList.contains('aca-float-name')) {
            try {
                await applyProfileById(profileId);
            } catch (error) {
                toastr?.error?.(error?.message ?? String(error), 'API 连接助手');
            }
            return;
        }
        if (button?.classList.contains('aca-model-chip')) {
            profile.model = button.dataset.model;
            saveSettings();
            try {
                await applyProfileById(profileId);
            } catch (error) {
                toastr?.error?.(error?.message ?? String(error), 'API 连接助手');
            }
            return;
        }
        if (button?.dataset.action === 'models') {
            if (expandedProfileModels.has(profileId)) {
                expandedProfileModels.delete(profileId);
            } else {
                expandedProfileModels.add(profileId);
            }
            renderFloatWindow();
            return;
        }
        if (button?.dataset.action === 'fetch') {
            await runFetchModels(profileId, button);
        }
    });
    document.body.append(ball, floatRoot);
    makeDraggable(ball, ball, 'floatBallPosition');
    makeDraggable(floatRoot.querySelector('.aca-float-header'), floatRoot, 'floatWindowPosition', (event) => Boolean(event.target.closest('button')));
}

function createApiEntry() {
    const mount = document.querySelector('#rm_api_block');
    const anchor = document.querySelector('#main-API-selector-block');
    if (!mount || !anchor) {
        return;
    }
    const entry = document.createElement('div');
    entry.id = 'aca-api-entry';
    entry.dataset.extensionId = MODULE_ID;
    entry.innerHTML = `
        <div class="aca-api-title">API 连接助手</div>
        <div class="aca-api-controls">
            <select id="aca-api-select"></select>
            <button type="button" id="aca-api-apply" class="aca-button menu_button">应用</button>
            <button type="button" id="aca-api-fetch" class="aca-button menu_button">拉模型</button>
            <span id="aca-api-result"></span>
        </div>
    `;
    entry.querySelector('#aca-api-apply')?.addEventListener('click', async () => {
        const profileId = document.getElementById('aca-api-select')?.value;
        if (!profileId) {
            return;
        }
        try {
            await applyProfileById(profileId);
        } catch (error) {
            toastr?.error?.(error?.message ?? String(error), 'API 连接助手');
        }
    });
    entry.querySelector('#aca-api-fetch')?.addEventListener('click', async (event) => {
        const profileId = document.getElementById('aca-api-select')?.value;
        if (!profileId) {
            return;
        }
        await runFetchModels(profileId, event.currentTarget);
    });
    anchor.after(entry);
}

async function onActivate() {
    const context = getContext();
    const settings = getSettings();
    if (!document.getElementById('aca-settings-root')) {
        const settingsHtml = await context.renderExtensionTemplateAsync('third-party/api-connection-assistant', 'settings', {});
        $('#extensions_settings2').append(settingsHtml);
    }
    if (!document.getElementById('aca-float-ball')) {
        createFloatWindow();
    }
    if (!document.getElementById('aca-api-entry')) {
        createApiEntry();
    }
    const toggle = document.getElementById('aca-float-window-enabled');
    if (toggle) {
        toggle.checked = settings.floatWindowEnabled;
        toggle.addEventListener('change', () => {
            const currentSettings = getSettings();
            currentSettings.floatWindowEnabled = toggle.checked;
            saveSettings();
            renderFloatWindow();
        });
    }
    document.getElementById('aca-add-profile')?.addEventListener('click', () => openModal(null));
    document.getElementById('aca-profile-list')?.addEventListener('click', async (event) => {
        const button = event.target.closest('button[data-action]');
        if (!button) {
            return;
        }
        const profileId = button.closest('.aca-profile-row')?.dataset.profileId;
        if (!profileId) {
            return;
        }
        if (button.dataset.action === 'apply') {
            try {
                await applyProfileById(profileId);
            } catch (error) {
                toastr?.error?.(error?.message ?? String(error), 'API 连接助手');
            }
            return;
        }
        if (button.dataset.action === 'models') {
            await runFetchModels(profileId, button);
            return;
        }
        if (button.dataset.action === 'edit') {
            openModal(profileId);
        }
    });
    renderAll();
}

function onDisable() {
    document.getElementById('aca-settings-root')?.remove();
    document.getElementById('aca-float-ball')?.remove();
    document.getElementById('aca-float-root')?.remove();
    document.getElementById('aca-api-entry')?.remove();
    document.getElementById('aca-modal-backdrop')?.remove();
}

export { onActivate, onDisable };
