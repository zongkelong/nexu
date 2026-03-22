import type {
  FallbackErrorCode,
  FallbackLang,
  FallbackTemplateMap,
} from "./channel-fallback-types.js";

const DEFAULT_LANG: FallbackLang = "en";
const UNKNOWN_ERROR_CODE: FallbackErrorCode = "unknown";

export function selectFallbackTemplate(
  templates: FallbackTemplateMap,
  errorCode: FallbackErrorCode,
  lang: FallbackLang,
): string {
  const localized = templates[errorCode] ?? templates[UNKNOWN_ERROR_CODE];
  const unknownLocalized = templates[UNKNOWN_ERROR_CODE];
  return (
    localized?.[lang] ??
    localized?.[DEFAULT_LANG] ??
    unknownLocalized?.[lang] ??
    unknownLocalized?.[DEFAULT_LANG] ??
    ""
  );
}
