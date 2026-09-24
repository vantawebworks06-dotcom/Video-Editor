import type { ProviderId } from "@/lib/domain/types";
import { GiphyProvider } from "./giphy";
import { InternetArchiveProvider } from "./internetArchive";
import { PexelsProvider } from "./pexels";
import { PixabayProvider } from "./pixabay";
import type { MediaProvider } from "./types";
import { WikimediaProvider } from "./wikimedia";

export const pexels = new PexelsProvider();
export const pixabay = new PixabayProvider();
export const wikimedia = new WikimediaProvider();
export const internetArchive = new InternetArchiveProvider();
export const giphy = new GiphyProvider();

/** Registry: add a provider here and it participates in search automatically. */
export const PROVIDERS: Partial<Record<ProviderId, MediaProvider>> = {
  pexels,
  pixabay,
  wikimedia,
  internet_archive: internetArchive,
  giphy,
};

export function getProvider(id: ProviderId): MediaProvider | undefined {
  return PROVIDERS[id];
}

export * from "./types";
export { ProviderError } from "./http";
