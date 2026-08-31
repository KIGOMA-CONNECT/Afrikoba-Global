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
  const [isMobile, setIsMobile] = useState(window.innerWidth <= 900);

  useEffect(() => {
    const handleResize = () => setIsMobile(window.innerWidth <= 900);
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  // Yield calculator formula: (Principal * 0.13) / 12
  const monthlyYield = Math.round((yieldAmount * 0.13) / 12);
  const totalYield12Months = monthlyYield * 12;

  return (
    <div className="landing-page">
      {/* 2. Conditional Smart Mobile Banner (Only visible on mobile) */}
      {showSmartBanner && isMobile && (
        <div className="smart-banner">
          <span>📱 Pakua App ya Afrikoba kupata usimamizi rahisi wa VICOBA.</span>
          <div className="smart-banner-actions">
            <a href="https://play.google.com/store/apps/details?id=com.afrikoba" target="_blank" rel="noopener noreferrer" className="store-badge-sm">Install</a>
            <button className="banner-close" onClick={() => setShowSmartBanner(false)}>&times;</button>
          </div>
        </div>
      )}

      {/* 1. Header / Navigation Bar (Fixed & Clean, No duplicate text) */}
      <nav className={`landing-nav ${showSmartBanner && isMobile ? 'with-banner' : ''}`}>
        <div className="logo">
          <div className="shield-icon">🛡️</div>
          <span>Afrikoba Global</span>
        </div>

        {/* Desktop Menu Only */}
        <ul className="nav-links desktop-only">
          <li><a href="#huduma">Huduma Zetu</a></li>
          <li><a href="#yield">Afrikoba Yield</a></li>
          <li><a href="#jinsi">Jinsi Inavyofanya Kazi</a></li>
          <li><a href="#uwekezaji">Uwekezaji (P2P)</a></li>
          <li><a href="#kuhusu">Kuhusu Sisi</a></li>
        </ul>

        <div className="nav-actions">
          <select className="lang-dropdown" value={lang} onChange={(e) => setLang(e.target.value)}>
            <option value="sw">SW</option>
            <option value="en">EN</option>
          </select>
          <Link to="/login"><button className="btn-outline">Ingia</button></Link>
          <Link to="/login"><button className="btn-primary">Jisajili</button></Link>
          
          <button className={`hamburger ${menuOpen ? 'open' : ''}`} onClick={() => setMenuOpen(!menuOpen)}>
            <span /><span /><span />
          </button>
        </div>
      </nav>

      {/* Mobile Drawer Menu (Hidden until toggled) */}
      <div className={`mobile-menu ${menuOpen ? 'open' : ''}`}>
        <a href="#huduma" onClick={() => setMenuOpen(false)}>Huduma Zetu</a>
        <a href="#yield" onClick={() => setMenuOpen(false)}>Afrikoba Yield</a>
        <a href="#jinsi" onClick={() => setMenuOpen(false)}>Jinsi Inavyofanya Kazi</a>
        <a href="#uwekezaji" onClick={() => setMenuOpen(false)}>Uwekezaji (P2P)</a>
        <a href="#kuhusu" onClick={() => setMenuOpen(false)}>Kuhusu Sisi</a>
        <Link to="/login" onClick={() => setMenuOpen(false)}><button className="btn-primary" style={{width:'100%', marginTop:10}}>Jisajili Sasa</button></Link>
      </div>

      {/* B. HERO SECTION */}
      <section className="hero">
        <div className="hero-inner">
          <div className="hero-content">
            <div className="hero-badge">✨ Mfuko wa Kitaifa wa Kidijitali</div>
            <h1>Mfumo Salama wa Kidijitali wa Akiba, VICOBA, Mzunguko na <span>Uwekezaji</span> Barani Afrika.</h1>
            <p className="subtitle">Simamia VICOBA kwa uwazi wa 100%, shiriki kwenye mizunguko ya Upatu isiyo na utapeli, na wekeza kwenye Mfuko wa Faida (13% Annual Yield) au miradi ya uzalishaji.</p>
            
            <div className="ctas">
              <a href="https://play.google.com/store/apps/details?id=com.afrikoba" target="_blank" rel="noopener noreferrer">
                <button className="btn-lg primary">▶ Pakua App Sasa</button>
              </a>
              <Link to="/login"><button className="btn-lg secondary">Fungua Akaunti ya Web</button></Link>
            </div>

            {/* App Store & Play Store Badges */}
            <div className="store-badges-row">
              <a href="https://play.google.com/store/apps/details?id=com.afrikoba" target="_blank" rel="noopener noreferrer" className="store-badge">
                <span className="s-icon">🤖</span>
                <div className="s-text"><small>Get it on</small><strong>Google Play</strong></div>
              </a>
              <a href="https://apps.apple.com/app/afrikoba/id123456789" target="_blank" rel="noopener noreferrer" className="store-badge">
                <span className="s-icon">🍏</span>
                <div className="s-text"><small>Download on the</small><strong>App Store</strong></div>
              </a>
            </div>
          </div>

          <div className="hero-visual">
            <div className="glass-mockup-card">
              <div className="mockup-header">
                <span>Akiba ya Mwezi</span>
                <span className="badge-growth">+14.2% 📈</span>
              </div>
              <div className="mockup-balance">
                {showBalance ? 'TZS 2,400,000' : 'TZS ***,***'}
                <button className="eye-btn" onClick={() => setShowBalance(!showBalance)} title="Ficha / Onyesha Salio">
                  {showBalance ? '👁️' : '🙈'}
                </button>
              </div>
              <div className="mockup-chart-mini">
                {[35, 55, 45, 75, 60, 90, 80].map((h, i) => (
                  <div key={i} className="chart-bar" style={{ height: `${h}%` }} />
                ))}
              </div>
              <div className="mockup-footer">
                <span>🟢 Mfuko wa Faida: Hai</span>
                <span className="gold-text">13% Pa.a</span>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* C. LIVE TRUST & SECURITY BAR */}
      <section className="trust-bar">
        <div className="trust-inner">
          <div className="counters-row">
            <div className="counter-box">
              <h3>TZS 850M+</h3>
              <p>Dedicated Capital</p>
            </div>
            <div className="counter-box">
              <h3>2,500+</h3>
              <p>Vikundi Vilivyosajiliwa</p>
            </div>
            <div className="counter-box">
              <h3>15,000+</h3>
              <p>Wawekezaji Hai</p>
            </div>
          </div>
          <div className="security-badges">
            <div className="s-badge">🏛️ BOT-Regulated Gateway</div>
            <div className="s-badge">🔒 256-Bit SSL Encrypted</div>
            <div className="s-badge">🛡️ PDPC Data Protection Compliant</div>
            <div className="s-badge">✅ NIDA Verified System</div>
          </div>
        </div>
      </section>

      {/* D. INTERACTIVE PRODUCT SHOWCASE (TAB BEDDING) */}
      <section className="showcase" id="huduma">
        <div className="showcase-inner">
          <div className="section-header">
            <h2>Interactive Product Showcase</h2>
            <p>Bofya kichupo chochote hapa chini kuona teknolojia na mifumo yetu ikifanya kazi.</p>
          </div>
          
          <div className="tabs-header">
            <button className={`tab-btn ${activeTab === 'vicoba' ? 'active' : ''}`} onClick={() => setActiveTab('vicoba')}>👥 VICOBA Digital</button>
            <button className={`tab-btn ${activeTab === 'rosca' ? 'active' : ''}`} onClick={() => setActiveTab('rosca')}>🔄 ROSCA / Upatu</button>
            <button className={`tab-btn ${activeTab === 'yield' ? 'active' : ''}`} onClick={() => setActiveTab('yield')} id="yield">🌱 Afrikoba Yield</button>
            <button className={`tab-btn ${activeTab === 'p2p' ? 'active' : ''}`} onClick={() => setActiveTab('p2p')} id="uwekezaji">💳 P2P Crowdfunding</button>
          </div>

          <div className="tab-content-card">
            {activeTab === 'vicoba' && (
              <div className="tab-pane">
                <div className="pane-info">
                  <h3>VICOBA Automation & Multi-Sig Approvals</h3>
                  <p>Kila ombi la mkopo linahitaji idhini ya pande mbili (Mwenyekiti na Katibu) ili kuzuia matumizi mabaya ya fedha za kikundi.</p>
                  <div className="approval-status-box">
                    <div className="approver">Mwenyekiti: <span className="badge-ok">Approved ✅</span></div>
                    <div className="approver">Katibu: <span className="badge-pending">Pending ⏳</span></div>
                  </div>
                </div>
                <div className="pane-visual vicoba-mock">
                  <div className="mock-box">
                    <strong>Ombi la Mkopo #402</strong>
                    <p>Kiasi: TZS 1,500,000</p>
                    <p>Hali: Inasubiri Saini ya Katibu</p>
                  </div>
                </div>
              </div>
            )}

            {activeTab === 'rosca' && (
              <div className="tab-pane">
                <div className="pane-info">
                  <h3>ROSCA / Upatu Engine (Code as Law)</h3>
                  <p>Mzunguko wa fedha unaopangwa kiotomatiki na kompyuta. Hakuna haja ya kukusanya pesa mkononi; mfumo unakata na kugawanya kwa wakati.</p>
                  <ul className="feature-list">
                    <li>✓ Mzunguko wa #3 kati ya 10</li>
                    <li>✓ Mwanachama Anayepokea Mwezi Huu: <strong>Aisha Juma</strong></li>
                  </ul>
                </div>
                <div className="pane-visual">
                  <div className="timeline-mock">
                    <div className="t-step done">Mwezi 1 ✓</div>
                    <div className="t-step done">Mwezi 2 ✓</div>
                    <div className="t-step active">Mwezi 3 (Sasa) 🟢</div>
                    <div className="t-step">Mwezi 4 ⏳</div>
                  </div>
                </div>
              </div>
            )}

            {activeTab === 'yield' && (
              <div className="tab-pane yield-pane" style={{gridTemplateColumns:'1fr'}}>
                <div className="pane-info" style={{maxWidth:700, margin:'0 auto', textAlign:'center'}}>
                  <h3>Afrikoba Yield (13% Annual Return)</h3>
                  <p>Funga mtaji wako kwa hiari upate faida ya 13% kwa mwaka inayolipwa kila mwezi moja kwa moja kwenye Wallet yako.</p>
                  
                  {/* 4. Yield Calculator Isolated Card */}
                  <div className="calculator-card-isolated">
                    <label style={{fontSize:15, fontWeight:700}}>Weka Kiasi cha Mtaji:</label>
                    <div className="capital-display">TZS {yieldAmount.toLocaleString()}</div>
                    <input 
                      type="range" 
                      min="100000" 
                      max="10000000" 
                      step="100000" 
                      value={yieldAmount} 
                      onChange={(e) => setYieldAmount(Number(e.target.value))} 
                    />
                    <div className="calc-live-result-banner">
                      "Ukiweka TZS {yieldAmount.toLocaleString()} ➔ Utapokea TZS {monthlyYield.toLocaleString()} kila mwezi (13% p.a)."
                    </div>
                    <div className="calc-results">
                      <div>Faida ya Kila Mwezi: <strong className="green-text">TZS {monthlyYield.toLocaleString()}</strong></div>
                      <div>Jumla ya Faida (Mwaka): <strong className="green-text">TZS {totalYield12Months.toLocaleString()}</strong></div>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {activeTab === 'p2p' && (
              <div className="tab-pane">
                <div className="pane-info">
                  <h3>P2P Crowdfunding & Split Payment</h3>
                  <p>Wekeza kwenye kilimo cha biashara na logistics. Faida inarudishwa moja kwa moja kupitia Automated Split Payment Engine.</p>
                  <div className="p2p-card-preview">
                    <div className="p2p-top">
                      <span>Kilimo cha Umwagiliaji Morogoro</span>
                      <span className="badge-green">ROI: 18% Pa.a</span>
                    </div>
                    <div className="progress-bar-wrap">
                      <div className="progress-fill" style={{width: '75%'}} />
                    </div>
                    <div className="p2p-bot">
                      <span>Mtaji: TZS 15M / 20M</span>
                      <span className="risk-tag">Risk: Low</span>
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      </section>

      {/* E. HOW IT WORKS & FOOTER */}
      <section className="how-it-works" id="jinsi">
        <div className="how-inner">
          <div className="section-header">
            <h2>Jinsi Inavyofanya Kazi</h2>
            <p>Hatua tatu rahisi kuanza safari yako ya kifedha.</p>
          </div>
          <div className="steps">
            <div className="step">
              <div className="step-num">1</div>
              <h3>Pakua au Jisajili</h3>
              <p>Pakua App au fungua akaunti ya mtandaoni kwa namba ya simu au NIDA.</p>
            </div>
            <div className="step">
              <div className="step-num">2</div>
              <h3>Chagua Huduma</h3>
              <p>Jiunge na kikundi cha VICOBA, anzisha Upatu, au wekeza kwenye Afrikoba Yield.</p>
            </div>
            <div className="step">
              <div className="step-num">3</div>
              <h3>Simamia na Ukuze</h3>
              <p>Pokea gawio la faida, fuatilia miamala kwa urahisi, na ulinde akiba yako.</p>
            </div>
          </div>
        </div>
      </section>

      <section className="kuhusu" id="kuhusu">
        <div className="kuhusu-inner">
          <h2>Kuhusu Afrikoba Global</h2>
          <p>Afrikoba Global ni jukwaa la kidijitali lenye maono ya miaka 150 ijayo ya kuleta ulinzi wa kibenki, uwazi wa VICOBA, na fursa za uwekezaji kwa mamilioni ya wananchi barani Afrika chini ya sheria za ulinzi wa data binafsi (PDPC).</p>
        </div>
      </section>

      <footer className="footer">
        <div className="footer-inner">
          <div className="footer-grid">
            <div className="footer-brand">
              <h3>Afrikoba Global</h3>
              <p>Mfumo Salama wa Kidijitali wa Akiba, VICOBA, Mzunguko na Uwekezaji.</p>
            </div>
            <div className="footer-links">
              <h4>Huduma</h4>
              <a href="#huduma">VICOBA Automation</a>
              <a href="#huduma">ROSCA / Upatu</a>
              <a href="#huduma">Afrikoba Yield</a>
              <a href="#huduma">P2P Hub</a>
            </div>
            <div className="footer-links">
              <h4>Mawasiliano</h4>
              <a href="mailto:support@afrikoba.com">support@afrikoba.com</a>
              <a href="tel:+255700000000">+255 700 000 000</a>
              <Link to="/login">Wasiliana Nasi</Link>
            </div>
          </div>
          <div className="footer-bottom">
            <p>&copy; {new Date().getFullYear()} Afrikoba Global. All rights reserved. Bank-Grade Security & PDPC Compliant.</p>
          </div>
        </div>
      </footer>
    </div>
  );
}
