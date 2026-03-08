import { eventSource, event_types } from '../../../script.js';

function scrollLastMessageToTop() {
    const chat = document.getElementById('chat');
    const lastMsg = chat?.querySelector('.mes:last-child');
    if (!lastMsg) return;

    // Double RAF to run after SillyTavern's own scrollChatToBottom
    requestAnimationFrame(() => {
        requestAnimationFrame(() => {
            lastMsg.scrollIntoView({ block: 'start', behavior: 'instant' });
        });
    });
}

// makeLast ensures we run after all other handlers (including scroll)
eventSource.makeLast(event_types.CHARACTER_MESSAGE_RENDERED, scrollLastMessageToTop);
eventSource.makeLast(event_types.USER_MESSAGE_RENDERED, scrollLastMessageToTop);
