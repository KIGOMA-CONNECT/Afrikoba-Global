import React, { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import '../styles/landing.css';

const ONBOARDING_KEY = 'afrikoba_onboarding_done';

const onboardingSlides = [
  { icon: '🤝', title: 'Mizunguko na VICOBA Bila Utapeli', text: 'Mfumo wa kompyuta unaratibu namba za kupokea na kutoa idhini ya mikopo kwa uwazi wa 100%.' },
  { icon: '📈', title: 'Wekeza na Ukuze Mtaji Wako', text: 'Shiriki kwenye miradi halisi ya uzalishaji (Kilimo, Logistics, Biashara) na upate gawio la faida moja kwa moja.' },
  { icon: '💰', title: 'Miamala ya Papo kwa Papo', text: 'Weka na utoe fedha kupitia mitandao yote ya simu na benki kwa ulinzi mkuu.' },
];

function useIsMobile() {
  const [m, setM] = useState(() => window.innerWidth < 768);
  useEffect(() => { const h = () => setM(window.innerWidth < 768); window.addEventListener('resize', h); return () => window.removeEventListener('resize', h); }, []);
  return m;
}

export default function Landing() {
  const [menuOpen, setMenuOpen] = useState(false);
  const [bannerDismissed, setBannerDismissed] = useState(false);
  const [obStep, setObStep] = useState(0);
  const [obDone, setObDone] = useState(() => localStorage.getItem(ONBOARDING_KEY) === '1');
  const isMobile = useIsMobile();

  const isStandalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone;
  const showBanner = isMobile && !bannerDismissed && !isStandalone;

  function dismissOb() { localStorage.setItem(ONBOARDING_KEY, '1'); setObDone(true); }

  return (
    <>
      {/* NAVBAR */}
      <nav className="landing-nav">
        <div className="logo">
          <svg viewBox="0 0 32 32" fill="none"><circle cx="16" cy="16" r="14" fill="#0b5d1e"/><path d="M10 20 L16 8 L22 20 Z" fill="#d4a843" opacity="0.9"/><circle cx="16" cy="16" r="4" fill="#fff"/></svg>
          Afrikoba
        </div>
        <ul className="nav-links">
          <li><a href="#huduma">Huduma</a></li>
          <li><a href="#jinsi">Jinsi Inavyofanya Kazi</a></li>
          <li><a href="#uwekezaji">Uwekezaji</a></li>
        </ul>
        <div className="nav-actions">
          <Link to="/login"><button className="btn-ghost">Ingia</button></Link>
          <Link to="/login"><button className="btn-primary">Jisajili</button></Link>
        </div>
        <button className={`hamburger ${menuOpen ? 'open' : ''}`} onClick={() => setMenuOpen(!menuOpen)}>
          <span /><span /><span />
        </button>
      </nav>
      <div className={`mobile-menu ${menuOpen ? 'open' : ''}`}>
        <a href="#huduma" onClick={() => setMenuOpen(false)}>Huduma</a>
        <a href="#jinsi" onClick={() => setMenuOpen(false)}>Jinsi Inavyofanya Kazi</a>
        <a href="#uwekezaji" onClick={() => setMenuOpen(false)}>Uwekezaji</a>
        <Link to="/login" onClick={() => setMenuOpen(false)}><button className="btn-primary">Jisajili Sasa</button></Link>
      </div>

      {/* HERO */}
      <section className="hero">
        <div className="hero-inner">
          <div className="hero-content">
            <h1>Mfumo Salama wa Kidijitali wa Akiba, VICOBA, Mzunguko na <span>Uwekezaji</span> Barani Afrika.</h1>
            <p className="subtitle">Simamia mfumo wako wa VICOBA kwa uwazi wa 100%, shiriki kwenye mizunguko ya Upatu isiyokuwa na utapeli, na wekeza kwenye miradi ya uzalishaji yenye faida.</p>
            <div className="ctas">
              <a href="https://play.google.com/store/apps/details?id=com.afrikoba" target="_blank" rel="noopener noreferrer">
                <button className="btn-lg primary">▶ Pata App Sasa</button>
              </a>
              <Link to="/login"><button className="btn-lg secondary">Fungua Akaunti</button></Link>
            </div>
          </div>
          <div className="hero-visual">
            <div className="hero-phone">
              <div className="phone-inner">
                <div className="phone-brand">Afrikoba</div>
                <div className="phone-chart">
                  {[30,50,40,70,55,85,65].map((h,i) => <div key={i} className="bar" style={{height:`${h}%`}} />)}
                </div>
                <div className="phone-stats">
                  <div className="big">TZS 2.4M</div>
                  <div className="small">Akiba yako ya mwezi huu</div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* SOCIAL PROOF */}
      <section className="social-proof">
        <div className="social-proof-inner">
          <div className="badges-row">
            <div className="badge-item"><span className="badge-icon">🏛️</span><div className="badge-text">BOT Regulated<br/>Payment Gateways</div></div>
            <div className="badge-item"><span className="badge-icon">🔒</span><div className="badge-text">Bank-Grade<br/>SSL 256-bit Encryption</div></div>
            <div className="badge-item"><span className="badge-icon">✅</span><div className="badge-text">NIDA E-Signature<br/>Verified</div></div>
          </div>
          <div className="stats-row">
            <div className="stat-item"><div className="stat-value">TZS 500M+</div><div className="stat-label">Zimesimamiwa</div></div>
            <div className="stat-item"><div className="stat-value">1,200+</div><div className="stat-label">Vikundi Vimesajiliwa</div></div>
            <div className="stat-item"><div className="stat-value">50,000+</div><div className="stat-label">Watumiaji Wenye Akaunti</div></div>
          </div>
        </div>
      </section>

      {/* SERVICES */}
      <section className="services" id="huduma">
        <div className="services-inner">
          <div className="section-header">
            <h2>Huduma Kuu Zetu</h2>
            <p>Mfumo kamili wa kidijitali unaozunguka kila haja ya kifedha ya vikundi na watu binafsi barani Afrika.</p>
          </div>
          <div className="services-grid">
            <div className="service-card">
              <div className="icon">👥</div>
              <h3>VICOBA Automation</h3>
              <p>Mikopo na akiba zenye uwazi wa saini mbili za viongozi (Mwenyekiti na Katibu) na SMS alerts kwa kila muamala.</p>
            </div>
            <div className="service-card">
              <div className="icon">🔄</div>
              <h3>ROSCA / Upatu Engine</h3>
              <p>Mzunguko wa kiotomatiki unaopangwa na kompyuta (Code as Law) bila kuogopa mtu kukimbia na fedha.</p>
            </div>
            <div className="service-card">
              <div className="icon">🌱</div>
              <h3>P2P Investment Hub</h3>
              <p>Wekeza kwenye Kilimo, Logistics, na Viwanda vilivyohakikiwa upate gawio la faida kiotomatiki kupitia Automated Split Payment Engine.</p>
            </div>
            <div className="service-card">
              <div className="icon">💳</div>
              <h3>Digital Wallet</h3>
              <p>Weka na utoe fedha papo hapo kupitia M-Pesa, Tigo Pesa, Airtel Money, Halopesa, na Benki.</p>
            </div>
          </div>
        </div>
      </section>

      {/* HOW IT WORKS */}
      <section className="how-it-works" id="jinsi">
        <div className="how-inner">
          <div className="section-header">
            <h2>Jinsi Inavyofanya Kazi</h2>
            <p>Hatua tatu tu kuanza.</p>
          </div>
          <div className="steps">
            <div className="step">
              <div className="step-num">1</div>
              <h3>Pakua au Jisajili</h3>
              <p>Pakua App ya Afrikoba au jisajili kwa namba ya simu/NIDA kwenye www.afrikoba.com.</p>
            </div>
            <div className="step">
              <div className="step-num">2</div>
              <h3>Jiunge na Kikundi</h3>
              <p>Jiunge na Kikundi chako, Chagua Mzunguko wa Upatu, au Omba mkopo wa P2P Investment.</p>
            </div>
            <div className="step">
              <div className="step-num">3</div>
              <h3>Weka Akiba, Pokea Faida</h3>
              <p>Weka akiba, pokea mzunguko, au pata gawio la faida moja kwa moja kwenye Wallet yako.</p>
            </div>
          </div>
        </div>
      </section>

      {/* INVESTOR */}
      <section className="investor" id="uwekezaji">
        <div className="investor-inner">
          <h2>Una mradi unaotafuta mtaji?</h2>
          <p>Jiunge kama Issuer kwenye Afrikoba P2P Crowdfunding. Wasilisha mradi wako, weka malipo ya awali (listing fee), na upate mtaji kutoka kwa wawekezaji wetu. Mfumo wetu wa Automated Split Payment utagawanya faida kiotomatiki.</p>
          <div className="ctas">
            <Link to="/login"><button className="btn-lg gold">Wasilisha Mradi Wako</button></Link>
            <a href="mailto:support@afrikoba.com"><button className="btn-lg outline">Wasiliana Nasi</button></a>
          </div>
        </div>
      </section>

      {/* FOOTER */}
      <footer className="footer">
        <div className="footer-inner">
          <div className="footer-grid">
            <div className="footer-brand">
              <h3>Afrikoba Global</h3>
              <p>Mfumo salama wa kidijitali wa akiba, VICOBA, mzunguko na uwekezaji barani Afrika.</p>
            </div>
            <div className="footer-col">
              <h4>Huduma</h4>
              <a href="#huduma">VICOBA</a>
              <a href="#huduma">ROSCA / Upatu</a>
              <a href="#huduma">P2P Investment</a>
              <a href="#huduma">Digital Wallet</a>
            </div>
            <div className="footer-col">
              <h4>Msaada</h4>
              <a href="mailto:support@afrikoba.com">Email Support</a>
              <a href="https://wa.me/255700000000">WhatsApp</a>
              <a href="/login">Ingia</a>
            </div>
            <div className="footer-col">
              <h4>Kisheria</h4>
              <a href="/privacy">Privacy Policy</a>
              <a href="/terms">Terms of Service</a>
              <a href="/compliance">BOT/PDPC Compliance</a>
            </div>
          </div>
          <div className="footer-bottom">
            <span>&copy; {new Date().getFullYear()} Afrikoba Global. Haki zote zimehifadhiwa.</span>
            <span>Dar es Salaam, Tanzania</span>
          </div>
        </div>
      </footer>

      {/* MOBILE APP BANNER */}
      {showBanner && (
        <div className="app-banner">
          📱 Kupata uzoefu bora zaidi, <a href="https://play.google.com/store/apps/details?id=com.afrikoba" target="_blank" rel="noopener noreferrer">Pakua App ya Afrikoba</a>
          <button className="close-banner" onClick={() => setBannerDismissed(true)}>&times;</button>
        </div>
      )}

      {/* ONBOARDING MODAL */}
      {!obDone && (
        <div className="onboarding-overlay" onClick={dismissOb}>
          <div className="onboarding-card" onClick={(e) => e.stopPropagation()}>
            <button className="skip-btn" onClick={dismissOb}>Ruka &rarr;</button>
            <div className="graphic">{onboardingSlides[obStep].icon}</div>
            <h2>{onboardingSlides[obStep].title}</h2>
            <p>{onboardingSlides[obStep].text}</p>
            <div className="dots">
              {onboardingSlides.map((_, i) => <div key={i} className={`dot ${i === obStep ? 'active' : ''}`} />)}
            </div>
            <div className="ob-actions">
              {obStep < onboardingSlides.length - 1 ? (
                <button className="btn-ob primary" onClick={() => setObStep(obStep + 1)}>Endelea</button>
              ) : (
                <>
                  <Link to="/login"><button className="btn-ob primary">Tengeneza Akaunti Mpya</button></Link>
                  <Link to="/login"><button className="btn-ob ghost">Tayari una Akaunti? Ingia</button></Link>
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}