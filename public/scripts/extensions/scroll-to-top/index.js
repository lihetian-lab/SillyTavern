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

// When streaming starts, scroll the new AI message to top
eventSource.makeLast(event_types.GENERATION_STARTED, scrollLastMessageToTop);
// When streaming ends, scroll the completed message to top
eventSource.makeLast(event_types.CHARACTER_MESSAGE_RENDERED, scrollLastMessageToTop);
// When user message is rendered, scroll it to top
eventSource.makeLast(event_types.USER_MESSAGE_RENDERED, scrollLastMessageToTop);
