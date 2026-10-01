const MODULE_ID = 'api-connection-assistant';
const DEFAULT_SETTINGS = Object.freeze({
    floatWindowEnabled: false,
    testResults: {},
});

const TEST_PROMPT = 'ping';
const TEST_MAX_TOKENS = 1;
const TEST_TIMEOUT_MS = 20000;
const SWITCH_TIMEOUT_MS = 5000;

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
    if (!settings.testResults || typeof settings.testResults !== 'object') {
        settings.testResults = {};
    }
    context.extensionSettings[MODULE_ID] = settings;
    return settings;
}

function saveSettings() {
    getContext().saveSettingsDebounced?.();
}

function getConnectionManager() {
    return getContext().extensionSettings.connectionManager;
}

function getProfiles() {
    return getConnectionManager()?.profiles ?? [];
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

function formatTime(timestamp) {
    if (!timestamp) {
        return '—';
    }
    return new Date(timestamp).toLocaleString();
}

function getResultBadge(profileId) {
    const result = getSettings().testResults[profileId];
    if (!result) {
        return '<span class="aca-result">未测试</span>';
    }
    const className = result.ok ? 'is-ok' : 'is-failed';
    const latency = result.latencyMs >= 0 ? `${result.latencyMs}ms` : '—';
    return `<span class="aca-result ${className}" title="${escapeHtml(result.message)}（${escapeHtml(formatTime(result.testedAt))}）">${result.ok ? '✓' : '✗'} ${latency}</span>`;
}

function getProfileHint(profile) {
    const api = profile.api || '未知 API';
    const model = profile.model || '未设置模型';
    return `${api} · ${model}`;
}

async function switchProfileByName(profileName) {
    const context = getContext();
    const command = context.SlashCommandParser?.commands?.['profile'];
    if (!command) {
        throw new Error('未找到内置 /profile 命令，请先启用 Connection Profiles 扩展。');
    }
    const switchedName = await command.callback({ await: 'true', timeout: SWITCH_TIMEOUT_MS }, profileName);
    if (!switchedName) {
        throw new Error(`切换失败：找不到连接档案「${profileName}」。`);
    }
    renderAll();
    return switchedName;
}

async function testProfileById(profileId) {
    const profile = findProfileById(profileId);
    if (!profile) {
        throw new Error('找不到这个连接档案。');
    }
    const shared = await import('../../shared.js');
    const service = shared.ConnectionManagerRequestService;
    if (!service?.sendRequest) {
        throw new Error('当前酒馆版本不支持连接测试服务。');
    }
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), TEST_TIMEOUT_MS);
    const startedAt = performance.now();
    try {
        await service.sendRequest(profileId, TEST_PROMPT, TEST_MAX_TOKENS, {
            stream: false,
            signal: controller.signal,
            extractData: true,
            includePreset: false,
            includeInstruct: false,
        });
        return {
            ok: true,
            latencyMs: Math.round(performance.now() - startedAt),
            message: '连接成功',
            testedAt: Date.now(),
        };
    } catch (error) {
        const reason = error?.cause?.message ?? error?.message ?? '未知错误';
        return {
            ok: false,
            latencyMs: Math.round(performance.now() - startedAt),
            message: `连接失败：${reason}`,
            testedAt: Date.now(),
        };
    } finally {
        clearTimeout(timeoutId);
    }
}

async function runTest(profileId, button) {
    const originalText = button.textContent;
    button.disabled = true;
    button.textContent = '测试中…';
    try {
        const result = await testProfileById(profileId);
        const settings = getSettings();
        settings.testResults[profileId] = result;
        saveSettings();
        renderAll();
        if (!result.ok) {
            toastr?.warning?.(result.message, 'API 连接测试');
        }
    } catch (error) {
        toastr?.error?.(error?.message ?? String(error), 'API 连接测试');
    } finally {
        button.disabled = false;
        button.textContent = originalText;
    }
}

function renderProfileRow(profile, isActive) {
    const activeClass = isActive ? ' is-active' : '';
    return `
        <div class="aca-profile-row${activeClass}" data-profile-id="${escapeHtml(profile.id)}">
            <span class="aca-profile-name" title="${escapeHtml(profile.name)}">${escapeHtml(profile.name)}</span>
            <span class="aca-profile-meta" title="${escapeHtml(getProfileHint(profile))}">${escapeHtml(getProfileHint(profile))}</span>
            ${getResultBadge(profile.id)}
            <button type="button" class="aca-button menu_button" data-action="test">测试</button>
        </div>
    `;
}

function renderSettingsList() {
    const container = document.getElementById('aca-profile-list');
    if (!container) {
        return;
    }
    const connectionManager = getConnectionManager();
    if (!connectionManager) {
        container.innerHTML = '<div class="aca-description">未检测到内置 Connection Profiles 扩展，请先启用它并创建连接档案。</div>';
        return;
    }
    const profiles = getProfiles();
    const selectedProfileId = connectionManager.selectedProfile;
    if (profiles.length === 0) {
        container.innerHTML = '<div class="aca-description">还没有连接档案。请先在酒馆自带的 Connection Profiles 里创建一个。</div>';
        return;
    }
    container.innerHTML = profiles
        .map((profile) => renderProfileRow(profile, profile.id === selectedProfileId))
        .join('');
}

function renderApiEntry() {
    const entry = document.getElementById('aca-api-entry');
    if (!entry) {
        return;
    }
    const connectionManager = getConnectionManager();
    const select = document.getElementById('aca-api-select');
    const result = document.getElementById('aca-api-result');
    if (!connectionManager || !select || !result) {
        return;
    }
    const profiles = getProfiles();
    if (profiles.length === 0) {
        select.innerHTML = '<option value="">暂无连接档案</option>';
        result.textContent = '';
        return;
    }
    const selectedProfileId = connectionManager.selectedProfile;
    select.innerHTML = profiles
        .map((profile) => {
            const selected = profile.id === selectedProfileId ? ' selected' : '';
            return `<option value="${escapeHtml(profile.id)}"${selected}>${escapeHtml(profile.name)}</option>`;
        })
        .join('');
    const badge = getSettings().testResults[selectedProfileId];
    result.innerHTML = badge ? getResultBadge(selectedProfileId) : '';
}

function renderFloatWindow() {
    const list = document.getElementById('aca-float-list');
    const ball = document.getElementById('aca-float-ball');
    const floatRoot = document.getElementById('aca-float-root');
    if (!list || !ball || !floatRoot) {
        return;
    }
    const settings = getSettings();
    const enabled = settings.floatWindowEnabled;
    ball.classList.toggle('hidden', !enabled);
    floatRoot.classList.toggle('hidden', !enabled);
    if (!enabled) {
        return;
    }
    const connectionManager = getConnectionManager();
    if (!connectionManager) {
        list.innerHTML = '<div>未检测到 Connection Profiles</div>';
        return;
    }
    const profiles = getProfiles();
    const selectedProfileId = connectionManager.selectedProfile;
    if (profiles.length === 0) {
        list.innerHTML = '<div>暂无连接档案</div>';
        return;
    }
    list.innerHTML = profiles
        .map((profile) => {
            const activeClass = profile.id === selectedProfileId ? ' is-active' : '';
            return `
                <div class="aca-float-item${activeClass}" data-profile-id="${escapeHtml(profile.id)}">
                    <button type="button" class="aca-float-name" title="${escapeHtml(profile.name)}">${escapeHtml(profile.name)}</button>
                    <button type="button" class="aca-button menu_button" data-action="test">测</button>
                </div>
            `;
        })
        .join('');
}

function renderAll() {
    renderSettingsList();
    renderApiEntry();
    renderFloatWindow();
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

    const root = document.createElement('div');
    root.id = 'aca-float-root';
    root.dataset.extensionId = MODULE_ID;
    root.classList.add('hidden');
    root.innerHTML = `
        <div class="aca-float-header">
            <span>API 快切</span>
            <button type="button" class="aca-float-close" title="收起">×</button>
        </div>
        <div id="aca-float-list"></div>
    `;
    root.querySelector('.aca-float-close')?.addEventListener('click', () => {
        root.classList.add('hidden');
    });
    root.addEventListener('click', async (event) => {
        const button = event.target.closest('button');
        if (!button) {
            return;
        }
        const item = button.closest('.aca-float-item');
        if (!item) {
            return;
        }
        const profileId = item.dataset.profileId;
        const profile = findProfileById(profileId);
        if (!profile) {
            return;
        }
        if (button.classList.contains('aca-float-name')) {
            try {
                await switchProfileByName(profile.name);
            } catch (error) {
                toastr?.error?.(error?.message ?? String(error), 'API 连接助手');
            }
            return;
        }
        if (button.dataset.action === 'test') {
            await runTest(profileId, button);
        }
    });

    document.body.append(ball, root);
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
            <button type="button" id="aca-api-switch" class="aca-button menu_button">切换</button>
            <button type="button" id="aca-api-test" class="aca-button menu_button">测试</button>
            <span id="aca-api-result"></span>
        </div>
    `;
    entry.querySelector('#aca-api-switch')?.addEventListener('click', async () => {
        const profileId = document.getElementById('aca-api-select')?.value;
        const profile = findProfileById(profileId);
        if (!profile) {
            return;
        }
        try {
            await switchProfileByName(profile.name);
        } catch (error) {
            toastr?.error?.(error?.message ?? String(error), 'API 连接助手');
        }
    });
    entry.querySelector('#aca-api-test')?.addEventListener('click', async (event) => {
        const profileId = document.getElementById('aca-api-select')?.value;
        if (!profileId) {
            return;
        }
        await runTest(profileId, event.currentTarget);
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
    document.getElementById('aca-profile-list')?.addEventListener('click', async (event) => {
        const button = event.target.closest('button[data-action="test"]');
        if (!button) {
            return;
        }
        const profileId = button.closest('.aca-profile-row')?.dataset.profileId;
        if (!profileId) {
            return;
        }
        await runTest(profileId, button);
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


