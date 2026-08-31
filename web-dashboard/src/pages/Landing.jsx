import React, { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import '../styles/landing.css';

const ONBOARDING_KEY = 'afrikoba_onboarding_done';

const serviceDetails = {
  vicoba: {
    icon: '👥',
    title: 'VICOBA Automation',
    tagline: 'Mikopo na akiba zenye uwazi wa saini mbili za viongozi (Mwenyekiti na Katibu) na SMS alerts kwa kila muamala.',
    features: [
      'Saini Mbili za Kiotomatiki: Kutoa mkopo kunahitaji idhini ya Mwenyekiti na Katibu.',
      'Usimamizi wa Vikundi: Taarifa zote za michango, faini na mikopo zinahifadhiwa kwenye Cloud yenye ulinzi wa Bank-Grade.',
      'SMS & Push Alerts: Wanachama wote wanapata taarifa ya papo hapo kupitia SMS kila muamala unapofanyika.',
      'Single Source of Truth: Inazuia migogoro yote ya kimahesabu ndani ya kikundi.'
    ],
    steps: [
      'Hatua ya 1: Pakua App au Jisajili kupitia www.afrikoba.com.',
      'Hatua ya 2: Chagua "Unda Kikundi Kipya" au pokea mwaliko kutoka kwa Mwenyekiti wako.',
      'Hatua ya 3: Weka akiba yako ya mwezi na uanze kufurahia mikopo ya uwazi na ya haraka.'
    ]
  },
  rosca: {
    icon: '🔄',
    title: 'ROSCA / Upatu Engine',
    tagline: 'Mzunguko wa kiotomatiki unaopangwa na kompyuta (Code as Law) bila kuogopa mtu kukimbia na fedha.',
    features: [
      'Code as Law: Mfumo unaratibu zamu zote bila upendeleo wala hofu ya mwanachama kukimbia na michango.',
      'Auto-Debit & Payout: Siku ya zamu yako, mfumo unahamisha fedha moja kwa moja kwenye Wallet yako.',
      'Uchaguzi wa Mizunguko: Unaweza kuchagua mzunguko wa wiki au mwezi kulingana na uwezo wako.',
      'Ulinzi wa Dhamana: Mfumo unazuia kuchelewesha michango kupitia mfumo wa trust score.'
    ],
    steps: [
      'Hatua ya 1: Chagua kiwango cha mchango na idadi ya wanafamilia/marafiki kwenye Upatu.',
      'Hatua ya 2: Mfumo unapanga ratiba kamili na namba za zamu kwa haki kabisa.',
      'Hatua ya 3: Pokea malipo yako ya mzunguko moja kwa moja kila zamu yako inapofika.'
    ]
  },
  p2p: {
    icon: '🌱',
    title: 'P2P Investment Hub',
    tagline: 'Wekeza kwenye Kilimo, Logistics, na Viwanda vilivyohakikiwa upate gawio la faida kiotomatiki kupitia Automated Split Payment Engine.',
    features: [
      'Verified Projects: Miradi yote hupitishwa kwenye ukaguzi mkali wa Due Diligence kabla ya kuwekwa kwenye soko.',
      'Split Payment Engine: Mapato yanayoingia kutoka kwenye mradi yanagawanywa kiotomatiki kwenda kwa wawekezaji.',
      'High Returns: Faida ya ushindani kuanzia 13% hadi 18% kwa mwaka.',
      'Risk Transparency: Viwango vya hatari (Low/Medium) vinaonyeshwa wazi kabla hujawekeza.'
    ],
    steps: [
      'Hatua ya 1: Vinjari miradi inayopatikana kwenye P2P Hub (Kilimo, Biashara, n.k).',
      'HatuaData ya 2: Wekeza kiasi unachotaka kuanzia TZS 10,000 kupitia Digital Wallet yako.',
      'Hatua ya 3: Fuatilia makuzi ya mtaji wako na upokee gawio la faida kila mwezi kwenye akaunti yako.'
    ]
  },
  wallet: {
    icon: '💳',
    title: 'Digital Wallet',
    tagline: 'Weka na utoe fedha papo hapo kupitia M-Pesa, Tigo Pesa, Airtel Money, Halopesa, na Benki.',
    features: [
      'Instant Deposit & Withdrawal: Uunganisho wa moja kwa moja na Mobile Money na mifumo ya Benki.',
      'Multi-Currency Support: Simamia fedha za ndani na za kimataifa kwa urahisi.',
      'Bank-Grade Encryption: Taarifa zote zinalindwa chini ya Sheria ya Ulinzi wa Data Binafsi (PDPC).',
      'Instant Notifications: Pata ujumbe wa SMS na taarifa za papo hapo kwa kila muamala.'
    ],
    steps: [
      'Hatua ya 1: Fungua akaunti yako kwa namba ya simu tu.',
      'Hatua ya 2: Bonyeza "Weka Fedha" na uchague mtandao wako wa simu (M-Pesa, Tigo Pesa, n.k).',
      'Hatua ya 3: Kamilisha muamala kupitia simu yako na uanze kufanya shughuli zote salama.'
    ]
  }
};

export default function Landing() {
  const [menuOpen, setMenuOpen] = useState(false);
  const [activeModal, setActiveModal] = useState(null);
  const [bannerDismissed, setBannerDismissed] = useState(false);
  const stats = { totalBalanceFormatted: 'TZS 500M+', vicobaGroups: 1200, registeredUsers: 50000 };

  return (
    <>
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
                  <div className="small">Akiba yako ya mwezi huu (+12%)</div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="social-proof">
        <div className="social-proof-inner">
          <div className="badges-row">
            <div className="badge-item"><span className="badge-icon">🏛️</span><div className="badge-text">BOT Regulated<br/>Payment Gateways</div></div>
            <div className="badge-item"><span className="badge-icon">🔒</span><div className="badge-text">Bank-Grade<br/>SSL 256-bit Encryption</div></div>
            <div className="badge-item"><span className="badge-icon">✅</span><div className="badge-text">NIDA E-Signature<br/>Verified</div></div>
          </div>
          <div className="stats-row">
            <div className="stat-item"><div className="stat-value">{stats.totalBalanceFormatted}</div><div className="stat-label">Zimesimamiwa</div></div>
            <div className="stat-item"><div className="stat-value">{stats.vicobaGroups}+</div><div className="stat-label">Vikundi Vimesajiliwa</div></div>
            <div className="stat-item"><div className="stat-value">{stats.registeredUsers}+</div><div className="stat-label">Watumiaji Wenye Akaunti</div></div>
          </div>
        </div>
      </section>

      <section className="services" id="huduma">
        <div className="services-inner">
          <div className="section-header">
            <h2>Huduma Kuu Zetu</h2>
            <p>Bofya huduma yoyote hapa chini ili kusoma maelezo ya kina na kujisajili mara moja.</p>
          </div>
          <div className="services-grid">
            <div className="service-card" onClick={() => setActiveModal('vicoba')} style={{cursor:'pointer'}}>
              <div className="icon">👥</div>
              <h3>VICOBA Automation</h3>
              <p>Mikopo na akiba zenye uwazi wa saini mbili za viongozi (Mwenyekiti na Katibu) na SMS alerts kwa kila muamala.</p>
              <span className="service-link">Soma zaidi &rarr;</span>
            </div>
            <div className="service-card" onClick={() => setActiveModal('rosca')} style={{cursor:'pointer'}}>
              <div className="icon">🔄</div>
              <h3>ROSCA / Upatu Engine</h3>
              <p>Mzunguko wa kiotomatiki unaopangwa na kompyuta (Code as Law) bila kuogopa mtu kukimbia na fedha.</p>
              <span className="service-link">Soma zaidi &rarr;</span>
            </div>
            <div className="service-card" onClick={() => setActiveModal('p2p')} style={{cursor:'pointer'}}>
              <div className="icon">🌱</div>
              <h3>P2P Investment Hub</h3>
              <p>Wekeza kwenye Kilimo, Logistics, na Viwanda vilivyohakikiwa upate gawio la faida kiotomatiki kupitia Automated Split Payment Engine.</p>
              <span className="service-link">Soma zaidi &rarr;</span>
            </div>
            <div className="service-card" onClick={() => setActiveModal('wallet')} style={{cursor:'pointer'}}>
              <div className="icon">💳</div>
              <h3>Digital Wallet</h3>
              <p>Weka na utoe fedha papo hapo kupitia M-Pesa, Tigo Pesa, Airtel Money, Halopesa, na Benki.</p>
              <span className="service-link">Soma zaidi &rarr;</span>
            </div>
          </div>
        </div>
      </section>

      {/* SERVICE DETAILS MODAL */}
      {activeModal && serviceDetails[activeModal] && (
        <div className="modal-backdrop" onClick={() => setActiveModal(null)}>
          <div className="modal-content" onClick={e => e.stopPropagation()}>
            <button className="modal-close" onClick={() => setActiveModal(null)}>&times;</button>
            <div className="modal-header">
              <span className="modal-icon">{serviceDetails[activeModal].icon}</span>
              <h2>{serviceDetails[activeModal].title}</h2>
            </div>
            <p className="modal-tagline">{serviceDetails[activeModal].tagline}</p>
            
            <div className="modal-section">
              <h4>Vipengele Muhimu</h4>
              <ul>
                {serviceDetails[activeModal].features.map((f, i) => (
                  <li key={i}>{f}</li>
                ))}
              </ul>
            </div>

            <div className="modal-cta-box">
              <Link to="/login">
                <button className="btn-primary-lg">Jiunge / Register Now</button>
              </Link>
            </div>

            <div className="modal-section steps-section">
              <h4>Jinsi ya Kujiunga na Kutumia</h4>
              <ol>
                {serviceDetails[activeModal].steps.map((s, i) => (
                  <li key={i}>{s}</li>
                ))}
              </ol>
            </div>
          </div>
        </div>
      )}

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

      <footer className="footer">
        <div className="footer-inner">
          <div className="footer-grid">
            <div className="footer-brand">
              <h3>Afrikoba Global</h3>
              <p>Mfumo Salama wa Kidijitali wa Akiba, VICOBA, Mzunguko na Uwekezaji Barani Afrika.</p>
            </div>
            <div className="footer-links">
              <h4>Huduma</h4>
              <a href="#huduma">VICOBA</a>
              <a href="#huduma">ROSCA / Upatu</a>
              <a href="#huduma">P2P Investment</a>
              <a href="#huduma">Digital Wallet</a>
            </div>
            <div className="footer-links">
              <h4>Kampuni</h4>
              <Link to="/login">Kuhusu Sisi</Link>
              <a href="mailto:support@afrikoba.com">Mawasiliano</a>
              <Link to="/login">Sheria na Masharti</Link>
            </div>
          </div>
          <div className="footer-bottom">
            <p>&copy; {new Date().getFullYear()} Afrikoba Global. All rights reserved. Bank-Grade Security & PDPC Compliant.</p>
          </div>
        </div>
      </footer>
    </>
  );
}