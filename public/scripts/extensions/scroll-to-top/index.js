import { eventSource, event_types } from '../../../script.js';

jQuery(() => {
    eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, () => {
        $('#chat').scrollTop(0);
    });
});
