import {
    saveSettingsDebounced,
} from '../../../script.js';
import {
    extension_settings,
    renderExtensionTemplateAsync,
} from '../../extensions.js';
import { SlashCommandParser } from '../../slash-commands/SlashCommandParser.js';
import { SlashCommand } from '../../slash-commands/SlashCommand.js';
import { dragElement } from '../../RossAscends-mods.js';

const MODULE_NAME = 'image_trigger';

const defaultSettings = {
    enabled: true,
};

let isGenerating = false;
let pinnedCounter = 0;

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
 * Reads the prompt directly from the SD extension's "Common prompt prefix" field
 * and generates in FREE mode without invoking the LLM.
 * The generated image is displayed in the floating panel.
 */
async function triggerGeneration() {
    if (isGenerating) {
        console.log('[Image Trigger] Generation already in progress, skipping');
        return;
    }

    // Read prompt directly from SD extension's prompt prefix field
    const prompt = (extension_settings.sd?.prompt_prefix || '').trim();
    if (!prompt) {
        setStatus('Error: SD prompt prefix is empty');
        return;
    }

    // Temporarily clear prompt_prefix to avoid double-prefixing
    // (sendGenerationRequest always prepends prompt_prefix to the prompt)
    const savedPrefix = extension_settings.sd.prompt_prefix;
    extension_settings.sd.prompt_prefix = '';

    isGenerating = true;
    setStatus('Generating...');
    setSpinner(true);

    try {
        // Call the /imagine command callback directly in FREE mode
        const imagineCmd = SlashCommandParser.commands['imagine'];
        if (!imagineCmd) {
            throw new Error('SD extension /imagine command not found');
        }

        const imageUrl = await imagineCmd.callback({ quiet: 'true' }, prompt);
        if (imageUrl) {
            updatePanelImage(imageUrl);
            setStatus('Ready');
        } else {
            setStatus('Error: No image generated');
        }
    } catch (err) {
        setStatus('Error: ' + (err.message || 'Unknown error'));
        console.error('[Image Trigger] Generation error:', err);
    } finally {
        extension_settings.sd.prompt_prefix = savedPrefix;
        isGenerating = false;
        setSpinner(false);
    }
}

/**
 * Pin the current panel image to the screen as a static, draggable element.
 * Pinned images are independent of the panel and can be closed individually.
 */
function pinCurrentImage() {
    const img = document.getElementById('image-trigger-img');
    if (!img || !img.src || img.src === window.location.href) {
        return;
    }

    pinnedCounter++;
    const id = `image-trigger-pinned-${pinnedCounter}`;

    const container = $(`<div id="${id}" class="image-trigger-pinned">
        <div id="${id}header" class="fa-solid fa-grip drag-grabber pinned-drag"></div>
        <img src="${img.src}" />
        <span class="pinned-close fa-solid fa-circle-xmark"></span>
    </div>`);

    container.find('.pinned-close').on('click', () => container.remove());
    $('body').append(container);
    dragElement(container);
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

    // Pin current image button
    $('#image-trigger-pin-btn').on('click', () => {
        pinCurrentImage();
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

}

function applySettingsToUI() {
    $('#image_trigger_enabled').prop('checked', extension_settings[MODULE_NAME].enabled);
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
