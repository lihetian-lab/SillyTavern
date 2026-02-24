/**
 * PRTS Narrative Engine v2 — Pure UI Shell + Command Registry
 *
 * Architecture:
 * - This file is ONLY a display shell and state store.
 * - It contains ZERO generation logic, ZERO prompt templates.
 * - Every button click executes an STscript pipeline (configurable).
 * - Slash commands are pure state read/write + display operations.
 * - External STscript pipelines call these commands to drive the UI.
 *
 * Command categories:
 *   Display:  /prts-display  — push text/html into the story canvas
 *   Cards:    /prts-card     — add/remove/list/clear perception & deduction cards
 *   State:    /prts-state    — get/set arbitrary state fields
 *   Timeline: /prts-timeline — add/jump/list/clear timeline nodes
 *   Scene:    /prts-scene    — set/append/clear scene blocks
 *   History:  /prts-history  — add/list/clear log entries
 *   Items:    /prts-inventory— add/remove/clear/list inventory items
 *   Stream:   /prts-stream   — start/append/commit/cancel live streaming display
 *   UI:       /prts          — toggle on/off
 *             /prts-mode     — switch mode (actor/director/editor)
 *             /prts-vibe     — set emotional tone
 *             /prts-reset    — full state reset
 *
 * Button bindings (configurable via /prts-bind):
 *   Each UI button has an id → maps to an STscript string.
 *   When clicked, the STscript is executed via executeSlashCommandsWithOptions.
 */

import { eventSource, event_types } from '../../../../script.js';
import { getContext } from '../../../st-context.js';
import { SlashCommandParser } from '../../../slash-commands/SlashCommandParser.js';
import { SlashCommand } from '../../../slash-commands/SlashCommand.js';
import { ARGUMENT_TYPE, SlashCommandArgument, SlashCommandNamedArgument } from '../../../slash-commands/SlashCommandArgument.js';

// ═══════════════════════════════════════════════════════════
//  CONSTANTS
// ═══════════════════════════════════════════════════════════

const EXTENSION_NAME = 'prts-engine';

const MODES = { ACTOR: 'actor', DIRECTOR: 'director', EDITOR: 'editor' };

/** Default hotkey to toggle PRTS on/off (can be overridden per-chat via /prts-hotkey) */
const DEFAULT_HOTKEY = 'F12';

/**
 * SillyTavern chrome elements to hide when PRTS is active.
 * We tag each with data-prts-hidden so we only restore what we hid.
 */
const PRTS_CHROME_SELECTORS = [
    '#top-bar',
    '#left-nav-panel',
    '#right-nav-panel',
    '#top-settings-holder',
];

const VIBES = [
    { id: 'neutral',  icon: '⚬', color: '#ffb000', title: '中性' },
    { id: 'conflict', icon: '⚡', color: '#ff3333', title: '冲突' },
    { id: 'intimacy', icon: '♥', color: '#ff66cc', title: '官能' },
    { id: 'horror',   icon: '☠', color: '#ffffff', title: '惊悚' },
];

/**
 * Default button → STscript bindings.
 * Keys are button element IDs. Values are STscript strings to execute on click.
 * Users can override these via /prts-bind or by editing chat_metadata.
 *
 * Available template variables (expanded at execution time):
 *   {{prtsInput}}     — text from the actor hub input
 *   {{prtsDirector}}  — text from the director input
 *   {{prtsVibe}}      — current vibe string
 *   {{prtsMode}}      — current mode string
 */
const DEFAULT_BINDINGS = {
    'prts-actor-commit': '/prts-commit {{prtsInput}}',
    'prts-director-commit': '/prts-override {{prtsDirector}}',
    'prts-add-perception': '/prts-perception',
    'prts-add-deduction': '/prts-deduction',
    'prts-auto-wait': '/prts-auto type=wait',
    'prts-auto-continue': '/prts-auto type=continue',
    'prts-auto-skip': '/prts-auto type=skip',
    'prts-editor-branch': '/prts-timeline action=add type=branch desc="Branch at scene {{prtsSceneCount}}"',
    'prts-editor-rewind': '/prts-timeline action=back',
    'prts-editor-bookmark': '/prts-timeline action=add type=bookmark desc="Bookmark at scene {{prtsSceneCount}}"',
    'prts-gen-stop': '/stop',
};

const DEFAULT_STATE = () => ({
    active: false,
    mode: MODES.ACTOR,
    vibe: 'neutral',
    timeline: [],
    timelineIndex: -1,
    perceptionCards: [],
    deductionCards: [],
    historyLog: [],
    inventory: [],
    sceneBlocks: [],
    currentScene: '',
    generating: false,
    bindings: {},
    hotkey: DEFAULT_HOTKEY,
});

// ═══════════════════════════════════════════════════════════
//  STATE MANAGEMENT (persisted in chat_metadata)
// ═══════════════════════════════════════════════════════════

let state = DEFAULT_STATE();

function loadState() {
    const ctx = getContext();
    const saved = ctx.chatMetadata?.prts_state;
    if (saved) {
        state = Object.assign(DEFAULT_STATE(), JSON.parse(JSON.stringify(saved)));
    } else {
        state = DEFAULT_STATE();
    }
}

function saveState() {
    const ctx = getContext();
    if (ctx.chatMetadata) {
        ctx.chatMetadata.prts_state = JSON.parse(JSON.stringify(state));
        ctx.saveMetadataDebounced();
    }
}

// ═══════════════════════════════════════════════════════════
//  HOTKEY SYSTEM
// ═══════════════════════════════════════════════════════════

/**
 * Parse a hotkey string like "F12", "Ctrl+Shift+P", "Alt+F4".
 * Returns { ctrl, alt, shift, meta, key } or null.
 * @param {string} str
 */
function parseHotkey(str) {
    if (!str) return null;
    const parts = str.split('+').map(p => p.trim());
    const modifiers = new Set(parts.map(p => p.toLowerCase()));
    const key = parts.find(p => !['ctrl', 'control', 'alt', 'shift', 'meta', 'cmd', 'win'].includes(p.toLowerCase()));
    if (!key) return null;
    return {
        ctrl:  modifiers.has('ctrl') || modifiers.has('control'),
        alt:   modifiers.has('alt'),
        shift: modifiers.has('shift'),
        meta:  modifiers.has('meta') || modifiers.has('cmd') || modifiers.has('win'),
        key:   key,
    };
}

/**
 * Test whether a KeyboardEvent matches a hotkey string.
 * @param {KeyboardEvent} event
 * @param {string} str
 */
function matchesHotkey(event, str) {
    const hk = parseHotkey(str);
    if (!hk) return false;
    // Compare key case-insensitively for letters, exactly for F-keys / special keys
    const keyMatch = event.key.toLowerCase() === hk.key.toLowerCase()
        || event.code.toLowerCase() === hk.key.toLowerCase();
    return keyMatch
        && event.ctrlKey  === hk.ctrl
        && event.altKey   === hk.alt
        && event.shiftKey === hk.shift
        && event.metaKey  === hk.meta;
}

// ═══════════════════════════════════════════════════════════
//  CHROME HIDE / RESTORE
//  Hides SillyTavern's menu bar and sidebars when PRTS is
//  active. Only restores elements that PRTS itself hid.
// ═══════════════════════════════════════════════════════════

function hideSTChrome() {
    for (const sel of PRTS_CHROME_SELECTORS) {
        const el = document.querySelector(sel);
        if (el && !el.dataset.prtsHidden) {
            el.dataset.prtsHidden = el.style.display || '__auto__';
            el.style.display = 'none';
        }
    }
}

function restoreSTChrome() {
    for (const sel of PRTS_CHROME_SELECTORS) {
        const el = document.querySelector(sel);
        if (el && el.dataset.prtsHidden !== undefined) {
            el.style.display = el.dataset.prtsHidden === '__auto__' ? '' : el.dataset.prtsHidden;
            delete el.dataset.prtsHidden;
        }
    }
}

// ═══════════════════════════════════════════════════════════
//  GLOBAL KEYDOWN HANDLER
// ═══════════════════════════════════════════════════════════

function onGlobalKeydown(event) {
    const hotkeyStr = state.hotkey || DEFAULT_HOTKEY;
    const hk = parseHotkey(hotkeyStr);

    // Suppress hotkey if user is typing in a text field, UNLESS the hotkey
    // is a bare F-key (F1–F12), which should always fire.
    const tag = document.activeElement?.tagName?.toLowerCase() ?? '';
    const isEditable = ['input', 'textarea', 'select'].includes(tag)
        || document.activeElement?.isContentEditable;
    const isFKey = hk && /^f\d+$/i.test(hk.key);

    if (isEditable && !isFKey) return;

    if (matchesHotkey(event, hotkeyStr)) {
        event.preventDefault();
        event.stopPropagation();
        state.active = !state.active;
        saveState();
        updateUI();
        return;
    }

    // Escape always exits PRTS (only when active, to avoid stealing ST Escape)
    if (event.key === 'Escape' && state.active) {
        event.preventDefault();
        state.active = false;
        saveState();
        updateUI();
    }
}

// ═══════════════════════════════════════════════════════════
//  BUTTON BINDING SYSTEM
//  Every UI button executes an STscript pipeline.
//  Bindings are resolved: user overrides > defaults.
// ═══════════════════════════════════════════════════════════

function getBinding(buttonId) {
    return state.bindings[buttonId] || DEFAULT_BINDINGS[buttonId] || '';
}

/**
 * Expand template variables in a binding string.
 * @param {string} script — the STscript template
 * @returns {string}
 */
function expandBindingVars(script) {
    const hubInput = document.getElementById('prts-hub-input');
    const dirInput = document.getElementById('prts-director-input');
    return script
        .replace(/\{\{prtsInput\}\}/g, hubInput ? hubInput.value.trim() : '')
        .replace(/\{\{prtsDirector\}\}/g, dirInput ? dirInput.value.trim() : '')
        .replace(/\{\{prtsVibe\}\}/g, state.vibe)
        .replace(/\{\{prtsMode\}\}/g, state.mode)
        .replace(/\{\{prtsSceneCount\}\}/g, String(state.sceneBlocks.length));
}

/**
 * Execute a button's bound STscript.
 * @param {string} buttonId
 */
async function executeBinding(buttonId) {
    const raw = getBinding(buttonId);
    if (!raw) return;

    const script = expandBindingVars(raw);
    const ctx = getContext();

    try {
        await ctx.executeSlashCommandsWithOptions(script);
    } catch (err) {
        console.error(`[PRTS] Binding execution error (${buttonId}):`, err);
    }

    // Clear inputs after commit actions
    if (buttonId === 'prts-actor-commit') {
        const hubInput = document.getElementById('prts-hub-input');
        const finalText = document.getElementById('prts-final-text');
        if (hubInput)   hubInput.value = '';
        if (finalText)  finalText.value = '';
        // Flip back to front
        const hubContainer = document.getElementById('hub-container');
        if (hubContainer) hubContainer.classList.remove('flipped');
        const colPerc = document.getElementById('col-perc');
        const colDedu = document.getElementById('col-dedu');
        if (colPerc) colPerc.classList.remove('temp-disabled');
        if (colDedu) colDedu.classList.remove('temp-disabled');
    }
    if (buttonId === 'prts-director-commit') {
        const dirInput = document.getElementById('prts-director-input');
        if (dirInput) dirInput.value = '';
    }
}

// ═══════════════════════════════════════════════════════════
//  STATE MUTATION HELPERS (called by slash commands)
// ═══════════════════════════════════════════════════════════

function appendSceneBlock(text, source = '') {
    state.sceneBlocks.push({
        id: Date.now(),
        text: text,
        source: source,
        timestamp: new Date().toISOString(),
    });
    state.currentScene = text;
}

function addTimelineNode(type, desc) {
    state.timeline.push({
        id: Date.now(),
        type: type,
        desc: desc,
        timestamp: new Date().toISOString(),
    });
    state.timelineIndex = state.timeline.length - 1;
}

function addHistoryEntry(type, text) {
    state.historyLog.push({
        id: Date.now(),
        type: type,
        text: text,
        timestamp: new Date().toISOString(),
    });
    if (state.historyLog.length > 100) {
        state.historyLog = state.historyLog.slice(-100);
    }
}

function addPerceptionCard(text) {
    state.perceptionCards.push({ id: Date.now(), text: text.trim() });
}

function addDeductionCard(text) {
    state.deductionCards.push({ id: Date.now(), text: text.trim() });
}

function removeCard(type, id) {
    if (type === 'perception') {
        state.perceptionCards = state.perceptionCards.filter(c => c.id !== id);
    } else if (type === 'deduction') {
        state.deductionCards = state.deductionCards.filter(c => c.id !== id);
    }
    saveState();
    updateUI();
}

function setMode(mode) {
    if (Object.values(MODES).includes(mode)) {
        state.mode = mode;
        saveState();
        updateUI();
    }
}

function setVibe(vibe) {
    state.vibe = vibe;
    saveState();
    updateUI();
}

// ═══════════════════════════════════════════════════════════
//  UI — HTML TEMPLATE
// ═══════════════════════════════════════════════════════════

function buildHTML() {
    const vibeButtons = VIBES.map(v =>
        `<button class="vibe-btn${state.vibe === v.id ? ' active' : ''}" data-vibe="${v.id}" style="color:${v.color}" title="${v.title}">${v.icon}</button>`,
    ).join('');

    const actorActive    = state.mode === MODES.ACTOR    ? ' active' : '';
    const directorActive = state.mode === MODES.DIRECTOR ? ' active' : '';
    const editorActive   = state.mode === MODES.EDITOR   ? ' active' : '';

    return `
<div id="prts-engine" class="${state.active ? 'console-closed' : 'hidden'}">

    <!-- CRT scanline overlay -->
    <div id="channel-noise"></div>

    <!-- ═══ Top Stage ═══ -->
    <div class="top-stage" id="prts-top-stage">

        <!-- Story Canvas -->
        <div class="story-canvas" id="prts-story-canvas">
            <span class="scene-header" id="prts-scene-header">PRTS // NARRATIVE ENGINE</span>
            <div id="prts-scene-container"></div>
        </div>

        <!-- Right Side Frame -->
        <div class="sd-frame">
            <!-- Tab nav -->
            <div class="side-tabs">
                <button class="side-tab-btn chamfer-btn active" data-tab="visual">[ VISUAL ]</button>
                <button class="side-tab-btn chamfer-btn" data-tab="history">[ HISTORY ]</button>
                <button class="side-tab-btn chamfer-btn" data-tab="custom">[ CUSTOM ]</button>
            </div>

            <!-- Content stack -->
            <div class="side-content-wrapper">

                <!-- 1. Visual panel -->
                <div id="panel-visual" class="side-panel active">
                    <div class="visual-cg chamfer">
                        <div class="cam-label">CAM_01 // VISUAL_FEED</div>
                        <div class="sd-placeholder" id="prts-cg-frame">AWAITING_INPUT...</div>
                    </div>
                    <div class="visual-portrait chamfer">
                        <div class="cam-label" style="color:var(--ak-yellow)">CAM_02 // PORTRAIT</div>
                        <div class="silhouette"></div>
                        <span class="p-name" id="prts-portrait-name">UNKNOWN ENTITY</span>
                    </div>
                </div>

                <!-- 2. History panel -->
                <div id="panel-history" class="side-panel">
                    <div class="history-list chamfer" id="prts-history-list"></div>
                </div>

                <!-- 3. Custom panel (map / terminal / inventory) -->
                <div id="panel-custom" class="side-panel">
                    <div class="custom-nav">
                        <button class="c-nav-btn active" data-custom="map">MAP</button>
                        <button class="c-nav-btn" data-custom="term">TERMINAL</button>
                        <button class="c-nav-btn" data-custom="inv">INVENTORY</button>
                    </div>
                    <div class="custom-viewport chamfer">
                        <div id="c-view-map" class="c-view active">
                            <span class="c-label">TACTICAL_MAP // SECTOR</span>
                            <div class="radar-bg"></div>
                            <div class="radar-ping"></div>
                        </div>
                        <div id="c-view-term" class="c-view">
                            <span class="c-label" style="color:#00ff00">PRTS_TERMINAL_LINK</span>
                            <div class="term-screen" id="prts-terminal">&gt; PRTS ONLINE<br>&gt; _</div>
                        </div>
                        <div id="c-view-inv" class="c-view">
                            <span class="c-label">GEAR_INVENTORY //</span>
                            <div class="inv-grid" id="prts-inventory-list"></div>
                        </div>
                    </div>
                </div>

            </div>
        </div>
    </div>

    <!-- ═══ Console Wrapper ═══ -->
    <div class="console-wrapper" id="prts-console-wrapper">

        <!-- Toggle tab (trapezoid) -->
        <button class="console-toggle" id="prts-console-toggle">▲ 唤出战术矩阵 [ EXPAND ]</button>

        <!-- Mode shifter (floats above, hidden when console closed) -->
        <div class="mode-shifter chamfer-btn">
            <button class="mode-btn${actorActive}"    data-mode="actor">[01] ACTOR</button>
            <button class="mode-btn${directorActive}" data-mode="director">[02] DIRECTOR</button>
            <button class="mode-btn${editorActive}"   data-mode="editor">[03] EDITOR</button>
        </div>

        <!-- Auto-progress bar (visible when console closed) -->
        <div class="auto-progress-bar">
            <button class="auto-btn" id="prts-auto-wait">⏳ 静观其变 (Wait &amp; See)</button>
            <button class="auto-btn" id="prts-auto-continue">▶ 自然推进 (Auto-Progress)</button>
            <button class="auto-btn" id="prts-auto-skip">⏭ 快速跳过 (Fast Forward)</button>
        </div>

        <!-- Expanded console panels -->
        <div class="expanded-console" id="prts-expanded-console">

            <!-- [01] Actor Mode -->
            <div class="dock-container${actorActive}" id="mode-actor">
                <div style="flex: 0 0 calc(65% - 20px); display: flex; gap: 20px;">

                    <!-- Hub column (flip card) -->
                    <div class="matrix-col" id="col-hub" style="flex: 1.6; margin: 0;">
                        <div class="flip-container" id="hub-container">
                            <div class="flipper">
                                <!-- Front: intent input -->
                                <div class="front">
                                    <div class="m-header">
                                        <span>TACTICAL_HUB // 中枢</span>
                                        <div class="vibe-controls">${vibeButtons}</div>
                                    </div>
                                    <div class="t-list" id="prts-hub-options"></div>
                                    <div class="m-input-area" style="flex-direction: column;">
                                        <span style="font-family:var(--font-tech); font-size:0.7rem; color:var(--text-dim);">DIRECTIVE_OVERRIDE // 意图覆写</span>
                                        <input type="text" class="m-input" id="prts-hub-input" placeholder="输入行动意图...">
                                    </div>
                                    <div class="action-bar">
                                        <span style="font-family:var(--font-tech); font-size:0.7rem; color:var(--text-dim);" id="prts-hub-status">AWAITING...</span>
                                        <button class="btn-action warning chamfer-btn" id="prts-flip-btn">INITIATE_FLIP &gt;&gt;</button>
                                    </div>
                                </div>
                                <!-- Back: final text + commit -->
                                <div class="back">
                                    <div class="m-header" style="justify-content:center;">EXECUTION_TRACK // 最终轨迹</div>
                                    <textarea class="final-textarea" id="prts-final-text" placeholder="最终行动文本将在此呈现..."></textarea>
                                    <div class="action-bar">
                                        <button class="btn-action chamfer-btn" id="prts-flip-back-btn"
                                            style="background:transparent; border:1px solid var(--ak-yellow); color:var(--ak-yellow) !important;">&lt;&lt; ABORT</button>
                                        <button class="btn-action chamfer-btn warning" id="prts-actor-commit">COMMIT //</button>
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>

                    <!-- Deduction column -->
                    <div class="matrix-col chamfer" id="col-dedu" style="flex: 1; margin: 0;">
                        <div class="m-header">
                            <span style="color:var(--ak-purple)">DEDUCTION // 思考</span>
                            <span class="link-toggle" style="color:var(--ak-purple)" id="prts-dedu-link-toggle">LINKED</span>
                        </div>
                        <div class="stack-area" id="prts-deduction-stack"></div>
                        <div class="m-input-area">
                            <input type="text" class="m-input" id="prts-inp-dedu" placeholder="推演逻辑...">
                            <button class="btn-micro" id="prts-add-deduction">⟳</button>
                        </div>
                    </div>
                </div>

                <!-- Perception column -->
                <div style="flex: 0 0 calc(35% - 20px); display: flex;">
                    <div class="matrix-col chamfer" id="col-perc" style="width: 100%; margin: 0;">
                        <div class="m-header">
                            <span style="color:var(--ak-cyan)">PERCEPTION // 感官</span>
                            <span class="link-toggle" style="color:var(--ak-cyan)" id="prts-perc-link-toggle">LINKED</span>
                        </div>
                        <div class="stack-area" id="prts-perception-stack"></div>
                        <div class="m-input-area">
                            <input type="text" class="m-input" id="prts-inp-perc" placeholder="聚焦方向...">
                            <button class="btn-micro" id="prts-add-perception">⟳</button>
                        </div>
                    </div>
                </div>
            </div>

            <!-- [02] Director Mode -->
            <div class="dock-container${directorActive}" id="mode-director">
                <div class="dir-wrapper">
                    <div class="dir-title">WORLD_OVERRIDE // 机械降神</div>
                    <textarea class="dir-input" id="prts-director-input" placeholder="输入强制改变世界因果律的事件... (例如: 穹顶突然坍塌)"></textarea>
                    <button class="btn-action chamfer-btn" style="background:var(--ak-red); font-size:1rem; padding:10px 30px;"
                        id="prts-director-commit">EXECUTE_OVERRIDE</button>
                </div>
                <div style="flex: 0 0 calc(35% - 20px); display: flex; align-items: center; justify-content: center; opacity: 0.3; border-left: 1px solid var(--border-dim);">
                    <div style="font-family:var(--font-tech); color:var(--text-dim); text-align:center; letter-spacing:2px;">
                        [ SYSTEM_ALERT ]<br>VISUAL_FEED_BYPASSED<br>GOD_MODE_ACTIVE
                    </div>
                </div>
            </div>

            <!-- [03] Editor Mode -->
            <div class="dock-container${editorActive}" id="mode-editor">
                <div style="width: 100%;">
                    <div class="ed-header">
                        <span class="ed-title">NARRATIVE PACE STARTER // 时空拨盘</span>
                        <div style="display:flex; gap:10px; align-items:center;">
                            <span style="font-family:var(--font-tech); font-size:0.75rem; color:var(--text-dim);">SEARCH_PAST:</span>
                            <input type="text" class="m-input" style="width:200px;" id="prts-tl-search" placeholder="输入记忆碎片提取闪回点...">
                        </div>
                    </div>
                    <div class="timeline-viewport">
                        <div class="timeline-needle"></div>
                        <div class="timeline-track" id="prts-timeline-track"></div>
                    </div>
                    <div class="ed-footer">
                        <span class="ed-info" id="prts-tl-info">SELECTED: [ CURRENT ] - 维持当前时间线</span>
                        <div style="display:flex; gap:8px;">
                            <button class="btn-action chamfer-btn" style="background:var(--text-dim);" id="prts-editor-branch">BRANCH &gt;&gt;</button>
                            <button class="btn-action chamfer-btn" style="background:var(--text-main); color:#000;" id="prts-editor-rewind">START_SEQUENCE &gt;&gt;</button>
                        </div>
                    </div>
                </div>
            </div>

        </div><!-- /expanded-console -->
    </div><!-- /console-wrapper -->

    <!-- Status Bar -->
    <div class="prts-status-bar">
        <div class="prts-status-item">
            <div class="prts-status-dot idle" id="prts-status-dot"></div>
            <span id="prts-status-text">IDLE</span>
        </div>
        <span id="prts-status-mode">MODE: ${state.mode.toUpperCase()}</span>
        <span id="prts-status-vibe">VIBE: ${state.vibe.toUpperCase()}</span>
        <span id="prts-status-scene">SCENES: ${state.sceneBlocks.length}</span>
        <span id="prts-status-hotkey" style="margin-left:auto; opacity:0.45; cursor:default;"
              title="Change with /prts-hotkey hotkey=...">[${state.hotkey || DEFAULT_HOTKEY}] TOGGLE  ·  [ESC] EXIT</span>
    </div>

</div>`;
}

// ═══════════════════════════════════════════════════════════
//  UI — RENDER & UPDATE
// ═══════════════════════════════════════════════════════════

function injectUI() {
    const existing = document.getElementById('prts-engine');
    if (existing) existing.remove();

    const sheld = document.getElementById('sheld');
    if (!sheld) {
        console.error('[PRTS] Cannot find #sheld container');
        return;
    }
    sheld.insertAdjacentHTML('beforeend', buildHTML());

    if (!document.getElementById('prts-toggle-btn')) {
        const topBar = document.getElementById('top-bar');
        if (topBar) {
            const btn = document.createElement('button');
            btn.id = 'prts-toggle-btn';
            btn.innerHTML = '◈ PRTS';
            btn.title = `Toggle PRTS Narrative Engine  [${state.hotkey || DEFAULT_HOTKEY}]`;
            topBar.appendChild(btn);
        }
    }

    bindEvents();
    updateUI();
}

function updateUI() {
    const engine = document.getElementById('prts-engine');
    if (!engine) return;

    // Show/hide engine + ST chrome
    if (!state.active) {
        engine.classList.add('hidden');
        engine.classList.remove('console-open', 'console-closed');
        restoreSTChrome();
    } else {
        engine.classList.remove('hidden');
        if (!engine.classList.contains('console-open') && !engine.classList.contains('console-closed')) {
            engine.classList.add('console-closed');
        }
        hideSTChrome();
    }

    // ST toggle button
    const toggleBtn = document.getElementById('prts-toggle-btn');
    if (toggleBtn) toggleBtn.classList.toggle('active', state.active);

    // Hide ST chat & input when active
    const chatBlock = document.getElementById('chat');
    const sendForm = document.getElementById('send_form');
    if (chatBlock) chatBlock.style.display = state.active ? 'none' : '';
    if (sendForm) sendForm.style.display = state.active ? 'none' : '';

    if (!state.active) return;

    // Mode buttons
    engine.querySelectorAll('.mode-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.mode === state.mode);
    });

    // Dock containers
    engine.querySelectorAll('.dock-container').forEach(el => {
        el.classList.toggle('active', el.id === `mode-${state.mode}`);
    });

    // Vibe buttons
    engine.querySelectorAll('.vibe-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.vibe === state.vibe);
    });

    // Hub vibe glow class
    const colHub = document.getElementById('col-hub');
    if (colHub) {
        colHub.classList.remove('vibe-conflict', 'vibe-intimacy', 'vibe-horror');
        if (state.vibe === 'conflict') colHub.classList.add('vibe-conflict');
        else if (state.vibe === 'intimacy') colHub.classList.add('vibe-intimacy');
        else if (state.vibe === 'horror') colHub.classList.add('vibe-horror');
    }

    // Commit button state
    const actorCommit = document.getElementById('prts-actor-commit');
    const directorCommit = document.getElementById('prts-director-commit');
    if (actorCommit) actorCommit.disabled = state.generating;
    if (directorCommit) directorCommit.disabled = state.generating;

    // Status bar
    const dot = document.getElementById('prts-status-dot');
    const statusText = document.getElementById('prts-status-text');
    if (dot)        dot.className = `prts-status-dot ${state.generating ? 'generating' : 'idle'}`;
    if (statusText) statusText.textContent = state.generating ? 'GENERATING' : 'IDLE';

    const modeStatus  = document.getElementById('prts-status-mode');
    const vibeStatus  = document.getElementById('prts-status-vibe');
    const sceneStatus = document.getElementById('prts-status-scene');
    if (modeStatus)  modeStatus.textContent  = `MODE: ${state.mode.toUpperCase()}`;
    if (vibeStatus)  vibeStatus.textContent  = `VIBE: ${state.vibe.toUpperCase()}`;
    if (sceneStatus) sceneStatus.textContent = `SCENES: ${state.sceneBlocks.length}`;

    const hotkeyStatus = document.getElementById('prts-status-hotkey');
    if (hotkeyStatus) {
        const hk = state.hotkey || DEFAULT_HOTKEY;
        hotkeyStatus.textContent = `[${hk}] TOGGLE  ·  [ESC] EXIT`;
        hotkeyStatus.title = `Hotkey: ${hk}  ·  Change with /prts-hotkey hotkey=...`;
    }

    // Keep toggle button title in sync
    const tbtn = document.getElementById('prts-toggle-btn');
    if (tbtn) tbtn.title = `Toggle PRTS Narrative Engine  [${state.hotkey || DEFAULT_HOTKEY}]`;

    renderSceneBlocks();
    renderPerceptionCards();
    renderDeductionCards();
    renderTimeline();
    renderHistory();
    renderInventory();
}

function renderSceneBlocks() {
    const container = document.getElementById('prts-scene-container');
    if (!container) return;

    container.innerHTML = state.sceneBlocks.map((block, i) => {
        const sourceLabel = block.source ? block.source.replace(/_/g, ' ').toUpperCase() : '';
        const cssClass = block.source === 'actor_action' ? 'highlight-action'
            : block.source === 'director_override' ? 'highlight-director' : '';
        return `
            <div class="prts-scene-block" style="animation-delay: ${i * 0.05}s">
                ${sourceLabel ? `<span class="scene-header" style="margin-bottom:8px;">${escapeHtml(sourceLabel)}</span>` : ''}
                <p class="${cssClass}">${formatNarrative(block.text)}</p>
            </div>
            ${i < state.sceneBlocks.length - 1 ? '<div class="prts-scene-divider">◆</div>' : ''}
        `;
    }).join('');

    if (state.generating) {
        const lastBlock = container.querySelector('.prts-scene-block:last-of-type p');
        if (lastBlock) {
            lastBlock.insertAdjacentHTML('beforeend', '<span class="prts-cursor"></span>');
        }
    }

    // Scroll story canvas to bottom
    const canvas = document.getElementById('prts-story-canvas');
    if (canvas) canvas.scrollTop = canvas.scrollHeight;
}

function renderPerceptionCards() {
    const stack = document.getElementById('prts-perception-stack');
    if (!stack) return;

    stack.innerHTML = state.perceptionCards.map((card, i) => `
        <div class="m-card collapsed" data-id="${card.id}" onclick="this.classList.toggle('collapsed'); this.querySelector('.m-card-header span').innerHTML = this.classList.contains('collapsed') ? this.querySelector('.m-card-header span').innerHTML.replace('[-]','[+]') : this.querySelector('.m-card-header span').innerHTML.replace('[+]','[-]')">
            <div class="m-card-header">
                <span>[+] S.${String(i + 1).padStart(2, '0')} 感官</span>
                <div class="card-tools">
                    <button class="btn-micro card-close" data-card-type="perception" data-card-id="${card.id}" onclick="event.stopPropagation()">✕</button>
                </div>
            </div>
            <div class="m-card-content">${escapeHtml(card.text)}</div>
        </div>
    `).join('');
}

function renderDeductionCards() {
    const stack = document.getElementById('prts-deduction-stack');
    if (!stack) return;

    stack.innerHTML = state.deductionCards.map((card, i) => `
        <div class="m-card dedu collapsed" data-id="${card.id}" onclick="this.classList.toggle('collapsed'); this.querySelector('.m-card-header span').innerHTML = this.classList.contains('collapsed') ? this.querySelector('.m-card-header span').innerHTML.replace('[-]','[+]') : this.querySelector('.m-card-header span').innerHTML.replace('[+]','[-]')">
            <div class="m-card-header">
                <span>[+] D.${String(i + 1).padStart(2, '0')} 推演</span>
                <div class="card-tools">
                    <button class="btn-micro card-close" data-card-type="deduction" data-card-id="${card.id}" onclick="event.stopPropagation()">✕</button>
                </div>
            </div>
            <div class="m-card-content">${escapeHtml(card.text)}</div>
        </div>
    `).join('');
}

function renderTimeline() {
    const track = document.getElementById('prts-timeline-track');
    if (!track) return;

    const NODE_SPACING = 150;

    track.innerHTML = state.timeline.map((node, i) => {
        const isLast = i === state.timeline.length - 1;
        const isActive = i === state.timelineIndex;
        // Map internal type to display type
        const typeClass = node.type.includes('past') ? 'type-past'
            : node.type.includes('future') ? 'type-future' : 'type-current';
        const timeLabel = formatTime(node.timestamp) || node.type;
        return `
            <div class="tl-node ${typeClass}${isActive ? ' active' : ''}${isLast ? ' last-node' : ''}"
                 style="left:${i * NODE_SPACING}px" data-index="${i}">
                <div class="tl-time">${escapeHtml(timeLabel)}</div>
                <div class="tl-dot"></div>
                <div class="tl-tag">${escapeHtml(node.desc.substring(0, 20))}</div>
            </div>
        `;
    }).join('');

    // Shift track so active node is centered
    const offset = -(state.timelineIndex * NODE_SPACING);
    track.style.transform = `translateX(${offset}px)`;

    // Update info label
    const info = document.getElementById('prts-tl-info');
    if (info && state.timeline[state.timelineIndex]) {
        const node = state.timeline[state.timelineIndex];
        info.textContent = `SELECTED: [ ${formatTime(node.timestamp)} ] - ${node.desc.substring(0, 40)}`;
    } else if (info) {
        info.textContent = 'SELECTED: [ CURRENT ] - 维持当前时间线';
    }
}

function renderHistory() {
    const list = document.getElementById('prts-history-list');
    if (!list) return;

    const entries = [...state.historyLog].reverse().slice(0, 50);
    if (entries.length === 0) {
        list.innerHTML = '<div class="hist-item" style="color:var(--text-dim); font-size:0.8rem;">No history yet.</div>';
        return;
    }
    list.innerHTML = entries.map(entry => {
        const isAction = entry.type === 'actor_commit' || entry.type === 'auto_wait' || entry.type === 'auto_continue' || entry.type === 'auto_skip';
        return `
            <div class="hist-item${isAction ? ' action' : ''}">
                <span class="hist-time">${formatTime(entry.timestamp)} [${entry.type}]</span>
                ${escapeHtml(entry.text)}
            </div>
        `;
    }).join('');
}

function renderInventory() {
    const list = document.getElementById('prts-inventory-list');
    if (!list) return;

    // Render filled slots first, then empty slots to fill an 8-slot grid
    const slots = [...state.inventory];
    const totalSlots = Math.max(8, Math.ceil(slots.length / 4) * 4);

    let html = slots.map(item => `
        <div class="inv-slot filled" title="${escapeHtml(item.name)}">
            <span>${escapeHtml(item.icon || '?')}</span>
            ${item.qty ? `<span class="inv-count">${escapeHtml(String(item.qty))}</span>` : ''}
        </div>
    `).join('');

    // Pad with empty slots
    for (let i = slots.length; i < totalSlots; i++) {
        html += '<div class="inv-slot"></div>';
    }

    list.innerHTML = html;
}

// ═══════════════════════════════════════════════════════════
//  UI — EVENT BINDINGS
//  All action buttons call executeBinding() → STscript.
//  Mode/vibe/tab switches are pure local state changes.
// ═══════════════════════════════════════════════════════════

function bindEvents() {
    const engine = document.getElementById('prts-engine');
    if (!engine) return;

    // ── ST header toggle button ──
    const toggleBtn = document.getElementById('prts-toggle-btn');
    if (toggleBtn) {
        toggleBtn.addEventListener('click', () => {
            state.active = !state.active;
            saveState();
            updateUI();
        });
    }

    // ── Console open/close ──
    const consoleToggle = document.getElementById('prts-console-toggle');
    if (consoleToggle) {
        consoleToggle.addEventListener('click', () => {
            const isOpen = engine.classList.contains('console-open');
            engine.classList.toggle('console-open',  !isOpen);
            engine.classList.toggle('console-closed',  isOpen);
            consoleToggle.textContent = isOpen
                ? '▲ 唤出战术矩阵 [ EXPAND ]'
                : '▼ 收起战术矩阵 [ COLLAPSE ]';
            // Auto-scroll story canvas after transition
            setTimeout(() => {
                const canvas = document.getElementById('prts-story-canvas');
                if (canvas) canvas.scrollTop = canvas.scrollHeight;
            }, 650);
        });
    }

    // ── Mode switcher ──
    engine.querySelectorAll('.mode-btn').forEach(btn => {
        btn.addEventListener('click', () => setMode(btn.dataset.mode));
    });

    // ── Vibe buttons ──
    engine.querySelectorAll('.vibe-btn').forEach(btn => {
        btn.addEventListener('click', () => setVibe(btn.dataset.vibe));
    });

    // ── Side panel tabs ──
    engine.querySelectorAll('.side-tab-btn').forEach(tab => {
        tab.addEventListener('click', () => {
            engine.querySelectorAll('.side-tab-btn').forEach(t => t.classList.remove('active'));
            engine.querySelectorAll('.side-panel').forEach(p => p.classList.remove('active'));
            tab.classList.add('active');
            const panel = document.getElementById(`panel-${tab.dataset.tab}`);
            if (panel) panel.classList.add('active');
        });
    });

    // ── Custom sub-panel nav ──
    engine.querySelectorAll('.c-nav-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            engine.querySelectorAll('.c-nav-btn').forEach(b => b.classList.remove('active'));
            engine.querySelectorAll('.c-view').forEach(v => v.classList.remove('active'));
            btn.classList.add('active');
            const view = document.getElementById(`c-view-${btn.dataset.custom}`);
            if (view) view.classList.add('active');
        });
    });

    // ── Flip card (hub front → back) ──
    const flipBtn = document.getElementById('prts-flip-btn');
    const flipBackBtn = document.getElementById('prts-flip-back-btn');
    const hubContainer = document.getElementById('hub-container');

    if (flipBtn && hubContainer) {
        flipBtn.addEventListener('click', () => {
            hubContainer.classList.add('flipped');
            // Dim linked columns
            const colPerc = document.getElementById('col-perc');
            const colDedu = document.getElementById('col-dedu');
            if (colPerc) colPerc.classList.add('temp-disabled');
            if (colDedu) colDedu.classList.add('temp-disabled');
            // Pre-fill final textarea with hub input value
            const hubInput = document.getElementById('prts-hub-input');
            const finalText = document.getElementById('prts-final-text');
            if (hubInput && finalText && !finalText.value) {
                finalText.value = hubInput.value;
            }
        });
    }

    if (flipBackBtn && hubContainer) {
        flipBackBtn.addEventListener('click', () => {
            hubContainer.classList.remove('flipped');
            const colPerc = document.getElementById('col-perc');
            const colDedu = document.getElementById('col-dedu');
            if (colPerc) colPerc.classList.remove('temp-disabled');
            if (colDedu) colDedu.classList.remove('temp-disabled');
        });
    }

    // ── Link-toggle for columns ──
    const percLinkToggle = document.getElementById('prts-perc-link-toggle');
    const deduLinkToggle = document.getElementById('prts-dedu-link-toggle');

    if (percLinkToggle) {
        percLinkToggle.addEventListener('click', () => {
            const col = document.getElementById('col-perc');
            if (!col) return;
            col.classList.toggle('unlinked');
            percLinkToggle.textContent = col.classList.contains('unlinked') ? 'SEVERED' : 'LINKED';
        });
    }

    if (deduLinkToggle) {
        deduLinkToggle.addEventListener('click', () => {
            const col = document.getElementById('col-dedu');
            if (!col) return;
            col.classList.toggle('unlinked');
            deduLinkToggle.textContent = col.classList.contains('unlinked') ? 'SEVERED' : 'LINKED';
        });
    }

    // ── All action buttons → executeBinding (STscript) ──
    const boundButtons = [
        'prts-actor-commit',
        'prts-director-commit',
        'prts-add-perception',
        'prts-add-deduction',
        'prts-auto-wait',
        'prts-auto-continue',
        'prts-auto-skip',
        'prts-editor-branch',
        'prts-editor-rewind',
    ];

    for (const id of boundButtons) {
        const el = document.getElementById(id);
        if (el) {
            el.addEventListener('click', () => executeBinding(id));
        }
    }

    // ── Card close (delegated) ──
    engine.addEventListener('click', (e) => {
        const closeBtn = e.target.closest('.card-close');
        if (closeBtn) {
            e.stopPropagation();
            removeCard(closeBtn.dataset.cardType, Number(closeBtn.dataset.cardId));
        }
    });

    // ── Timeline node click ──
    engine.addEventListener('click', (e) => {
        const node = e.target.closest('.tl-node');
        if (node) {
            const index = Number(node.dataset.index);
            if (!isNaN(index) && index >= 0 && index < state.timeline.length) {
                state.timelineIndex = index;
                saveState();
                renderTimeline();
            }
        }
    });

    // ── Enter in hub input → flip to back ──
    const hubInput = document.getElementById('prts-hub-input');
    if (hubInput) {
        hubInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                if (flipBtn) flipBtn.click();
            }
        });
    }
}

// ═══════════════════════════════════════════════════════════
//  STREAMING DISPLAY
//  External pipelines call /prts-stream to drive the live
//  text display in the story canvas.
//  Also hooks into SillyTavern's native stream events.
// ═══════════════════════════════════════════════════════════

let streamBuffer = '';

function streamStart() {
    streamBuffer = '';
    state.generating = true;
    saveState();
    updateUI();
}

function streamAppend(token) {
    streamBuffer += token;

    const container = document.getElementById('prts-scene-container');
    if (!container) return;

    let liveBlock = container.querySelector('.prts-live-block');
    if (!liveBlock) {
        liveBlock = document.createElement('div');
        liveBlock.className = 'prts-scene-block prts-live-block';
        container.appendChild(liveBlock);
    }
    liveBlock.innerHTML = `<p>${formatNarrative(streamBuffer)}<span class="prts-cursor"></span></p>`;

    const canvas = document.getElementById('prts-story-canvas');
    if (canvas) canvas.scrollTop = canvas.scrollHeight;
}

function streamCommit(source) {
    if (streamBuffer) {
        appendSceneBlock(streamBuffer, source || 'stream');
        addTimelineNode(source || 'stream', streamBuffer.substring(0, 60));
        addHistoryEntry(source || 'stream', streamBuffer.substring(0, 120));
    }
    streamEnd();
}

function streamCancel() {
    streamEnd();
}

function streamEnd() {
    const container = document.getElementById('prts-scene-container');
    if (container) {
        const liveBlock = container.querySelector('.prts-live-block');
        if (liveBlock) liveBlock.remove();
    }
    streamBuffer = '';
    state.generating = false;
    saveState();
    updateUI();
}

// Native SillyTavern stream event hooks
function onStreamToken(data) {
    if (!state.active || !state.generating) return;
    const token = typeof data === 'string' ? data : (data?.text || '');
    if (token) streamAppend(token);
}

function onStreamEnd() {
    if (!state.active) return;
    // Only clean up the live block; state.generating is managed by /prts-stream
    const container = document.getElementById('prts-scene-container');
    if (container) {
        const liveBlock = container.querySelector('.prts-live-block');
        if (liveBlock) liveBlock.remove();
    }
    streamBuffer = '';
}

// ═══════════════════════════════════════════════════════════
//  SLASH COMMANDS — Pure state read/write + display
// ═══════════════════════════════════════════════════════════

function registerCommands() {

    // ── /prts — Toggle on/off ──
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'prts',
        callback: async (args) => {
            const action = args.action || 'toggle';
            if (action === 'on') state.active = true;
            else if (action === 'off') state.active = false;
            else state.active = !state.active;
            saveState();
            updateUI();
            return state.active ? 'PRTS activated' : 'PRTS deactivated';
        },
        namedArgumentList: [
            SlashCommandNamedArgument.fromProps({
                name: 'action',
                description: 'on/off/toggle (default: toggle)',
                typeList: [ARGUMENT_TYPE.STRING],
                isRequired: false,
                defaultValue: 'toggle',
            }),
        ],
        helpString: 'Toggle PRTS Narrative Engine on/off. <code>/prts action=on</code>',
        returns: ARGUMENT_TYPE.STRING,
    }));

    // ── /prts-mode — Switch mode ──
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'prts-mode',
        callback: async (args) => {
            const mode = args.mode || MODES.ACTOR;
            setMode(mode);
            return `Mode: ${state.mode}`;
        },
        namedArgumentList: [
            SlashCommandNamedArgument.fromProps({
                name: 'mode',
                description: 'actor/director/editor',
                typeList: [ARGUMENT_TYPE.STRING],
                isRequired: true,
            }),
        ],
        helpString: 'Switch PRTS mode. <code>/prts-mode mode=director</code>',
        returns: ARGUMENT_TYPE.STRING,
    }));

    // ── /prts-vibe — Set emotional tone ──
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'prts-vibe',
        callback: async (args) => {
            setVibe(args.vibe || 'tense');
            return `Vibe: ${state.vibe}`;
        },
        namedArgumentList: [
            SlashCommandNamedArgument.fromProps({
                name: 'vibe',
                description: `One of: ${VIBES.map(v => v.id).join(', ')}`,
                typeList: [ARGUMENT_TYPE.STRING],
                isRequired: true,
            }),
        ],
        helpString: `Set PRTS emotional tone. <code>/prts-vibe vibe=calm</code>`,
        returns: ARGUMENT_TYPE.STRING,
    }));

    // ── /prts-display — Push text into story canvas ──
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'prts-display',
        callback: async (args, value) => {
            const text = value || '';
            if (!text) return '';
            const source = args.source || 'display';
            appendSceneBlock(text, source);
            addTimelineNode(source, text.substring(0, 60));
            addHistoryEntry(source, text.substring(0, 120));
            saveState();
            updateUI();
            return text;
        },
        namedArgumentList: [
            SlashCommandNamedArgument.fromProps({
                name: 'source',
                description: 'Source label for the scene block (default: display)',
                typeList: [ARGUMENT_TYPE.STRING],
                isRequired: false,
                defaultValue: 'display',
            }),
        ],
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({
                description: 'The text to display in the story canvas',
                typeList: [ARGUMENT_TYPE.STRING],
                isRequired: true,
            }),
        ],
        helpString: 'Push text into the PRTS story canvas. <code>/prts-display source=narrator The room goes dark.</code>',
        returns: ARGUMENT_TYPE.STRING,
    }));

    // ── /prts-card — Manage perception & deduction cards ──
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'prts-card',
        callback: async (args, value) => {
            const action = args.action || 'add';
            const type = args.type || 'perception';

            if (action === 'add' && value) {
                if (type === 'perception') addPerceptionCard(value);
                else if (type === 'deduction') addDeductionCard(value);
                else return `Unknown card type: ${type}`;
                saveState();
                updateUI();
                return value;
            }
            if (action === 'remove') {
                const id = Number(args.id || 0);
                if (id) {
                    removeCard(type, id);
                    return `Removed ${type} card ${id}`;
                }
                return 'Error: id= required for remove';
            }
            if (action === 'clear') {
                if (type === 'perception') state.perceptionCards = [];
                else if (type === 'deduction') state.deductionCards = [];
                else { state.perceptionCards = []; state.deductionCards = []; }
                saveState();
                updateUI();
                return `Cleared ${type} cards`;
            }
            if (action === 'list') {
                const cards = type === 'perception' ? state.perceptionCards
                    : type === 'deduction' ? state.deductionCards
                        : [...state.perceptionCards, ...state.deductionCards];
                return JSON.stringify(cards);
            }
            return 'Usage: /prts-card action=add type=perception A strange noise...';
        },
        namedArgumentList: [
            SlashCommandNamedArgument.fromProps({
                name: 'action',
                description: 'add/remove/clear/list',
                typeList: [ARGUMENT_TYPE.STRING],
                isRequired: false,
                defaultValue: 'add',
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'type',
                description: 'perception/deduction/all',
                typeList: [ARGUMENT_TYPE.STRING],
                isRequired: false,
                defaultValue: 'perception',
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'id',
                description: 'Card ID (for remove)',
                typeList: [ARGUMENT_TYPE.NUMBER],
                isRequired: false,
            }),
        ],
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({
                description: 'Card text (for add)',
                typeList: [ARGUMENT_TYPE.STRING],
                isRequired: false,
            }),
        ],
        helpString: 'Manage perception/deduction cards. <code>/prts-card action=add type=deduction The guard is bluffing</code>',
        returns: ARGUMENT_TYPE.STRING,
    }));

    // ── /prts-state — Get/set arbitrary state fields ──
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'prts-state',
        callback: async (args, value) => {
            const action = args.action || 'get';
            const key = args.key || '';

            if (action === 'get') {
                if (!key) return JSON.stringify({
                    active: state.active,
                    mode: state.mode,
                    vibe: state.vibe,
                    generating: state.generating,
                    sceneCount: state.sceneBlocks.length,
                    timelineLength: state.timeline.length,
                    timelineIndex: state.timelineIndex,
                    perceptionCount: state.perceptionCards.length,
                    deductionCount: state.deductionCards.length,
                    inventoryCount: state.inventory.length,
                });
                if (key in state) {
                    const val = state[key];
                    return typeof val === 'object' ? JSON.stringify(val) : String(val);
                }
                return '';
            }

            if (action === 'set' && key) {
                // Only allow setting safe scalar fields
                const safeKeys = ['vibe', 'mode', 'active', 'generating', 'currentScene'];
                if (safeKeys.includes(key)) {
                    if (key === 'active' || key === 'generating') {
                        state[key] = value === 'true' || value === '1';
                    } else {
                        state[key] = value || '';
                    }
                    saveState();
                    updateUI();
                    return String(state[key]);
                }
                return `Error: cannot set "${key}" — use dedicated commands for complex fields`;
            }

            if (action === 'dump') {
                return JSON.stringify(state);
            }

            return 'Usage: /prts-state action=get key=vibe';
        },
        namedArgumentList: [
            SlashCommandNamedArgument.fromProps({
                name: 'action',
                description: 'get/set/dump',
                typeList: [ARGUMENT_TYPE.STRING],
                isRequired: false,
                defaultValue: 'get',
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'key',
                description: 'State field name',
                typeList: [ARGUMENT_TYPE.STRING],
                isRequired: false,
            }),
        ],
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({
                description: 'Value to set',
                typeList: [ARGUMENT_TYPE.STRING],
                isRequired: false,
            }),
        ],
        helpString: 'Read/write PRTS state. <code>/prts-state action=get key=vibe</code> or <code>/prts-state action=set key=vibe calm</code>',
        returns: ARGUMENT_TYPE.STRING,
    }));

    // ── /prts-timeline — Manage timeline nodes ──
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'prts-timeline',
        callback: async (args) => {
            const action = args.action || 'list';

            if (action === 'add') {
                const type = args.type || 'node';
                const desc = args.desc || `Node ${state.timeline.length + 1}`;
                addTimelineNode(type, desc);
                saveState();
                updateUI();
                return `Timeline node added: [${type}] ${desc}`;
            }
            if (action === 'jump') {
                const index = Number(args.index);
                if (!isNaN(index) && index >= 0 && index < state.timeline.length) {
                    state.timelineIndex = index;
                    saveState();
                    updateUI();
                    return `Jumped to timeline index ${index}`;
                }
                return 'Error: invalid index';
            }
            if (action === 'back') {
                if (state.timelineIndex > 0) {
                    state.timelineIndex--;
                    saveState();
                    updateUI();
                    return `Rewound to timeline index ${state.timelineIndex}`;
                }
                return 'Already at the beginning';
            }
            if (action === 'forward') {
                if (state.timelineIndex < state.timeline.length - 1) {
                    state.timelineIndex++;
                    saveState();
                    updateUI();
                    return `Advanced to timeline index ${state.timelineIndex}`;
                }
                return 'Already at the end';
            }
            if (action === 'clear') {
                state.timeline = [];
                state.timelineIndex = -1;
                saveState();
                updateUI();
                return 'Timeline cleared';
            }
            if (action === 'list') {
                return JSON.stringify(state.timeline);
            }

            return 'Usage: /prts-timeline action=add type=branch desc="..."';
        },
        namedArgumentList: [
            SlashCommandNamedArgument.fromProps({
                name: 'action',
                description: 'add/jump/back/forward/clear/list',
                typeList: [ARGUMENT_TYPE.STRING],
                isRequired: false,
                defaultValue: 'list',
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'type',
                description: 'Node type label (for add)',
                typeList: [ARGUMENT_TYPE.STRING],
                isRequired: false,
                defaultValue: 'node',
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'desc',
                description: 'Node description (for add)',
                typeList: [ARGUMENT_TYPE.STRING],
                isRequired: false,
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'index',
                description: 'Target index (for jump)',
                typeList: [ARGUMENT_TYPE.NUMBER],
                isRequired: false,
            }),
        ],
        helpString: 'Manage the PRTS timeline. <code>/prts-timeline action=add type=branch desc="Alt path"</code>',
        returns: ARGUMENT_TYPE.STRING,
    }));

    // ── /prts-scene — Manage scene blocks ──
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'prts-scene',
        callback: async (args, value) => {
            const action = args.action || 'list';

            if (action === 'set' && value) {
                const source = args.source || 'manual';
                appendSceneBlock(value, source);
                addTimelineNode(source, value.substring(0, 60));
                saveState();
                updateUI();
                return value;
            }
            if (action === 'clear') {
                state.sceneBlocks = [];
                state.currentScene = '';
                saveState();
                updateUI();
                return 'Scene cleared';
            }
            if (action === 'list') {
                return JSON.stringify(state.sceneBlocks);
            }
            if (action === 'current') {
                return state.currentScene || '';
            }
            if (action === 'context') {
                // Return last N scene blocks as plain text (for prompt building)
                const n = Number(args.count) || 3;
                return state.sceneBlocks.slice(-n).map(b => b.text).join('\n\n');
            }

            return 'Usage: /prts-scene action=set A dark corridor...';
        },
        namedArgumentList: [
            SlashCommandNamedArgument.fromProps({
                name: 'action',
                description: 'set/clear/list/current/context',
                typeList: [ARGUMENT_TYPE.STRING],
                isRequired: false,
                defaultValue: 'list',
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'source',
                description: 'Source label (for set)',
                typeList: [ARGUMENT_TYPE.STRING],
                isRequired: false,
                defaultValue: 'manual',
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'count',
                description: 'Number of recent blocks (for context)',
                typeList: [ARGUMENT_TYPE.NUMBER],
                isRequired: false,
                defaultValue: '3',
            }),
        ],
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({
                description: 'Scene text (for set)',
                typeList: [ARGUMENT_TYPE.STRING],
                isRequired: false,
            }),
        ],
        helpString: 'Manage PRTS scenes. <code>/prts-scene action=set source=narrator The wind howls.</code> or <code>/prts-scene action=context count=5</code>',
        returns: ARGUMENT_TYPE.STRING,
    }));

    // ── /prts-history — Manage history log ──
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'prts-history',
        callback: async (args, value) => {
            const action = args.action || 'list';

            if (action === 'add' && value) {
                const type = args.type || 'note';
                addHistoryEntry(type, value);
                saveState();
                updateUI();
                return value;
            }
            if (action === 'clear') {
                state.historyLog = [];
                saveState();
                updateUI();
                return 'History cleared';
            }
            if (action === 'list') {
                const n = Number(args.count) || 20;
                return JSON.stringify(state.historyLog.slice(-n));
            }

            return 'Usage: /prts-history action=add type=event Something happened';
        },
        namedArgumentList: [
            SlashCommandNamedArgument.fromProps({
                name: 'action',
                description: 'add/clear/list',
                typeList: [ARGUMENT_TYPE.STRING],
                isRequired: false,
                defaultValue: 'list',
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'type',
                description: 'Entry type label (for add)',
                typeList: [ARGUMENT_TYPE.STRING],
                isRequired: false,
                defaultValue: 'note',
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'count',
                description: 'Number of recent entries (for list)',
                typeList: [ARGUMENT_TYPE.NUMBER],
                isRequired: false,
                defaultValue: '20',
            }),
        ],
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({
                description: 'Entry text (for add)',
                typeList: [ARGUMENT_TYPE.STRING],
                isRequired: false,
            }),
        ],
        helpString: 'Manage PRTS history log. <code>/prts-history action=add type=combat The enemy attacks!</code>',
        returns: ARGUMENT_TYPE.STRING,
    }));

    // ── /prts-inventory — Manage inventory items ──
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'prts-inventory',
        callback: async (args, value) => {
            const action = args.action || 'add';
            if (action === 'add' && value) {
                state.inventory.push({
                    name: value,
                    icon: args.icon || '?',
                    qty: args.qty || '',
                });
                saveState();
                updateUI();
                return `Added: ${value}`;
            }
            if (action === 'remove' && value) {
                const idx = state.inventory.findIndex(i => i.name === value);
                if (idx >= 0) {
                    state.inventory.splice(idx, 1);
                    saveState();
                    updateUI();
                    return `Removed: ${value}`;
                }
                return `Not found: ${value}`;
            }
            if (action === 'clear') {
                state.inventory = [];
                saveState();
                updateUI();
                return 'Inventory cleared';
            }
            if (action === 'list') {
                return JSON.stringify(state.inventory);
            }
            return 'Usage: /prts-inventory action=add My Item';
        },
        namedArgumentList: [
            SlashCommandNamedArgument.fromProps({
                name: 'action',
                description: 'add/remove/clear/list',
                typeList: [ARGUMENT_TYPE.STRING],
                isRequired: false,
                defaultValue: 'add',
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'icon',
                description: 'Icon character for the item',
                typeList: [ARGUMENT_TYPE.STRING],
                isRequired: false,
                defaultValue: '?',
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'qty',
                description: 'Quantity string',
                typeList: [ARGUMENT_TYPE.STRING],
                isRequired: false,
            }),
        ],
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({
                description: 'Item name',
                typeList: [ARGUMENT_TYPE.STRING],
                isRequired: false,
            }),
        ],
        helpString: 'Manage PRTS inventory. <code>/prts-inventory action=add icon=⚔ qty=1 Magic Sword</code>',
        returns: ARGUMENT_TYPE.STRING,
    }));

    // ── /prts-stream — Control live streaming display ──
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'prts-stream',
        callback: async (args, value) => {
            const action = args.action || 'append';

            if (action === 'start') {
                streamStart();
                return 'Stream started';
            }
            if (action === 'append' && value) {
                streamAppend(value);
                return value;
            }
            if (action === 'commit') {
                const source = args.source || 'stream';
                streamCommit(source);
                return 'Stream committed';
            }
            if (action === 'cancel') {
                streamCancel();
                return 'Stream cancelled';
            }
            if (action === 'end') {
                streamEnd();
                return 'Stream ended';
            }
            if (action === 'buffer') {
                return streamBuffer;
            }

            return 'Usage: /prts-stream action=start';
        },
        namedArgumentList: [
            SlashCommandNamedArgument.fromProps({
                name: 'action',
                description: 'start/append/commit/cancel/end/buffer',
                typeList: [ARGUMENT_TYPE.STRING],
                isRequired: false,
                defaultValue: 'append',
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'source',
                description: 'Source label (for commit)',
                typeList: [ARGUMENT_TYPE.STRING],
                isRequired: false,
                defaultValue: 'stream',
            }),
        ],
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({
                description: 'Token text (for append)',
                typeList: [ARGUMENT_TYPE.STRING],
                isRequired: false,
            }),
        ],
        helpString: 'Control PRTS live stream display. <code>/prts-stream action=start</code> then <code>/prts-stream Some text</code> then <code>/prts-stream action=commit</code>',
        returns: ARGUMENT_TYPE.STRING,
    }));

    // ── /prts-bind — Configure button → STscript bindings ──
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'prts-bind',
        callback: async (args, value) => {
            const action = args.action || 'get';
            const button = args.button || '';

            if (action === 'set' && button && value) {
                state.bindings[button] = value;
                saveState();
                return `Bound ${button} → ${value}`;
            }
            if (action === 'get') {
                if (button) {
                    return getBinding(button);
                }
                // Return all effective bindings
                const all = {};
                for (const key of Object.keys(DEFAULT_BINDINGS)) {
                    all[key] = getBinding(key);
                }
                return JSON.stringify(all, null, 2);
            }
            if (action === 'reset') {
                if (button) {
                    delete state.bindings[button];
                } else {
                    state.bindings = {};
                }
                saveState();
                return button ? `Reset binding for ${button}` : 'All bindings reset to defaults';
            }
            if (action === 'list') {
                return JSON.stringify(Object.keys(DEFAULT_BINDINGS));
            }

            return 'Usage: /prts-bind action=set button=prts-actor-commit /my-custom-pipeline {{prtsInput}}';
        },
        namedArgumentList: [
            SlashCommandNamedArgument.fromProps({
                name: 'action',
                description: 'get/set/reset/list',
                typeList: [ARGUMENT_TYPE.STRING],
                isRequired: false,
                defaultValue: 'get',
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'button',
                description: 'Button ID to bind',
                typeList: [ARGUMENT_TYPE.STRING],
                isRequired: false,
            }),
        ],
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({
                description: 'STscript to execute when button is clicked (for set)',
                typeList: [ARGUMENT_TYPE.STRING],
                isRequired: false,
            }),
        ],
        helpString: 'Configure PRTS button bindings. <code>/prts-bind action=set button=prts-actor-commit /my-pipeline {{prtsInput}}</code>',
        returns: ARGUMENT_TYPE.STRING,
    }));

    // ── Legacy compatibility commands (thin wrappers) ──

    // /prts-commit — convenience alias, calls display
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'prts-commit',
        callback: async (args, value) => {
            const text = value || args.action || '';
            addHistoryEntry('actor_commit', text.substring(0, 120) || '(observe)');
            saveState();
            updateUI();
            return text;
        },
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({
                description: 'The action text',
                typeList: [ARGUMENT_TYPE.STRING],
                isRequired: false,
            }),
        ],
        helpString: 'Log an actor commit action. <code>/prts-commit I search the room</code>',
        returns: ARGUMENT_TYPE.STRING,
    }));

    // /prts-override — convenience alias
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'prts-override',
        callback: async (args, value) => {
            const text = value || args.event || '';
            if (!text) return 'Error: No override text provided';
            addHistoryEntry('director_override', text.substring(0, 120));
            saveState();
            updateUI();
            return text;
        },
        namedArgumentList: [
            SlashCommandNamedArgument.fromProps({
                name: 'event',
                description: 'The forced narrative event',
                typeList: [ARGUMENT_TYPE.STRING],
                isRequired: false,
            }),
        ],
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({
                description: 'Override text',
                typeList: [ARGUMENT_TYPE.STRING],
                isRequired: false,
            }),
        ],
        helpString: 'Log a director override event. <code>/prts-override A sudden earthquake!</code>',
        returns: ARGUMENT_TYPE.STRING,
    }));

    // /prts-perception — add or list perception cards
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'prts-perception',
        callback: async (args, value) => {
            if (value) {
                addPerceptionCard(value);
                saveState();
                updateUI();
                return value;
            }
            return JSON.stringify(state.perceptionCards);
        },
        namedArgumentList: [
            SlashCommandNamedArgument.fromProps({
                name: 'focus',
                description: 'Focus hint (passed through, not used internally)',
                typeList: [ARGUMENT_TYPE.STRING],
                isRequired: false,
            }),
        ],
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({
                description: 'Perception text to add',
                typeList: [ARGUMENT_TYPE.STRING],
                isRequired: false,
            }),
        ],
        helpString: 'Add a perception card or list all. <code>/prts-perception The air smells like rust</code>',
        returns: ARGUMENT_TYPE.STRING,
    }));

    // /prts-deduction — add or list deduction cards
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'prts-deduction',
        callback: async (args, value) => {
            if (value) {
                addDeductionCard(value);
                saveState();
                updateUI();
                return value;
            }
            return JSON.stringify(state.deductionCards);
        },
        namedArgumentList: [
            SlashCommandNamedArgument.fromProps({
                name: 'focus',
                description: 'Reasoning focus hint (passed through, not used internally)',
                typeList: [ARGUMENT_TYPE.STRING],
                isRequired: false,
            }),
        ],
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({
                description: 'Deduction text to add',
                typeList: [ARGUMENT_TYPE.STRING],
                isRequired: false,
            }),
        ],
        helpString: 'Add a deduction card or list all. <code>/prts-deduction The guard is bluffing</code>',
        returns: ARGUMENT_TYPE.STRING,
    }));

    // /prts-auto — convenience log for auto-progress
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'prts-auto',
        callback: async (args) => {
            const type = args.type || 'continue';
            addHistoryEntry(`auto_${type}`, `Auto-progress: ${type}`);
            saveState();
            updateUI();
            return type;
        },
        namedArgumentList: [
            SlashCommandNamedArgument.fromProps({
                name: 'type',
                description: 'wait/continue/skip',
                typeList: [ARGUMENT_TYPE.STRING],
                isRequired: false,
                defaultValue: 'continue',
            }),
        ],
        helpString: 'Log an auto-progress event. <code>/prts-auto type=skip</code>',
        returns: ARGUMENT_TYPE.STRING,
    }));

    // ── /prts-hotkey — Configure toggle hotkey ──
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'prts-hotkey',
        callback: async (args, value) => {
            const newKey = (args.hotkey || value || '').trim();
            if (!newKey) {
                return `Current hotkey: ${state.hotkey || DEFAULT_HOTKEY}  (e.g. /prts-hotkey hotkey=F12  or  /prts-hotkey hotkey=Ctrl+Shift+P)`;
            }
            // Validate: must parse to at least one key
            const parsed = parseHotkey(newKey);
            if (!parsed || !parsed.key) {
                return `Invalid hotkey "${newKey}". Examples: F12, Ctrl+Shift+P, Alt+G`;
            }
            state.hotkey = newKey;
            saveState();
            updateUI();
            return `Hotkey set to: ${newKey}`;
        },
        namedArgumentList: [
            SlashCommandNamedArgument.fromProps({
                name: 'hotkey',
                description: 'Key combination, e.g. F12 or Ctrl+Shift+P',
                typeList: [ARGUMENT_TYPE.STRING],
                isRequired: false,
            }),
        ],
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({
                description: 'Key combination (alternative to hotkey= parameter)',
                typeList: [ARGUMENT_TYPE.STRING],
                isRequired: false,
            }),
        ],
        helpString: 'Get or set the PRTS toggle hotkey. <code>/prts-hotkey hotkey=F12</code>',
        returns: ARGUMENT_TYPE.STRING,
    }));

    // ── /prts-reset — Full state reset ──
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'prts-reset',
        callback: async () => {
            const wasActive = state.active;
            state = DEFAULT_STATE();
            state.active = wasActive;
            saveState();
            updateUI();
            return 'PRTS state reset';
        },
        helpString: 'Reset all PRTS state (scenes, cards, timeline, inventory, bindings).',
        returns: ARGUMENT_TYPE.STRING,
    }));
}

// ═══════════════════════════════════════════════════════════
//  UTILITY FUNCTIONS
// ═══════════════════════════════════════════════════════════

function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str || '';
    return div.innerHTML;
}

function formatNarrative(text) {
    if (!text) return '';
    return escapeHtml(text)
        .replace(/\n\n/g, '</p><p>')
        .replace(/\n/g, '<br>')
        .replace(/&quot;(.*?)&quot;/g, '<span class="dialogue-speaker">"$1"</span>')
        .replace(/\[SCENE_STATE\](.*?)(?:\n|$)/gi, '<span class="scene-label">$1</span>')
        .replace(/\[SKIP SUMMARY\](.*?)(?:\n|$)/gi, '<span class="scene-label">SKIP: $1</span>');
}

function formatTime(isoStr) {
    if (!isoStr) return '';
    try {
        const d = new Date(isoStr);
        return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    } catch {
        return '';
    }
}

// ═══════════════════════════════════════════════════════════
//  INITIALIZATION
// ═══════════════════════════════════════════════════════════

jQuery(async () => {
    registerCommands();

    // Register global hotkey listener ONCE (not re-registered on chat change)
    document.addEventListener('keydown', onGlobalKeydown, { capture: true });

    eventSource.on(event_types.CHAT_CHANGED, () => {
        loadState();
        injectUI();
    });

    eventSource.on(event_types.CHAT_LOADED, () => {
        loadState();
        injectUI();
    });

    // Native streaming hooks
    eventSource.on(event_types.STREAM_TOKEN_RECEIVED, onStreamToken);
    eventSource.on(event_types.GENERATION_ENDED, onStreamEnd);
    eventSource.on(event_types.GENERATION_STOPPED, onStreamEnd);

    // Initial injection if chat is already loaded
    const ctx = getContext();
    if (ctx.chatId) {
        loadState();
        injectUI();
    }

    console.log('[PRTS] Narrative Engine v2 loaded — pure UI shell. Use /prts to toggle.');
});
