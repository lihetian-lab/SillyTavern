import { eventSource, event_types } from '../../../script.js';

let isStreaming = false;
let userScrolled = false;

const scrollTopDesc = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTop');

function scrollLastMessageToTop() {
    const chat = document.getElementById('chat');
    const lastMsg = chat?.querySelector('.mes:last-child');
    if (!lastMsg) return;
    lastMsg.scrollIntoView({ block: 'start', behavior: 'instant' });
}

function overrideChatScroll() {
    const chat = document.getElementById('chat');
    if (!chat || chat.__scrollTopOverridden) return;
    chat.__scrollTopOverridden = true;

    // Detect user wheel scroll → stop intercepting
    chat.addEventListener('wheel', () => {
        if (isStreaming) userScrolled = true;
    }, { passive: true });

    // Override scrollTop setter to intercept scrollChatToBottom at the property level.
    // jQuery's .scrollTop(val) internally does elem.scrollTop = val, so this catches it.
    Object.defineProperty(chat, 'scrollTop', {
        get() {
            return scrollTopDesc.get.call(this);
        },
        set(value) {
            if (isStreaming && !userScrolled) {
                const lastMsg = this.querySelector('.mes:last-child');
                if (lastMsg) {
                    const targetTop = lastMsg.offsetTop;
                    // If trying to scroll to bottom, redirect to top of last message
                    if (value > targetTop + 50) {
                        scrollTopDesc.set.call(this, targetTop);
                        return;
                    }
                }
            }
            scrollTopDesc.set.call(this, value);
        },
        configurable: true,
    });
}

eventSource.on(event_types.GENERATION_STARTED, () => {
    isStreaming = true;
    userScrolled = false;
});

eventSource.on(event_types.GENERATION_ENDED, () => { isStreaming = false; });
eventSource.on(event_types.GENERATION_STOPPED, () => { isStreaming = false; });

// Non-streaming: scroll on message render
eventSource.makeLast(event_types.CHARACTER_MESSAGE_RENDERED, () => {
    requestAnimationFrame(() => requestAnimationFrame(() => scrollLastMessageToTop()));
});

eventSource.makeLast(event_types.USER_MESSAGE_RENDERED, () => {
    requestAnimationFrame(() => requestAnimationFrame(() => scrollLastMessageToTop()));
});

// Setup
eventSource.on(event_types.CHAT_CHANGED, () => requestAnimationFrame(() => overrideChatScroll()));
requestAnimationFrame(() => overrideChatScroll());
