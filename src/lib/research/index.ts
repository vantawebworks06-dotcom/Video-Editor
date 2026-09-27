import { brave } from "./providers/brave";
import { gdelt } from "./providers/gdelt";
import { meta } from "./providers/meta";
import { reddit } from "./providers/reddit";
import { stockProviders } from "./providers/stock";
import { urlProvider } from "./providers/url";
import { wikipedia } from "./providers/wikipedia";
import { x } from "./providers/x";
import { youtube } from "./providers/youtube";
import type { ResearchProvider, ResearchProviderId } from "./types";

/** Registry: add a provider here and it appears in Research and Settings → Integrations. */
export const RESEARCH_PROVIDERS: ResearchProvider[] = [youtube, x, reddit, meta, brave, gdelt, wikipedia, ...stockProviders, urlProvider];

export function getResearchProvider(id: string): ResearchProvider | undefined {
  return RESEARCH_PROVIDERS.find((p) => p.id === id);
}

export const RESEARCH_PROVIDER_IDS = RESEARCH_PROVIDERS.map((p) => p.id) as ResearchProviderId[];

export * from "./types";
