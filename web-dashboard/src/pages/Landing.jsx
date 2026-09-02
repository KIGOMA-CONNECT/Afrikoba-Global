import React, { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import '../styles/landing.css';

export default function Landing() {
  const [menuOpen, setMenuOpen] = useState(false);
  const [lang, setLang] = useState('sw');
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
      title: 'Kilimo cha Mpunga Dakawa (Season 2027)',
      roi: '18% p.a Return',
      desc: 'Uwekezaji wa moja kwa moja kwenye shamba la hekta 50 la mpunga Morogoro, ukiwa na bima rasmi ya mazao.',
      progress: 75,
      funded: 'TZS 15M / 20M',
    },
    {
      tier: 'Agribusiness Fattening',
      title: "Unenepeshaji Ng'ombe wa Nyama (Sumbawanga)",
      roi: '22% p.a Return',
      desc: "Mradi wa unenepeshaji ng'ombe 100 wa nyama kwa ajili ya soko la kuuza nje ya nchi.",
      progress: 92,
      funded: 'TZS 28M / 30M',
    },
  ];

  const services = [
    {
      icon: '👥',
      title: 'VICOBA Digital',
      desc: "Mwenyekiti anasajili kikundi na kupata Namba Maalumu (Group Code). Wanachama wanajiunga au kuona maombi ya mwaliko. Idhini za mikopo zinafanyika kwa Multi-Sig PIN.",
      cta: 'Sajili Kikundi Sasa',
      href: '/login',
    },
    {
      icon: '🌱',
      title: 'Afrikoba Yield (13% p.a)',
      desc: "Funga mtaji wako kwa hiari kwenye Mfuko wa Faida na upokee 13% kila mwezi moja kwa moja kwenye Wallet yako au Benki.",
      cta: 'Wekeza Kwenye Yield',
      href: '/login',
    },
    {
      icon: '🔄',
      title: 'ROSCA / Smart Upatu',
      desc: "Mzunguko wa fedha unaoendeshwa na mfumo kiotomatiki bila kupendelea mtu. Mfumo unakata mchango kupitia Mobile Money na kumpa anayestahili.",
      cta: 'Anzisha Upatu',
      href: '/login',
    },
    {
      icon: '💳',
      title: 'P2P Crowdfunding',
      desc: "Wekeza kwenye miradi ya uzalishaji iliyohakikiwa (Kilimo, Mifugo) yenye Bima ya Mfuko na faida ya hadi 22% kwa mwaka.",
      cta: 'Angalia Miradi',
      href: '/login',
    },
  ];

  const steps = [
    { num: '1', title: 'Fungua Akaunti', desc: 'Jaza namba ya simu na kitambulisho cha NIDA au Pasi ya Kusafiria mara moja.' },
    { num: '2', title: 'Chagua Huduma', desc: 'Anzisha Kikundi cha VICOBA, jiunge na mzunguko wa ROSCA, au fungua Afrikoba Yield.' },
    { num: '3', title: 'Weka/Toa Pesa', desc: 'Tumia M-Pesa, Tigo Pesa, Selcom, au Akaunti yako ya Benki (CRDB/NMB/NBC) kufanya miamala.' },
    { num: '4', title: 'Kukuza Mtaji', desc: 'Fuatilia ripoti zako za kifedha, gawio la kila mwezi, na maendeleo ya vikundi vyako.' },
  ];

  const yieldFeatures = [
    { icon: '🛡️', title: 'Capital Protection', desc: 'Mtaji wako umelindwa 100% na kuwekezwa kwenye mifuko iliyoidhinishwa na Mamlaka ya Masoko ya Mitaji (CMSA).' },
    { icon: '📅', title: 'Monthly Payouts', desc: 'Gawio lako linaingia kwenye Wallet au Akaunti yako ya Benki/Mobile Money tarehe 30 ya kila mwezi.' },
    { icon: '📈', title: 'Compound Growth', desc: 'Washa mfumo wa Auto-Reinvest ili faida yako iongezeke kwenye mtaji na kuzalisha faida kubwa zaidi.' },
  ];

  return (
    <div className="afrikoba-landing">
      {showSmartBanner && isMobile && (
        <div className="mobile-smart-banner">
          <span>📱 Pakua App ya Afrikoba kupata usimamizi rahisi wa VICOBA.</span>
          <div className="flex items-center gap-2">
            <a href="https://play.google.com/store/apps/details?id=com.afrikoba" target="_blank" rel="noopener noreferrer" className="banner-install-btn">Install</a>
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
          <a href="#huduma">Huduma Zetu</a>
          <a href="#yield">Afrikoba Yield (13%)</a>
          <a href="#jinsi">Jinsi Inavyofanya Kazi</a>
          <a href="#uwekezaji">Uwekezaji (P2P)</a>
        </nav>

        <div className="landing-nav-actions">
          <select className="landing-lang-select" value={lang} onChange={(e) => setLang(e.target.value)}>
            <option value="sw">🇹🇿 SW</option>
            <option value="en">🇬🇧 EN</option>
          </select>
          <Link to="/login" className="landing-btn-outline">Ingia (Login)</Link>
          <Link to="/login" className="landing-btn-solid">Fungua Akaunti</Link>

          <button className={`landing-hamburger ${menuOpen ? 'active' : ''}`} onClick={() => setMenuOpen(!menuOpen)}>
            <span /><span /><span />
          </button>
        </div>
      </header>

      {menuOpen && (
        <div className="landing-mobile-drawer">
          <a href="#huduma" onClick={() => setMenuOpen(false)}>Huduma Zetu</a>
          <a href="#yield" onClick={() => setMenuOpen(false)}>Afrikoba Yield (13%)</a>
          <a href="#jinsi" onClick={() => setMenuOpen(false)}>Jinsi Inavyofanya Kazi</a>
          <a href="#uwekezaji" onClick={() => setMenuOpen(false)}>Uwekezaji (P2P)</a>
          <div className="mobile-drawer-ctas">
            <Link to="/login" className="landing-btn-outline" onClick={() => setMenuOpen(false)}>Ingia (Login)</Link>
            <Link to="/login" className="landing-btn-solid" onClick={() => setMenuOpen(false)}>Fungua Akaunti Sasa</Link>
          </div>
        </div>
      )}

      {/* ===== HERO ===== */}
      <section className="landing-hero-section">
        <div className="landing-hero-grid">
          <div className="landing-hero-copy">
            <div className="hero-tag">✨ Enterprise Financial Operating System</div>
            <h1>Mfumo Salama wa Kidijitali wa Akiba, VICOBA, na Uwekezaji <span className="gold-text">Afrika</span>.</h1>
            <p>Simamia Vikundi vya VICOBA kwa uwazi wa 100%, shiriki kwenye mizunguko ya Upatu isiyo na utapeli, na wekeza kwenye Mfuko wa Faida wa 13% Annual Yield.</p>

            <div className="landing-hero-buttons">
              <Link to="/login" className="landing-btn-primary">🚀 Fungua Akaunti Sasa</Link>
              <Link to="/login" className="landing-btn-secondary">🔐 Ingia Kwenye System</Link>
            </div>
          </div>

          <div className="landing-hero-visual">
            <div className="fintech-card-mockup">
              <div className="mockup-top">
                <span>Akiba ya Mwezi</span>
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
                <span className="status-live">🟢 Mfuko wa Faida: Hai</span>
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
            <h2>Afrikoba Yield Calculator</h2>
            <p>Piga hesabu ya faida yako kabla ya kujisajili:</p>
          </div>
          <div className="yield-calc-card">
            <div className="calc-rate-badge">13% p.a</div>
            <div className="calc-row">
              <span className="calc-label">Kiasi Unachotaka Kuwekeza:</span>
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
                <span className="calc-output-label">Gawio la Kila Mwezi (Monthly Payout):</span>
                <strong className="calc-output-value">TZS {monthlyYield.toLocaleString()}</strong>
              </div>
              <div className="calc-output">
                <span className="calc-output-label">Jumla ya Faida (Mwaka):</span>
                <strong className="calc-output-value">TZS {totalYield12Months.toLocaleString()}</strong>
              </div>
            </div>
            <Link to="/login" className="landing-btn-primary calc-cta">🌱 Anza Kuwekeza (Create Account)</Link>
          </div>
        </div>
      </section>

      {/* ===== HUDUMA ZETU (SERVICES) ===== */}
      <section className="landing-services-section" id="huduma">
        <div className="landing-container">
          <div className="landing-section-title">
            <h2>Mfumo wa Huduma Zetu</h2>
            <p>Huduma Zetu za Kiwango cha Kibenki</p>
            <p className="landing-section-sub">Teknolojia iliyoundwa kurahisisha na kulinda akiba, mikopo, na uwekezaji wako.</p>
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
            <h2>Mfuko wa Uwekezaji</h2>
            <p className="gold-text">Afrikoba Yield Pool (13% p.a)</p>
            <p className="landing-section-sub">Pata gawio la uhakika la 13% kwa mwaka linalohesabiwa na kulipwa kila mwezi. Unao uwezo wa kuweka Compound Interest au kutoa faida yako muda wowote.</p>
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
            <Link to="/login" className="landing-btn-primary">Fungua Yield Vault Sasa</Link>
          </div>
        </div>
      </section>

      {/* ===== HATUA RAHISI (HOW IT WORKS) ===== */}
      <section className="landing-how-section" id="jinsi">
        <div className="landing-container">
          <div className="landing-section-title">
            <h2>Hatua Rahisi</h2>
            <p>Jinsi Inavyofanya Kazi</p>
            <p className="landing-section-sub">Hatua nne tu za kuanza safari yako ya kifedha na Afrikoba Global.</p>
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
            <h2>Soko la Miradi</h2>
            <p>Uwekezaji wa P2P Crowdfunding</p>
            <p className="landing-section-sub">Wekeza kwenye miradi ya kimkakati ya uzalishaji iliyokaguliwa na wataalamu wetu wa kifedha.</p>
            <Link to="/login" className="landing-btn-secondary market-join-btn">Jiunge Kuanza Uwekezaji</Link>
          </div>
          <div className="project-grid">
            {projects.map((p, i) => (
              <div className="project-card" key={i}>
                <div className="project-tier">{p.tier}</div>
                <h3>{p.title}</h3>
                <div className="project-roi">{p.roi}</div>
                <p className="project-desc">{p.desc}</p>
                <div className="project-progress-head">
                  <span>Progress:</span>
                  <span>{p.progress}% Funded ({p.funded})</span>
                </div>
                <div className="progress-bar-bg"><div className="progress-bar-fill" style={{ width: `${p.progress}%` }} /></div>
                <Link to="/login" className="project-invest-btn">Wekeza Kwenye Mradi Huu →</Link>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ===== CTA ===== */}
      <section className="landing-cta-section">
        <div className="landing-cta-inner">
          <h2>Upo Tayari Kuanza Safari Yako ya Kifedha?</h2>
          <p>Jiunge na maelfu ya watumiaji na vikundi vinavyotumia Afrikoba Global kusimamia na kukuza akiba zao.</p>
          <div className="landing-cta-buttons">
            <Link to="/login" className="landing-btn-primary">Fungua Akaunti Bure</Link>
            <Link to="/login" className="landing-btn-secondary landing-btn-dark">Ingia Kwenye Akaunti</Link>
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
            <p>Mfumo Salama wa Kidijitali wa Akiba, VICOBA, Mzunguko na Uwekezaji.</p>
          </div>
          <div className="footer-col">
            <h4>Huduma</h4>
            <a href="#huduma">VICOBA Digital</a>
            <a href="#yield">Afrikoba Yield</a>
            <a href="#huduma">ROSCA / Upatu</a>
            <a href="#uwekezaji">P2P Crowdfunding</a>
          </div>
          <div className="footer-col">
            <h4>Mawasiliano</h4>
            <a href="mailto:support@afrikoba.com">support@afrikoba.com</a>
            <a href="tel:+255700000000">+255 700 000 000</a>
            <Link to="/login">Wasiliana Nasi</Link>
          </div>
        </div>
        <div className="landing-footer-bottom">
          <p>&copy; 2026 Afrikoba Global Services Limited. BOT Regulated Gateway & PDPC Compliant.</p>
        </div>
      </footer>
    </div>
  );
}
