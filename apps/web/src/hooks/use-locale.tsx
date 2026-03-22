import i18n from "i18next";
import {
  type ReactNode,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  getApiInternalDesktopPreferences,
  patchApiInternalDesktopPreferences,
} from "../../lib/api/sdk.gen";

export type Locale = "en" | "zh";

interface LocaleCtx {
  locale: Locale;
  setLocale: (l: Locale) => void;
  t: (key: string) => string;
}

const STORAGE_KEY = "nexu_locale";

function detectDefault(): Locale {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === "en" || stored === "zh") return stored;
  } catch {
    /* ignore */
  }
  const lang = navigator.language || "";
  return lang.startsWith("zh") ? "zh" : "en";
}

const LocaleContext = createContext<LocaleCtx>({
  locale: "en",
  setLocale: () => {},
  t: (k) => k,
});

export function LocaleProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(detectDefault);
  const didBootstrapRef = useRef(false);

  useEffect(() => {
    i18n.changeLanguage(locale);
  }, [locale]);

  useEffect(() => {
    if (didBootstrapRef.current) {
      return;
    }
    didBootstrapRef.current = true;
    void bootstrapLocale(setLocaleState);
  }, []);

  const setLocale = useCallback((l: Locale) => {
    setLocaleState(l);
    try {
      localStorage.setItem(STORAGE_KEY, l);
    } catch {
      /* ignore */
    }
    void syncDesktopLocale(l);
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: locale dependency forces re-render on language change
  const t = useCallback(
    (key: string) => {
      return i18n.t(key);
    },
    [locale],
  );

  return (
    <LocaleContext.Provider value={{ locale, setLocale, t }}>
      {children}
    </LocaleContext.Provider>
  );
}

export function useLocale() {
  return useContext(LocaleContext);
}

async function syncDesktopLocale(locale: Locale): Promise<void> {
  await patchApiInternalDesktopPreferences({
    body: {
      locale: locale === "zh" ? "zh-CN" : "en",
    },
  }).catch(() => {
    // Best-effort sync only; local UI language should still work offline.
  });
}

async function bootstrapLocale(
  setLocaleState: (locale: Locale) => void,
): Promise<void> {
  const localCandidate = detectDefault();

  const response = await getApiInternalDesktopPreferences().catch(() => null);
  const storedLocale = response?.data?.locale ?? null;

  if (storedLocale === "en" || storedLocale === "zh-CN") {
    const nextLocale = storedLocale === "zh-CN" ? "zh" : "en";
    setLocaleState(nextLocale);
    try {
      localStorage.setItem(STORAGE_KEY, nextLocale);
    } catch {
      /* ignore */
    }
    return;
  }

  setLocaleState(localCandidate);
  try {
    localStorage.setItem(STORAGE_KEY, localCandidate);
  } catch {
    /* ignore */
  }

  if (response) {
    await syncDesktopLocale(localCandidate);
  }
}
