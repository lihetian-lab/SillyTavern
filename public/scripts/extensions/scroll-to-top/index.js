import { eventSource, event_types } from '../../../script.js';

let isStreaming = false;
let userScrolled = false;

function getScrollTarget(chat) {
    return chat?.querySelector('.mes:nth-last-child(2)') || chat?.querySelector('.mes:last-child');
}

function scrollTargetToTop() {
    const chat = document.getElementById('chat');
    const target = getScrollTarget(chat);
    if (!target) return;
    target.scrollIntoView({ block: 'start', behavior: 'instant' });
}

// Patch jQuery .scrollTop() globally, intercept only for #chat during streaming
const originalScrollTop = $.fn.scrollTop;
$.fn.scrollTop = function (val) {
    if (val !== undefined && isStreaming && !userScrolled && this[0]?.id === 'chat') {
        const target = getScrollTarget(this[0]);
        if (target) {
            return originalScrollTop.call(this, target.offsetTop);
        }
    }
    return originalScrollTop.apply(this, arguments);
};

// Detect user wheel scroll on #chat
function attachWheelListener() {
    const chat = document.getElementById('chat');
    if (!chat || chat.__wheelListenerAttached) return;
    chat.__wheelListenerAttached = true;
    chat.addEventListener('wheel', () => {
        if (isStreaming) userScrolled = true;
    }, { passive: true });
}

eventSource.on(event_types.GENERATION_STARTED, () => {
    isStreaming = true;
    userScrolled = false;
});

eventSource.on(event_types.GENERATION_ENDED, () => { isStreaming = false; });
eventSource.on(event_types.GENERATION_STOPPED, () => { isStreaming = false; });

// Non-streaming: scroll on message render
eventSource.makeLast(event_types.CHARACTER_MESSAGE_RENDERED, () => {
    requestAnimationFrame(() => requestAnimationFrame(() => scrollTargetToTop()));
});

eventSource.makeLast(event_types.USER_MESSAGE_RENDERED, () => {
    requestAnimationFrame(() => requestAnimationFrame(() => scrollTargetToTop()));
});

eventSource.on(event_types.CHAT_CHANGED, () => requestAnimationFrame(() => attachWheelListener()));
requestAnimationFrame(() => attachWheelListener());
