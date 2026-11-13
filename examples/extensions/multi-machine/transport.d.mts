import {fetch,WebSocket,type RequestInit} from 'undici';
export const remoteTransport:{fetch:(url:URL,init?:RequestInit)=>ReturnType<typeof fetch>;socket:(url:URL)=>WebSocket};
