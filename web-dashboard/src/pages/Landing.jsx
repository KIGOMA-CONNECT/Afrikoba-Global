import React, { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { useT } from '../i18n/LangProvider.jsx';
import '../styles/landing.css';

export default function Landing() {
  const { t, lang, setLang } = useT();
  const [menuOpen, setMenuOpen] = useState(false);
  const [showBalance, setShowBalance] = useState(true);
  const [yieldAmount, setYieldAmount] = useState(1000000);
  const [showSmartBanner, setShowSmartBanner] = useState(true);
  const [isMobile, setIsMobile] = useState(window.innerWidth < 768);

  useEffect(() => {
    const handleResize = () => setIsMobile(window.innerWidth < 768);
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  const monthlyYield = Math.round((yieldAmount * 0.13) / 12);
  const totalYield12Months = monthlyYield * 12;

  const projects = [
    {
      tier: 'Tier A Gold Project',
      title: t('landing.proj1_title'),
      roi: '18% p.a Return',
      desc: t('landing.proj1_desc'),
      progress: 75,
      funded: 'TZS 15M / 20M',
    },
    {
      tier: 'Agribusiness Fattening',
      title: t('landing.proj2_title'),
      roi: '22% p.a Return',
      desc: t('landing.proj2_desc'),
      progress: 92,
      funded: 'TZS 28M / 30M',
    },
  ];

  const services = [
    {
      icon: '👥',
      title: t('landing.svc_vicoba'),
      desc: t('landing.svc_vicoba_desc'),
      cta: t('landing.svc_vicoba_cta'),
      href: '/login',
    },
    {
      icon: '🏛️',
      title: t('landing.svc_saccos'),
      desc: t('landing.svc_saccos_desc'),
      cta: t('landing.svc_saccos_cta'),
      href: '/login',
    },
    {
      icon: '🌱',
      title: t('landing.svc_yield'),
      desc: t('landing.svc_yield_desc'),
      cta: t('landing.svc_yield_cta'),
      href: '/login',
    },
    {
      icon: '🔄',
      title: t('landing.svc_rosca'),
      desc: t('landing.svc_rosca_desc'),
      cta: t('landing.svc_rosca_cta'),
      href: '/login',
    },
    {
      icon: '💳',
      title: t('landing.svc_p2p'),
      desc: t('landing.svc_p2p_desc'),
      cta: t('landing.svc_p2p_cta'),
      href: '/login',
    },
  ];

  const steps = [
    { num: '1', title: t('landing.step1_title'), desc: t('landing.step1_desc') },
    { num: '2', title: t('landing.step2_title'), desc: t('landing.step2_desc') },
    { num: '3', title: t('landing.step3_title'), desc: t('landing.step3_desc') },
    { num: '4', title: t('landing.step4_title'), desc: t('landing.step4_desc') },
  ];

  const yieldFeatures = [
    { icon: '🛡️', title: t('landing.pf_capital_title'), desc: t('landing.pf_capital_desc') },
    { icon: '📅', title: t('landing.pf_monthly_title'), desc: t('landing.pf_monthly_desc') },
    { icon: '📈', title: t('landing.pf_compound_title'), desc: t('landing.pf_compound_desc') },
  ];

  return (
    <div className="afrikoba-landing">
      {showSmartBanner && isMobile && (
        <div className="mobile-smart-banner">
          <span>{t('landing.banner')}</span>
          <div className="flex items-center gap-2">
            <a href="https://play.google.com/store/apps/details?id=com.afrikoba" target="_blank" rel="noopener noreferrer" className="banner-install-btn">{t('landing.install')}</a>
            <button className="banner-close-btn" onClick={() => setShowSmartBanner(false)}>&times;</button>
          </div>
        </div>
      )}

      {/* ===== HEADER ===== */}
      <header className={`landing-header landing-header-light ${showSmartBanner && isMobile ? 'banner-offset' : ''}`}>
        <div className="landing-logo">
          <img src="/afrikoba-icon.png" alt="Afrikoba" className="logo-img" style={{ width: 36, height: 36, borderRadius: 8 }} onError={(e) => { e.target.style.display = 'none'; e.target.nextSibling.style.display = 'flex'; }} />
          <div className="logo-shield" style={{ display: 'none' }}>🛡️</div>
          <span className="logo-text">AFRIKOBA <span className="logo-highlight">GLOBAL</span></span>
        </div>

        <nav className="landing-desktop-nav">
          <a href="#huduma">{t('landing.nav_services')}</a>
          <a href="#yield">{t('landing.nav_yield')}</a>
          <a href="#jinsi">{t('landing.nav_how')}</a>
          <a href="#uwekezaji">{t('landing.nav_invest')}</a>
        </nav>

        <div className="landing-nav-actions">
          <select className="landing-lang-select" value={lang} onChange={(e) => setLang(e.target.value)}>
            <option value="sw">🇹🇿 SW</option>
            <option value="en">🇬🇧 EN</option>
          </select>
          <Link to="/login" className="landing-btn-outline">{t('landing.login')}</Link>
          <Link to="/login" className="landing-btn-solid">{t('landing.open_account')}</Link>

          <button className={`landing-hamburger ${menuOpen ? 'active' : ''}`} onClick={() => setMenuOpen(!menuOpen)}>
            <span /><span /><span />
          </button>
        </div>
      </header>

      {menuOpen && (
        <div className="landing-mobile-drawer">
          <a href="#huduma" onClick={() => setMenuOpen(false)}>{t('landing.nav_services')}</a>
          <a href="#yield" onClick={() => setMenuOpen(false)}>{t('landing.nav_yield')}</a>
          <a href="#jinsi" onClick={() => setMenuOpen(false)}>{t('landing.nav_how')}</a>
          <a href="#uwekezaji" onClick={() => setMenuOpen(false)}>{t('landing.nav_invest')}</a>
          <div className="mobile-drawer-ctas">
            <Link to="/login" className="landing-btn-outline" onClick={() => setMenuOpen(false)}>{t('landing.login')}</Link>
            <Link to="/login" className="landing-btn-solid" onClick={() => setMenuOpen(false)}>{t('landing.open_account')}</Link>
          </div>
        </div>
      )}

      {/* ===== HERO ===== */}
      <section className="landing-hero-section">
        <div className="landing-hero-grid">
          <div className="landing-hero-copy">
            <div className="hero-tag">{t('landing.hero_tag')}</div>
            <h1>{t('landing.hero_title')}</h1>
            <p>{t('landing.hero_sub')}</p>

            <div className="landing-hero-buttons">
              <Link to="/login" className="landing-btn-primary">{t('landing.open_now')}</Link>
              <Link to="/login" className="landing-btn-secondary">{t('landing.login_system')}</Link>
            </div>
          </div>

          <div className="landing-hero-visual">
            <div className="fintech-card-mockup">
              <div className="mockup-top">
                <span>{t('landing.mockup_savings')}</span>
                <span className="growth-pill">+14.2% 📈</span>
              </div>
              <div className="mockup-amount">
                <span>{showBalance ? 'TZS 2,400,000' : 'TZS ***,***'}</span>
                <button className="mockup-eye" onClick={() => setShowBalance(!showBalance)}>
                  {showBalance ? '👁️' : '🙈'}
                </button>
              </div>
              <div className="mockup-graph-lines">
                {[40, 60, 50, 80, 65, 95, 85].map((h, i) => (
                  <div key={i} className="mockup-bar" style={{ height: `${h}%` }} />
                ))}
              </div>
              <div className="mockup-bottom">
                <span className="status-live">{t('landing.mockup_fund')}</span>
                <span className="yield-tag">13% Pa.a</span>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ===== YIELD CALCULATOR ===== */}
      <section className="landing-calc-section" id="yield">
        <div className="landing-container-narrow">
          <div className="landing-section-title">
            <h2>{t('landing.calc_title')}</h2>
            <p>{t('landing.calc_sub')}</p>
          </div>
          <div className="yield-calc-card">
            <div className="calc-rate-badge">13% p.a</div>
            <div className="calc-row">
              <span className="calc-label">{t('landing.calc_amount')}</span>
              <strong className="calc-value">TZS {yieldAmount.toLocaleString()}</strong>
            </div>
            <input
              type="range"
              className="landing-range-slider"
              min="100000"
              max="10000000"
              step="100000"
              value={yieldAmount}
              onChange={(e) => setYieldAmount(Number(e.target.value))}
            />
            <div className="calc-outputs">
              <div className="calc-output">
                <span className="calc-output-label">{t('landing.calc_monthly')}</span>
                <strong className="calc-output-value">TZS {monthlyYield.toLocaleString()}</strong>
              </div>
              <div className="calc-output">
                <span className="calc-output-label">{t('landing.calc_yearly')}</span>
                <strong className="calc-output-value">TZS {totalYield12Months.toLocaleString()}</strong>
              </div>
            </div>
            <Link to="/login" className="landing-btn-primary calc-cta">{t('landing.calc_cta')}</Link>
          </div>
        </div>
      </section>

      {/* ===== HUDUMA ZETU (SERVICES) ===== */}
      <section className="landing-services-section" id="huduma">
        <div className="landing-container">
          <div className="landing-section-title">
            <h2>{t('landing.services_title')}</h2>
            <p>{t('landing.services_sub')}</p>
            <p className="landing-section-sub">{t('landing.services_sub2')}</p>
          </div>
          <div className="landing-services-grid">
            {services.map((s, i) => (
              <div className="service-card" key={i}>
                <div className="service-icon">{s.icon}</div>
                <h3>{s.title}</h3>
                <p>{s.desc}</p>
                <Link to={s.href} className="service-cta">{s.cta} →</Link>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ===== AFRIKOBA YIELD POOL ===== */}
      <section className="landing-yieldpool-section">
        <div className="landing-container-narrow">
          <div className="landing-section-title">
            <h2>{t('landing.pool_title')}</h2>
            <p className="gold-text">{t('landing.pool_sub')}</p>
            <p className="landing-section-sub">{t('landing.pool_sub2')}</p>
          </div>
          <div className="yield-feature-grid">
            {yieldFeatures.map((f, i) => (
              <div className="yield-feature-card" key={i}>
                <div className="yield-feature-icon">{f.icon}</div>
                <h3>{f.title}</h3>
                <p>{f.desc}</p>
              </div>
            ))}
          </div>
          <div className="yieldpool-cta">
            <Link to="/login" className="landing-btn-primary">{t('landing.pool_cta')}</Link>
          </div>
        </div>
      </section>

      {/* ===== HATUA RAHISI (HOW IT WORKS) ===== */}
      <section className="landing-how-section" id="jinsi">
        <div className="landing-container">
          <div className="landing-section-title">
            <h2>{t('landing.how_title')}</h2>
            <p>{t('landing.how_sub')}</p>
            <p className="landing-section-sub">{t('landing.how_sub2')}</p>
          </div>
          <div className="landing-steps-grid landing-steps-grid-4">
            {steps.map((s, i) => (
              <div className="step-card" key={i}>
                <div className="step-num">{s.num}</div>
                <h3>{s.title}</h3>
                <p>{s.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ===== SOKO LA MIRADI (PROJECTS) ===== */}
      <section className="landing-market-section" id="uwekezaji">
        <div className="landing-container">
          <div className="landing-section-title">
            <h2>{t('landing.market_title')}</h2>
            <p>{t('landing.market_sub')}</p>
            <p className="landing-section-sub">{t('landing.market_sub2')}</p>
            <Link to="/login" className="landing-btn-secondary market-join-btn">{t('landing.market_join')}</Link>
          </div>
          <div className="project-grid">
            {projects.map((p, i) => (
              <div className="project-card" key={i}>
                <div className="project-tier">{p.tier}</div>
                <h3>{p.title}</h3>
                <div className="project-roi">{p.roi}</div>
                <p className="project-desc">{p.desc}</p>
                <div className="project-progress-head">
                  <span>{t('landing.progress')}</span>
                  <span>{t('landing.funded', { pct: p.progress, amt: p.funded })}</span>
                </div>
                <div className="progress-bar-bg"><div className="progress-bar-fill" style={{ width: `${p.progress}%` }} /></div>
                <Link to="/login" className="project-invest-btn">{t('landing.invest')}</Link>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ===== CTA ===== */}
      <section className="landing-cta-section">
        <div className="landing-cta-inner">
          <h2>{t('landing.cta_title')}</h2>
          <p>{t('landing.cta_sub')}</p>
          <div className="landing-cta-buttons">
            <Link to="/login" className="landing-btn-primary">{t('landing.cta_open')}</Link>
            <Link to="/login" className="landing-btn-secondary landing-btn-dark">{t('landing.cta_login')}</Link>
          </div>
        </div>
      </section>

      {/* ===== FOOTER ===== */}
      <footer className="landing-footer" id="kuhusu">
        <div className="landing-footer-container">
          <div className="footer-col">
            <h3 style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <img src="/afrikoba-icon.png" alt="Afrikoba" style={{ width: 28, height: 28, borderRadius: 6 }} onError={(e) => { e.target.style.display = 'none'; }} />
              AFRIKOBA
            </h3>
            <p>{t('landing.footer_tag')}</p>
          </div>
          <div className="footer-col">
            <h4>{t('landing.footer_services')}</h4>
            <a href="#huduma">{t('landing.svc_vicoba')}</a>
            <a href="#yield">{t('landing.svc_yield')}</a>
            <a href="#huduma">{t('landing.svc_rosca')}</a>
            <a href="#uwekezaji">{t('landing.svc_p2p')}</a>
          </div>
          <div className="footer-col">
            <h4>{t('landing.footer_contact')}</h4>
            <a href="mailto:support@afrikoba.com">support@afrikoba.com</a>
            <a href="tel:+255700000000">+255 700 000 000</a>
            <Link to="/login">{t('landing.footer_contact_cta')}</Link>
          </div>
        </div>
        <div className="landing-footer-bottom">
          <p>{t('landing.footer_copyright')}</p>
        </div>
      </footer>
    </div>
  );
}