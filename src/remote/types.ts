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
  /** Optional override for the providers/defaultProvider block written by
   *  bootstrapConfig().  Useful when the local default refers to a model
   *  not reachable from the remote (e.g. local ollama). */
  defaultProvider?: string;
}

export interface RemoteReadiness {
  /** Remote has ~/.agent-sh/keys.json. */
  keys: boolean;
  /** Remote has ~/.agent-sh/settings.json with a non-empty providers block. */
  providers: boolean;
}

export interface ConnectedRemote {
  host: RemoteHost;
  /** Local 127.0.0.1 port that SSH-forwards to the remote ashub-server. */
  localPort: number;
  /** Probed once after install; refreshed by bootstrapConfig(). */
  readiness: RemoteReadiness;
  /** Push local ~/.agent-sh/keys.json and a minimal providers-only
   *  settings.json to the remote.  No-op for fields already present. */
  bootstrapConfig(): Promise<RemoteReadiness>;
  close(): Promise<void>;
}
