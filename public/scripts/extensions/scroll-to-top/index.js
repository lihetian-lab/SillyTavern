import { eventSource, event_types } from '../../../script.js';

let isStreaming = false;
let userScrolled = false;
let redirecting = false;
let scrollListenerAttached = false;

function scrollLastMessageToTop() {
    const chat = document.getElementById('chat');
    const lastMsg = chat?.querySelector('.mes:last-child');
    if (!lastMsg) return;
    lastMsg.scrollIntoView({ block: 'start', behavior: 'instant' });
}

// During streaming: intercept programmatic scroll-to-bottom, redirect to top of last message.
// Once user scrolls with mouse wheel, stop intercepting (preserves free-scroll behavior).
eventSource.on(event_types.GENERATION_STARTED, () => {
    isStreaming = true;
    userScrolled = false;
});

eventSource.on(event_types.GENERATION_ENDED, () => { isStreaming = false; });
eventSource.on(event_types.GENERATION_STOPPED, () => { isStreaming = false; });

function attachScrollListener() {
    if (scrollListenerAttached) return;
    const chat = document.getElementById('chat');
    if (!chat) return;
    scrollListenerAttached = true;

    // Detect user-initiated scroll via mouse wheel
    chat.addEventListener('wheel', () => {
        if (isStreaming) userScrolled = true;
    }, { passive: true });

    // Intercept programmatic scroll-to-bottom during streaming
    chat.addEventListener('scroll', () => {
        if (!isStreaming || userScrolled || redirecting) return;

        const lastMsg = chat.querySelector('.mes:last-child');
        if (!lastMsg) return;

        const targetTop = lastMsg.offsetTop;

        // Only redirect if scrolled well past the last message top (i.e., a scroll-to-bottom)
        if (chat.scrollTop > targetTop + 50) {
            redirecting = true;
            chat.scrollTop = targetTop;
            requestAnimationFrame(() => requestAnimationFrame(() => { redirecting = false; }));
        }
    }, { passive: true });
}

// Non-streaming: scroll on message render
eventSource.makeLast(event_types.CHARACTER_MESSAGE_RENDERED, () => {
    requestAnimationFrame(() => requestAnimationFrame(() => scrollLastMessageToTop()));
});

eventSource.makeLast(event_types.USER_MESSAGE_RENDERED, () => {
    requestAnimationFrame(() => requestAnimationFrame(() => scrollLastMessageToTop()));
});

// Attach listener when chat is ready
eventSource.on(event_types.CHAT_CHANGED, () => {
    scrollListenerAttached = false;
    requestAnimationFrame(() => attachScrollListener());
});
requestAnimationFrame(() => attachScrollListener());
