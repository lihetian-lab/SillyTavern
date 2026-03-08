import { eventSource, event_types } from '../../../script.js';

let chatObserver = null;

function scrollLastMessageToTop() {
    const chat = document.getElementById('chat');
    const lastMsg = chat?.querySelector('.mes:last-child');
    if (!lastMsg) return;
    lastMsg.scrollIntoView({ block: 'start', behavior: 'instant' });
}

function setupChatObserver() {
    if (chatObserver) return;
    const chat = document.getElementById('chat');
    if (!chat) return;

    chatObserver = new MutationObserver((mutations) => {
        for (const mutation of mutations) {
            if (mutation.type !== 'childList' || mutation.addedNodes.length === 0) continue;
            const hasNewMessage = Array.from(mutation.addedNodes).some(
                node => node.nodeType === 1 && node.classList?.contains('mes'),
            );
            if (hasNewMessage) {
                // Delay to run after SillyTavern's scrollLock=false and first scrollChatToBottom
                // Our scroll puts view NOT at bottom → SillyTavern's scroll handler sets scrollLock=true
                // → no more auto-scroll for the rest of streaming → user can scroll freely
                setTimeout(() => scrollLastMessageToTop(), 80);
            }
        }
    });

    chatObserver.observe(chat, { childList: true });
}

// Set up observer when chat loads, and also handle non-streaming renders
eventSource.on(event_types.CHAT_CHANGED, () => {
    chatObserver?.disconnect();
    chatObserver = null;
    // Chat element is recreated, need to re-observe
    requestAnimationFrame(() => setupChatObserver());
});

eventSource.makeLast(event_types.CHARACTER_MESSAGE_RENDERED, () => {
    requestAnimationFrame(() => {
        requestAnimationFrame(() => scrollLastMessageToTop());
    });
});

eventSource.makeLast(event_types.USER_MESSAGE_RENDERED, () => {
    requestAnimationFrame(() => {
        requestAnimationFrame(() => scrollLastMessageToTop());
    });
});

// Initial setup
requestAnimationFrame(() => setupChatObserver());
