import { scrollChatToBottom } from '../../../script.js';

// Override: scroll to the TOP of the last message instead of the bottom of the chat
const chat = document.getElementById('chat');

const observer = new MutationObserver(() => {
    const lastMsg = chat?.querySelector('.mes:last-child');
    if (!lastMsg) return;

    // Wait a frame so SillyTavern's own scrollChatToBottom runs first, then override
    requestAnimationFrame(() => {
        requestAnimationFrame(() => {
            lastMsg.scrollIntoView({ block: 'start', behavior: 'instant' });
        });
    });
});

observer.observe(chat, { childList: true });
