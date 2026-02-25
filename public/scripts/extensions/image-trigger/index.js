import {
    saveSettingsDebounced,
} from '../../../script.js';
import {
    extension_settings,
    renderExtensionTemplateAsync,
} from '../../extensions.js';
import { executeSlashCommandsWithOptions } from '../../slash-commands.js';
import { SlashCommandParser } from '../../slash-commands/SlashCommandParser.js';
import { SlashCommand } from '../../slash-commands/SlashCommand.js';
import { dragElement } from '../../RossAscends-mods.js';

const MODULE_NAME = 'image_trigger';

const defaultSettings = {
    enabled: true,
    default_trigger: 'scene',
};

let isGenerating = false;

function loadSettings() {
    if (!extension_settings[MODULE_NAME]) {
        extension_settings[MODULE_NAME] = {};
    }
    extension_settings[MODULE_NAME] = Object.assign(
        {},
        defaultSettings,
        extension_settings[MODULE_NAME],
    );
}

function saveSettings() {
    saveSettingsDebounced();
}

/**
 * Show the floating image panel.
 */
function showPanel() {
    $('#image-trigger-panel').show();
}

/**
 * Hide the floating image panel.
 */
function hidePanel() {
    $('#image-trigger-panel').hide();
}

/**
 * Update the panel image display.
 * @param {string} imageUrl URL/path of the image to display
 */
function updatePanelImage(imageUrl) {
    const img = document.getElementById('image-trigger-img');
    if (img) {
        img.setAttribute('src', imageUrl);
    }
}

/**
 * Set the status text in the panel footer.
 * @param {string} text Status text
 */
function setStatus(text) {
    const el = document.getElementById('image-trigger-status');
    if (el) {
        el.textContent = text;
    }
}

/**
 * Show or hide the loading spinner overlay.
 * @param {boolean} visible Whether to show the spinner
 */
function setSpinner(visible) {
    const spinner = document.getElementById('image-trigger-spinner');
    if (spinner) {
        spinner.style.display = visible ? 'flex' : 'none';
    }
}

/**
 * Trigger image generation (fire-and-forget).
 * Uses the existing /imagine command with quiet=true so nothing is posted to chat.
 * The generated image is displayed in the floating panel.
 */
async function triggerGeneration() {
    if (isGenerating) {
        console.log('[Image Trigger] Generation already in progress, skipping');
        return;
    }

    const trigger = extension_settings[MODULE_NAME].default_trigger || 'scene';

    isGenerating = true;
    setStatus('Generating...');
    setSpinner(true);

    try {
        const cmd = `/imagine quiet=true ${trigger}`;
        const result = await executeSlashCommandsWithOptions(cmd, {
            handleParserErrors: false,
            handleExecutionErrors: false,
        });

        if (result && result.pipe && !result.isError) {
            updatePanelImage(result.pipe);
            setStatus('Ready');
        } else {
            const errMsg = result?.errorMessage || 'Generation failed';
            setStatus('Error: ' + errMsg);
            console.error('[Image Trigger] Generation failed:', errMsg);
        }
    } catch (err) {
        setStatus('Error: ' + (err.message || 'Unknown error'));
        console.error('[Image Trigger] Generation error:', err);
    } finally {
        isGenerating = false;
        setSpinner(false);
    }
}

/**
 * Fire-and-forget wrapper: triggers generation without blocking the caller.
 * This is what the slash command and UI button call, so that ST Script
 * can continue executing subsequent commands in parallel.
 */
function triggerGenerationAsync() {
    triggerGeneration();
}

function bindEvents() {
    // Panel trigger button
    $('#image-trigger-btn').on('click', () => {
        triggerGenerationAsync();
    });

    // Settings: enabled toggle
    $('#image_trigger_enabled').on('change', function () {
        extension_settings[MODULE_NAME].enabled = !!$(this).prop('checked');
        if (extension_settings[MODULE_NAME].enabled) {
            showPanel();
        } else {
            hidePanel();
        }
        saveSettings();
    });

    // Settings: default mode selector
    $('#image_trigger_mode').on('change', function () {
        extension_settings[MODULE_NAME].default_trigger = String($(this).val());
        saveSettings();
    });
}

function applySettingsToUI() {
    $('#image_trigger_enabled').prop('checked', extension_settings[MODULE_NAME].enabled);
    $('#image_trigger_mode').val(extension_settings[MODULE_NAME].default_trigger);
}

function registerCommands() {
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'trigger-image',
        callback: () => {
            triggerGenerationAsync();
            return '';
        },
        helpString: 'Trigger image generation and display the result in the Image Trigger floating panel. Uses SD extension settings. Fire-and-forget: returns immediately while generation runs in the background.',
        returns: 'empty string (generation runs asynchronously)',
    }));
}

jQuery(async () => {
    // Load settings
    loadSettings();

    // Render settings panel into extensions drawer
    const settingsHtml = await renderExtensionTemplateAsync('image-trigger', 'settings');
    $('#extensions_settings').append(settingsHtml);

    // Create floating panel and append to body
    const panelHtml = await renderExtensionTemplateAsync('image-trigger', 'panel');
    $('body').append(panelHtml);

    // Make panel draggable (uses SillyTavern's built-in drag system)
    dragElement($('#image-trigger-panel'));

    // Apply settings to UI controls
    applySettingsToUI();

    // Bind UI events
    bindEvents();

    // Register slash commands
    registerCommands();

    // Show/hide panel based on settings
    if (extension_settings[MODULE_NAME].enabled) {
        showPanel();
    }
});
