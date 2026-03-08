import { eventSource, event_types } from '../../../script.js';

const CHARS_PER_SECOND = 80; // reading/streaming speed

jQuery(() => {
    eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, (messageIndex) => {
        const mesItem = $(`#chat .mes[mesid="${messageIndex}"]`);
        if (!mesItem.length) return;

        const mesText = mesItem.find('.mes_text');
        if (!mesText.length) return;

        const textLength = mesText.text().length;
        if (textLength < 10) return;

        const chatContainer = $('#chat');

        // Scroll to message top
        const messageTop = mesItem[0].offsetTop - chatContainer[0].offsetTop;
        chatContainer.scrollTop(messageTop);

        // Calculate duration based on text length
        const duration = textLength / CHARS_PER_SECOND;
        mesText.css('--stream-duration', `${duration}s`);
        mesText.addClass('streaming-reveal');

        // Auto-scroll during animation to follow the revealed content
        let animFrame;
        function followScroll() {
            const visibleBottom = mesItem[0].offsetTop + mesText[0].scrollHeight * (1 - parseFloat(getComputedStyle(mesText[0]).maxHeight) / mesText[0].scrollHeight || 1);
            const mesBottom = mesItem[0].offsetTop + mesItem[0].offsetHeight;
            const containerVisible = chatContainer.scrollTop() + chatContainer[0].clientHeight;

            if (mesBottom > containerVisible) {
                chatContainer.scrollTop(mesBottom - chatContainer[0].clientHeight);
            }

            if (mesText.hasClass('streaming-reveal')) {
                animFrame = requestAnimationFrame(followScroll);
            }
        }
        animFrame = requestAnimationFrame(followScroll);

        // Cleanup after animation ends
        mesText[0].addEventListener('animationend', () => {
            mesText.removeClass('streaming-reveal');
            mesText.css('--stream-duration', '');
            cancelAnimationFrame(animFrame);
        }, { once: true });
    });
});
