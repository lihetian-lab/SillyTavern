import { eventSource, event_types } from '../../../script.js';

jQuery(() => {
    eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, (messageIndex) => {
        const mesItem = $(`#chat .mes[mesid="${messageIndex}"]`);
        if (!mesItem.length) return;

        const mesText = mesItem.find('.mes_text');
        if (!mesText.length) return;

        const chatContainer = $('#chat');

        // Save the full HTML content
        const fullHtml = mesText.html();
        const fullText = mesText.text();

        // Skip if message is too short
        if (fullText.length < 10) return;

        // Clear the text and scroll to the message top
        mesText.html('');
        const messageTop = mesItem[0].offsetTop - chatContainer[0].offsetTop;
        chatContainer.scrollTop(messageTop);

        // Stream the text character by character
        let charIndex = 0;
        const speed = 15; // ms per character

        function streamNext() {
            if (charIndex >= fullHtml.length) {
                // Ensure final HTML is correct
                mesText.html(fullHtml);
                return;
            }

            // Handle HTML tags - add the whole tag at once
            if (fullHtml[charIndex] === '<') {
                const tagEnd = fullHtml.indexOf('>', charIndex);
                if (tagEnd !== -1) {
                    charIndex = tagEnd + 1;
                } else {
                    charIndex++;
                }
            } else {
                charIndex++;
            }

            mesText.html(fullHtml.substring(0, charIndex));

            // Auto-scroll to keep the bottom of the text visible
            const mesBottom = mesItem[0].offsetTop + mesItem[0].offsetHeight - chatContainer[0].offsetTop;
            const containerBottom = chatContainer.scrollTop() + chatContainer[0].clientHeight;
            if (mesBottom > containerBottom) {
                chatContainer.scrollTop(mesBottom - chatContainer[0].clientHeight);
            }

            setTimeout(streamNext, speed);
        }

        streamNext();
    });
});
