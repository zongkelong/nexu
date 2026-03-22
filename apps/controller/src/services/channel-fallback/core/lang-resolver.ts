import type {
  FallbackLang,
  NormalizedFallback,
} from "./channel-fallback-types.js";

const DEFAULT_LANG: FallbackLang = "en";

export function resolveFallbackLang(
  normalized: NormalizedFallback,
  preferredLocale?: FallbackLang,
): FallbackLang {
  return normalized.langHint ?? preferredLocale ?? DEFAULT_LANG;
}
