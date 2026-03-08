import { eventSource, event_types } from '../../../script.js';
import { power_user } from '../../power-user.js';

console.log('[scroll-to-top] Extension loaded');

let savedAutoScroll = true;
let userScrolled = false;
let scrollInterval = null;

// Detect user wheel scroll on #chat
const chat = document.getElementById('chat');
chat?.addEventListener('wheel', () => {
    if (scrollInterval) userScrolled = true;
}, { passive: true });

function doScroll() {
    const chat = document.getElementById('chat');
    if (!chat) {
        console.log('[scroll-to-top] no chat element');
        return;
    }
    const target = chat.querySelector('.mes:nth-last-child(2)') || chat.querySelector('.mes:last-child');
    if (!target) {
        console.log('[scroll-to-top] no target element');
        return;
    }
    const chatRect = chat.getBoundingClientRect();
    const targetRect = target.getBoundingClientRect();
    const offset = targetRect.top - chatRect.top;
    const before = chat.scrollTop;
    chat.scrollTop += offset;
    console.log('[scroll-to-top] before:', before, 'after:', chat.scrollTop, 'offset:', offset);
}

eventSource.on(event_types.GENERATION_STARTED, () => {
    console.log('[scroll-to-top] GENERATION_STARTED, auto_scroll was:', power_user.auto_scroll_chat_to_bottom);
    savedAutoScroll = power_user.auto_scroll_chat_to_bottom;
    power_user.auto_scroll_chat_to_bottom = false;
    userScrolled = false;

    clearInterval(scrollInterval);
    // Fire immediately, then every 150ms
    doScroll();
    scrollInterval = setInterval(() => {
        if (userScrolled) {
            clearInterval(scrollInterval);
            scrollInterval = null;
            console.log('[scroll-to-top] user scrolled, stopping');
            return;
        }
        doScroll();
    }, 150);
});

function onStreamingEnd() {
    clearInterval(scrollInterval);
    scrollInterval = null;
    power_user.auto_scroll_chat_to_bottom = savedAutoScroll;
    console.log('[scroll-to-top] streaming ended, restored auto_scroll:', savedAutoScroll);
}

eventSource.on(event_types.GENERATION_ENDED, onStreamingEnd);
eventSource.on(event_types.GENERATION_STOPPED, onStreamingEnd);

// Non-streaming: scroll on message render
eventSource.makeLast(event_types.CHARACTER_MESSAGE_RENDERED, () => {
    requestAnimationFrame(() => requestAnimationFrame(() => doScroll()));
});

eventSource.makeLast(event_types.USER_MESSAGE_RENDERED, () => {
    requestAnimationFrame(() => requestAnimationFrame(() => doScroll()));
});
