/** Bounded plugin status hints. No executable actions or conversation content. */
export interface PluginActivity { id: string; projectId: string; sessionId: string; label: string; state: string }
export class PluginActivities {
  private entries = new Map<string, Map<string, PluginActivity>>();
  constructor(private valid: (project: string, session: string) => boolean, private changed: () => void) {}
  bind(plugin: string, signal: AbortSignal) {
    const records = new Map<string, PluginActivity>(); this.entries.set(plugin, records);
    signal.addEventListener('abort', () => { if (this.entries.get(plugin) === records) { this.entries.delete(plugin); this.changed(); } }, { once: true });
    return { replace: (input: PluginActivity[]) => {
      signal.throwIfAborted();
      if (!Array.isArray(input) || input.length > 100 || input.some(v => !v ||
        ['id','projectId','sessionId','label','state'].some(k => typeof (v as any)[k] !== 'string' || !(v as any)[k].trim() || (v as any)[k].length > (k === 'label' ? 200 : 100)))) throw Error('Invalid activity hints');
      const next = input.filter(v => this.valid(v.projectId, v.sessionId)).map(v => ({id:v.id,projectId:v.projectId,sessionId:v.sessionId,label:v.label,state:v.state}));
      if (JSON.stringify([...records.values()]) === JSON.stringify(next)) return;
      records.clear(); for (const v of next) records.set(v.id, v); this.changed();
    } };
  }
  list(project: string) {
    return [...this.entries.values()].flatMap(m => [...m.values()]).filter(v => v.projectId === project && this.valid(project, v.sessionId)).map(v => ({ ...v }));
  }
}
