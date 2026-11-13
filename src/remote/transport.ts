// Compatibility export; infrastructure transport belongs to the optional plugin.
export {remoteTransport} from '../../examples/extensions/multi-machine/transport.mjs';
import {remoteTransport} from '../../examples/extensions/multi-machine/transport.mjs';
export type RemoteSocket=ReturnType<typeof remoteTransport.socket>;
