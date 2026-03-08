import { eventSource, event_types } from '../../../script.js';

let scrollOverrideActive = false;

function scrollLastMessageToTop() {
    const chat = document.getElementById('chat');
    const lastMsg = chat?.querySelector('.mes:last-child');
    if (!lastMsg) return;
    lastMsg.scrollIntoView({ block: 'start', behavior: 'instant' });
}

function onScrollEvent() {
    if (!scrollOverrideActive) return;
    scrollLastMessageToTop();
}

function startScrollOverride() {
    scrollOverrideActive = true;
    const chat = document.getElementById('chat');
    if (chat) {
        chat.addEventListener('scroll', onScrollEvent);
    }
    // Initial scroll
    requestAnimationFrame(() => scrollLastMessageToTop());
}

function stopScrollOverride() {
    scrollOverrideActive = false;
    const chat = document.getElementById('chat');
    if (chat) {
        chat.removeEventListener('scroll', onScrollEvent);
    }
    // Final scroll after all pending RAFs
    requestAnimationFrame(() => {
        requestAnimationFrame(() => scrollLastMessageToTop());
    });
}

// Intercept scroll during entire generation lifecycle
eventSource.on(event_types.GENERATION_STARTED, startScrollOverride);
eventSource.on(event_types.GENERATION_ENDED, stopScrollOverride);
eventSource.on(event_types.GENERATION_STOPPED, stopScrollOverride);

// Also handle user message and non-streaming character message
eventSource.makeLast(event_types.USER_MESSAGE_RENDERED, () => {
    requestAnimationFrame(() => {
        requestAnimationFrame(() => scrollLastMessageToTop());
    });
});
eventSource.makeLast(event_types.CHARACTER_MESSAGE_RENDERED, () => {
    requestAnimationFrame(() => {
        requestAnimationFrame(() => scrollLastMessageToTop());
    });
});
