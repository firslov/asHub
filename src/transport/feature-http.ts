import type * as http from 'node:http';
import type { createProviderBalanceService } from '../services/provider-balance.js';
import type { createSkillsMarketplaceService } from '../services/skills-marketplace.js';

export interface FeatureServices {
  balance: ReturnType<typeof createProviderBalanceService>;
  skills: ReturnType<typeof createSkillsMarketplaceService>;
}
interface FeatureRegistry { run<T>(id: string, fn: () => T | Promise<T>): Promise<T> }

/** Optional feature routes share the application's authenticated request gate
 * and registry in-flight accounting. Disabled features fail explicitly. */
export async function handleFeatureRequest(req: http.IncomingMessage, res: http.ServerResponse, services: FeatureServices, registry: FeatureRegistry): Promise<boolean> {
  const url = req.url ?? '/';
  let id: string | undefined;
  let handler: ((req: http.IncomingMessage, res: http.ServerResponse) => Promise<void>) | undefined;
  if (req.method === 'GET' && url.startsWith('/api/balance')) { id = 'provider-balance'; handler = services.balance.getBalance; }
  else if (req.method === 'GET' && url.startsWith('/api/skills/installed')) handler = services.skills.listInstalledSkills;
  else if (req.method === 'POST' && url === '/api/skills/install') handler = services.skills.installSkill;
  else if (req.method === 'POST' && url === '/api/skills/uninstall') handler = services.skills.uninstallSkill;
  else if (req.method === 'GET' && url.startsWith('/api/skills')) handler = services.skills.searchSkills;
  if (!handler) return false;
  try { await registry.run(id ?? 'skills-marketplace', () => handler!(req, res)); }
  catch (error) {
    if (res.writableEnded) return true;
    if (res.headersSent) { res.end(); return true; }
    res.writeHead((error as { status?: number }).status ?? 500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
  }
  return true;
}
