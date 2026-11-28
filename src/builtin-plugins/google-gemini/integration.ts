import { resolveApiKey } from 'agent-sh/auth';
import type { IntegrationModule } from '../../integrations.js';

export const configureProvider: NonNullable<IntegrationModule['configureProvider']> = (ctx, provider) => {
  ctx.agent?.providers.register({
    id: provider.id,
    baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai/',
    get apiKey() { return resolveApiKey(provider.id).key ?? undefined; },
    defaultModel: provider.models[0]?.id,
    models: provider.models,
  });
};
