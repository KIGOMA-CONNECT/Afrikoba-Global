import React, { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import '../styles/landing.css';

export default function Landing() {
  const [menuOpen, setMenuOpen] = useState(false);
  const [activeTab, setActiveTab] = useState('yield');
  const [lang, setLang] = useState('sw');
  const [showBalance, setShowBalance] = useState(true);
  const [yieldAmount, setYieldAmount] = useState(1000000); // 1M TZS default
  const [showSmartBanner, setShowSmartBanner] = useState(true);
  const [isMobile, setIsMobile] = useState(window.innerWidth < 768);

  useEffect(() => {
    const handleResize = () => setIsMobile(window.innerWidth < 768);
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  const monthlyYield = Math.round((yieldAmount * 0.13) / 12);
  const totalYield12Months = monthlyYield * 12;

  return (
    <div className="afrikoba-landing">
      {/* Smart Mobile Banner */}
      {showSmartBanner && isMobile && (
        <div className="mobile-smart-banner">
          <span>📱 Pakua App ya Afrikoba kupata usimamizi rahisi wa VICOBA.</span>
          <div className="flex items-center gap-2">
            <a href="https://play.google.com/store/apps/details?id=com.afrikoba" target="_blank" rel="noopener noreferrer" className="banner-install-btn">Install</a>
            <button className="banner-close-btn" onClick={() => setShowSmartBanner(false)}>&times;</button>
          </div>
        </div>
      )}

      {/* 1. STYLED HEADER */}
      <header className={`landing-header ${showSmartBanner && isMobile ? 'banner-offset' : ''}`}>
        <div className="landing-logo">
          <div className="logo-shield">🛡️</div>
          <span className="logo-text">Afrikoba <span className="logo-highlight">Global</span></span>
        </div>
        
        <nav className="landing-desktop-nav">
          <a href="#huduma">Huduma Zetu</a>
          <a href="#yield">Afrikoba Yield</a>
          <a href="#jinsi">Jinsi Inavyofanya Kazi</a>
          <a href="#uwekezaji">Uwekezaji (P2P)</a>
          <a href="#kuhusu">Kuhusu Sisi</a>
        </nav>

        <div className="landing-nav-actions">
          <select className="landing-lang-select" value={lang} onChange={(e) => setLang(e.target.value)}>
            <option value="sw">🇹🇿 SW</option>
            <option value="en">🇬🇧 EN</option>
          </select>
          <Link to="/login" className="landing-btn-outline">Ingia</Link>
          <Link to="/login" className="landing-btn-solid">Jisajili</Link>

          <button className={`landing-hamburger ${menuOpen ? 'active' : ''}`} onClick={() => setMenuOpen(!menuOpen)}>
            <span /><span /><span />
          </button>
        </div>
      </header>

      {/* Mobile Drawer */}
      {menuOpen && (
        <div className="landing-mobile-drawer">
          <a href="#huduma" onClick={() => setMenuOpen(false)}>Huduma Zetu</a>
          <a href="#yield" onClick={() => setMenuOpen(false)}>Afrikoba Yield</a>
          <a href="#jinsi" onClick={() => setMenuOpen(false)}>Jinsi Inavyofanya Kazi</a>
          <a href="#uwekezaji" onClick={() => setMenuOpen(false)}>Uwekezaji (P2P)</a>
          <a href="#kuhusu" onClick={() => setMenuOpen(false)}>Kuhusu Sisi</a>
          <div className="mobile-drawer-ctas">
            <Link to="/login" className="landing-btn-outline" onClick={() => setMenuOpen(false)}>Ingia</Link>
            <Link to="/login" className="landing-btn-solid" onClick={() => setMenuOpen(false)}>Jisajili Sasa</Link>
          </div>
        </div>
      )}

      {/* 2. HERO SECTION */}
      <section className="landing-hero-section">
        <div className="landing-hero-grid">
          <div className="landing-hero-copy">
            <div className="hero-tag">✨ Mfuko wa Kitaifa wa Kidijitali</div>
            <h1>Mfumo Salama wa Kidijitali wa Akiba, VICOBA, Mzunguko na <span className="gold-text">Uwekezaji</span> Barani Afrika.</h1>
            <p>Simamia VICOBA kwa uwazi wa 100%, shiriki kwenye mizunguko ya Upatu isiyo na utapeli, na wekeza kwenye Mfuko wa Faida (13% Annual Yield) au miradi ya uzalishaji.</p>
            
            <div className="landing-hero-buttons">
              <a href="https://play.google.com/store/apps/details?id=com.afrikoba" target="_blank" rel="noopener noreferrer" className="landing-btn-primary">
                <span>▶</span> Pakua App Sasa
              </a>
              <Link to="/login" className="landing-btn-secondary">
                Fungua Akaunti ya Web
              </Link>
            </div>

            <div className="landing-app-badges">
              <a href="https://play.google.com/store/apps/details?id=com.afrikoba" target="_blank" rel="noopener noreferrer" className="store-badge-card">
                <span className="store-emoji">🤖</span>
                <div className="store-info"><small>Get it on</small><strong>Google Play</strong></div>
              </a>
              <a href="https://apps.apple.com/app/afrikoba/id123456789" target="_blank" rel="noopener noreferrer" className="store-badge-card">
                <span className="store-emoji">🍏</span>
                <div className="store-info"><small>Download on</small><strong>App Store</strong></div>
              </a>
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

      {/* 3. METRICS BAR */}
      <section className="landing-metrics-bar">
        <div className="landing-metrics-grid">
          <div className="metric-card">
            <h3>TZS 850M+</h3>
            <p>Dedicated Capital</p>
          </div>
          <div className="metric-card">
            <h3>2,500+</h3>
            <p>Vikundi Vilivyosajiliwa</p>
          </div>
          <div className="metric-card">
            <h3>15,000+</h3>
            <p>Wawekezaji Hai</p>
          </div>
        </div>
        <div className="landing-trust-pills">
          <span>🏛️ BOT-Regulated Gateway</span>
          <span>🔒 256-Bit SSL Encrypted</span>
          <span>🛡️ PDPC Compliant</span>
          <span>✅ NIDA Verified</span>
        </div>
      </section>

      {/* 4. INTERACTIVE PRODUCT SHOWCASE (TABS) */}
      <section className="landing-showcase-section" id="huduma">
        <div className="landing-container">
          <div className="landing-section-title">
            <h2>Interactive Product Showcase</h2>
            <p>Bofya kichupo chochote hapa chini kuona teknolojia na mifumo yetu ikifanya kazi.</p>
          </div>
          
          <div className="landing-tabs-bar">
            <button className={`landing-tab ${activeTab === 'vicoba' ? 'active' : ''}`} onClick={() => setActiveTab('vicoba')}>👥 VICOBA Digital</button>
            <button className={`landing-tab ${activeTab === 'rosca' ? 'active' : ''}`} onClick={() => setActiveTab('rosca')}>🔄 ROSCA / Upatu</button>
            <button className={`landing-tab ${activeTab === 'yield' ? 'active' : ''}`} onClick={() => setActiveTab('yield')} id="yield">🌱 Afrikoba Yield</button>
            <button className={`landing-tab ${activeTab === 'p2p' ? 'active' : ''}`} onClick={() => setActiveTab('p2p')} id="uwekezaji">💳 P2P Crowdfunding</button>
          </div>

          <div className="landing-showcase-card">
            {activeTab === 'yield' && (
              <div className="showcase-content-grid">
                <div className="showcase-text">
                  <h3>Afrikoba Yield (13% Annual Return)</h3>
                  <p>Funga mtaji wako kwa hiari upate faida ya 13% kwa mwaka inayolipwa kila mwezi moja kwa moja kwenye Wallet yako.</p>
                  
                  <div className="yield-slider-box">
                    <div className="slider-head">
                      <span>Weka Kiasi cha Mtaji:</span>
                      <strong className="slider-value">TZS {yieldAmount.toLocaleString()}</strong>
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
                    <div className="slider-formula-banner">
                      💡 "Ukiweka TZS {yieldAmount.toLocaleString()} ➔ Utapokea TZS {monthlyYield.toLocaleString()} kila mwezi (13% p.a)."
                    </div>
                    <div className="slider-totals">
                      <span>Faida ya Mwezi: <strong>TZS {monthlyYield.toLocaleString()}</strong></span>
                      <span>Jumla Mwaka: <strong>TZS {totalYield12Months.toLocaleString()}</strong></span>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {activeTab === 'vicoba' && (
              <div className="showcase-content-grid">
                <div className="showcase-text">
                  <h3>VICOBA Automation & Multi-Sig Approvals</h3>
                  <p>Kila ombi la mkopo linahitaji idhini ya pande mbili (Mwenyekiti na Katibu) ili kuzuia matumizi mabaya ya fedha za kikundi.</p>
                  <div className="showcase-subcard">
                    <div className="sub-row"><span>Mwenyekiti:</span> <span className="status-approved">Approved ✅</span></div>
                    <div className="sub-row"><span>Katibu:</span> <span className="status-pending">Pending ⏳</span></div>
                  </div>
                </div>
              </div>
            )}

            {activeTab === 'rosca' && (
              <div className="showcase-content-grid">
                <div className="showcase-text">
                  <h3>ROSCA / Upatu Engine (Code as Law)</h3>
                  <p>Mzunguko wa fedha unaopangwa kiotomatiki na kompyuta. Hakuna haja ya kukusanya pesa mkononi; mfumo unakata na kugawanya kwa wakati.</p>
                  <ul className="showcase-bullets">
                    <li>✓ Mzunguko wa #3 kati ya 10</li>
                    <li>✓ Mwanachama Anayepokea Mwezi Huu: <strong>Aisha Juma</strong></li>
                  </ul>
                </div>
              </div>
            )}

            {activeTab === 'p2p' && (
              <div className="showcase-content-grid">
                <div className="showcase-text">
                  <h3>P2P Crowdfunding & Split Payment</h3>
                  <p>Wekeza kwenye kilimo cha biashara na logistics. Faida inarudishwa moja kwa moja kupitia Automated Split Payment Engine.</p>
                  <div className="showcase-subcard">
                    <div className="sub-row font-bold"><span>Kilimo cha Umwagiliaji Morogoro</span> <span className="growth-pill">ROI: 18% Pa.a</span></div>
                    <div className="progress-bar-bg"><div className="progress-bar-fill" /></div>
                    <div className="sub-row text-xs text-muted"><span>Mtaji: TZS 15M / 20M</span> <span className="badge-risk">Risk: Low</span></div>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      </section>

      {/* 5. HOW IT WORKS */}
      <section className="landing-how-section" id="jinsi">
        <div className="landing-container">
          <div className="landing-section-title">
            <h2>Jinsi Inavyofanya Kazi</h2>
            <p>Hatua tatu rahisi kuanza safari yako ya kifedha.</p>
          </div>
          <div className="landing-steps-grid">
            <div className="step-card">
              <div className="step-num">1</div>
              <h3>Pakua au Jisajili</h3>
              <p>Pakua App au fungua akaunti ya mtandaoni kwa namba ya simu au NIDA.</p>
            </div>
            <div className="step-card">
              <div className="step-num">2</div>
              <h3>Chagua Huduma</h3>
              <p>Jiunge na kikundi cha VICOBA, anzisha Upatu, au wekeza kwenye Afrikoba Yield.</p>
            </div>
            <div className="step-card">
              <div className="step-num">3</div>
              <h3>Simamia na Ukuze</h3>
              <p>Pokea gawio la faida, fuatilia miamala kwa urahisi, na ulinde akiba yako.</p>
            </div>
          </div>
        </div>
      </section>

      {/* 6. FOOTER */}
      <footer className="landing-footer" id="kuhusu">
        <div className="landing-footer-container">
          <div className="footer-col">
            <h3>🛡️ Afrikoba Global</h3>
            <p>Mfumo Salama wa Kidijitali wa Akiba, VICOBA, Mzunguko na Uwekezaji.</p>
          </div>
          <div className="footer-col">
            <h4>Huduma</h4>
            <a href="#huduma">VICOBA Automation</a>
            <a href="#huduma">ROSCA / Upatu</a>
            <a href="#yield">Afrikoba Yield</a>
            <a href="#uwekezaji">P2P Hub</a>
          </div>
          <div className="footer-col">
            <h4>Mawasiliano</h4>
            <a href="mailto:support@afrikoba.com">support@afrikoba.com</a>
            <a href="tel:+255700000000">+255 700 000 000</a>
            <Link to="/login">Wasiliana Nasi</Link>
          </div>
        </div>
        <div className="landing-footer-bottom">
          <p>&copy; {new Date().getFullYear()} Afrikoba Global. All rights reserved. Bank-Grade Security & PDPC Compliant.</p>
        </div>
      </footer>
    </div>
  );
}
