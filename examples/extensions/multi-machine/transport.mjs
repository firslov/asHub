import { Agent, fetch, WebSocket } from 'undici';
// Mobile access is an infrastructure connection, not a model request. Use an
// explicit dispatcher for both enrollment and the persistent upload socket.
// Do not replace the global dispatcher/fetch or change any conversation policy.
const direct = new Agent();
export const remoteTransport = {
    fetch: (url, init) => fetch(url, { ...init, dispatcher: direct }),
    socket: (url) => new WebSocket(url, { dispatcher: direct }),
};
