import { eventSource, event_types } from '../../../script.js';
import { power_user } from '../../power-user.js';

let savedAutoScroll = true;
let observer = null;

function getScrollTarget(chat) {
    return chat?.querySelector('.mes:nth-last-child(2)') || chat?.querySelector('.mes:last-child');
}

function scrollTargetToTop() {
    const chat = document.getElementById('chat');
    const target = getScrollTarget(chat);
    if (!target) return;
    target.scrollIntoView({ block: 'start', behavior: 'instant' });
}

// When streaming starts: disable auto-scroll, watch for new message to appear
eventSource.on(event_types.GENERATION_STARTED, () => {
    savedAutoScroll = power_user.auto_scroll_chat_to_bottom;
    power_user.auto_scroll_chat_to_bottom = false;

    // Watch for the streaming message element to be added
    const chat = document.getElementById('chat');
    if (!chat) return;

    observer?.disconnect();
    observer = new MutationObserver((mutations) => {
        for (const mutation of mutations) {
            if (mutation.type !== 'childList' || mutation.addedNodes.length === 0) continue;
            const hasNewMessage = Array.from(mutation.addedNodes).some(
                node => node.nodeType === 1 && node.classList?.contains('mes'),
            );
            if (hasNewMessage) {
                // New message appeared, scroll previous message to top
                requestAnimationFrame(() => scrollTargetToTop());
                observer?.disconnect();
                observer = null;
                return;
            }
        }
    });
    observer.observe(chat, { childList: true });
});

// When streaming ends: restore auto-scroll setting, do final scroll
function onStreamingEnd() {
    observer?.disconnect();
    observer = null;
    power_user.auto_scroll_chat_to_bottom = savedAutoScroll;
}

eventSource.on(event_types.GENERATION_ENDED, onStreamingEnd);
eventSource.on(event_types.GENERATION_STOPPED, onStreamingEnd);

// Non-streaming: scroll on message render
eventSource.makeLast(event_types.CHARACTER_MESSAGE_RENDERED, () => {
    requestAnimationFrame(() => requestAnimationFrame(() => scrollTargetToTop()));
});

eventSource.makeLast(event_types.USER_MESSAGE_RENDERED, () => {
    requestAnimationFrame(() => requestAnimationFrame(() => scrollTargetToTop()));
});
