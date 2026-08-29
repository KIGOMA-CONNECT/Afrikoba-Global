import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { resolveLocale, tr } from './index.js';

const LangContext = createContext(null);

export function LangProvider({ children }) {
  const [lang, setLang] = useState(() => resolveLocale());

  const changeLang = (next) => {
    setLang(resolveLocale(next));
    try {
      localStorage.setItem('afrikoba_lang', resolveLocale(next));
      document.documentElement.lang = resolveLocale(next);
    } catch (e) {
      /* ignore */
    }
  };

  useEffect(() => {
    document.documentElement.lang = lang;
  }, [lang]);

  const t = useMemo(() => (key, vars) => tr(key, lang, vars), [lang]);

  return <LangContext.Provider value={{ lang, setLang: changeLang, t }}>{children}</LangContext.Provider>;
}

export function useT() {
  return useContext(LangContext);
}

export default LangProvider;