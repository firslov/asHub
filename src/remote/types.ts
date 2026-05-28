export interface RemoteHost {
  id: string;
  host: string;
  user?: string;
  port?: number;
  identityFile?: string;
  /** Pinned ashub-server tarball version; defaults to the local app's version. */
  serverVersion?: string;
  /** When set, skip SSH bootstrap and target this URL directly.  For
   *  testing the registry against a locally-running ashub. */
  directBaseUrl?: string;
  /** How to obtain the server tarball on the remote.
   *  "fetch" (default): remote curls from a release URL.
   *  "push": local pushes the matching tarball over the SSH channel — works
   *  for air-gapped hosts and before any releases are published. */
  installSource?: "fetch" | "push";
}

export interface ConnectedRemote {
  host: RemoteHost;
  /** Local 127.0.0.1 port that SSH-forwards to the remote ashub-server. */
  localPort: number;
  close(): Promise<void>;
}
