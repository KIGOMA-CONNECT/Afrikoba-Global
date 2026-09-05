import React, { createContext, useContext, useEffect, useMemo, useState, useCallback } from 'react';
import { resolveLocale, tr } from './index.js';

const LangContext = createContext(null);

export function LangProvider({ children }) {
  const [lang, setLang] = useState(() => resolveLocale());

  const changeLang = useCallback((next) => {
    const resolved = resolveLocale(next);
    setLang(resolved);
    applyToDom(resolved);
    try {
      localStorage.setItem('afrikoba_lang', resolved);
    } catch (e) {
      /* ignore */
    }
  }, []);

  function applyToDom(l) {
    try {
      document.documentElement.lang = l;
      if (document.body) document.body.setAttribute('data-lang', l);
      document.title = l === 'en'
        ? 'AFRIKOBA GLOBAL | Digital Bank'
        : 'AFRIKOBA GLOBAL | Benki ya Dijitali';
    } catch (e) {
      /* ignore */
    }
  }

  useEffect(() => {
    applyToDom(lang);
    const onStorage = (e) => {
      if (e.key === 'afrikoba_lang' && e.newValue) setLang(resolveLocale(e.newValue));
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [lang]);

  const t = useMemo(() => (key, vars) => tr(key, lang, vars), [lang]);

  return <LangContext.Provider value={{ lang, setLang: changeLang, t }}>{children}</LangContext.Provider>;
}

export function useT() {
  return useContext(LangContext);
}

export default LangProvider;