import { eventSource, event_types } from '../../../script.js';
import { power_user } from '../../power-user.js';

console.log('[scroll-to-top] Extension loaded');

let savedAutoScroll = true;
let userScrolled = false;
let scrollInterval = null;

function getScrollTarget(chat) {
    return chat?.querySelector('.mes:nth-last-child(2)') || chat?.querySelector('.mes:last-child');
}

function scrollTargetToTop() {
    const chat = document.getElementById('chat');
    const target = getScrollTarget(chat);
    if (!target) return;
    target.scrollIntoView({ block: 'start', behavior: 'instant' });
}

// Detect user wheel scroll on #chat
const chat = document.getElementById('chat');
chat?.addEventListener('wheel', () => {
    if (scrollInterval) userScrolled = true;
}, { passive: true });

eventSource.on(event_types.GENERATION_STARTED, () => {
    console.log('[scroll-to-top] GENERATION_STARTED fired, auto_scroll was:', power_user.auto_scroll_chat_to_bottom);
    // Disable SillyTavern's auto-scroll
    savedAutoScroll = power_user.auto_scroll_chat_to_bottom;
    power_user.auto_scroll_chat_to_bottom = false;
    userScrolled = false;

    // Keep scrolling to top of previous message until user scrolls or streaming ends
    clearInterval(scrollInterval);
    scrollInterval = setInterval(() => {
        if (userScrolled) {
            clearInterval(scrollInterval);
            scrollInterval = null;
            return;
        }
        console.log('[scroll-to-top] interval tick, scrolling to target');
        scrollTargetToTop();
    }, 150);
});

function onStreamingEnd() {
    clearInterval(scrollInterval);
    scrollInterval = null;
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
