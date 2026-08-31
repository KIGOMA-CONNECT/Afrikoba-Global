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

  // Yield calculator formula: (Principal * 0.13) / 12
  const monthlyYield = Math.round((yieldAmount * 0.13) / 12);
  const totalYield12Months = monthlyYield * 12;

  return (
    <div className="landing-page font-sans bg-slate-50 text-slate-900 antialiased selection:bg-emerald-500 selection:text-white">
      {/* Conditional Smart Mobile Banner */}
      {showSmartBanner && isMobile && (
        <div className="fixed top-0 left-0 right-0 z-50 bg-emerald-900 text-white px-4 py-2 text-xs font-semibold flex items-center justify-between shadow-md">
          <span>📱 Pakua App ya Afrikoba kupata usimamizi rahisi wa VICOBA.</span>
          <div className="flex items-center gap-2">
            <a href="https://play.google.com/store/apps/details?id=com.afrikoba" target="_blank" rel="noopener noreferrer" className="bg-amber-400 text-black px-2.5 py-1 rounded font-bold uppercase text-[10px]">Install</a>
            <button className="text-white text-lg font-bold px-1" onClick={() => setShowSmartBanner(false)}>&times;</button>
          </div>
        </div>
      )}

      {/* 1. HEADER / NAVIGATION BAR */}
      <header className={`fixed top-0 left-0 right-0 z-40 flex items-center justify-between px-8 py-4 bg-slate-900 text-white shadow-md transition-all ${showSmartBanner && isMobile ? 'mt-8' : ''}`}>
        <div className="flex items-center space-x-2">
          <span className="text-xl font-bold">🛡️ Afrikoba Global</span>
        </div>
        
        <nav className="hidden md:flex items-center space-x-6 text-sm font-medium">
          <a href="#huduma" className="hover:text-emerald-400 transition-colors">Huduma Zetu</a>
          <a href="#yield" className="hover:text-emerald-400 transition-colors">Afrikoba Yield</a>
          <a href="#jinsi" className="hover:text-emerald-400 transition-colors">Jinsi Inavyofanya Kazi</a>
          <a href="#uwekezaji" className="hover:text-emerald-400 transition-colors">Uwekezaji (P2P)</a>
          <a href="#kuhusu" className="hover:text-emerald-400 transition-colors">Kuhusu Sisi</a>
        </nav>

        <div className="flex items-center space-x-4">
          <select className="text-xs px-2.5 py-1.5 border border-slate-700 bg-slate-800 text-white rounded cursor-pointer" value={lang} onChange={(e) => setLang(e.target.value)}>
            <option value="sw">SW</option>
            <option value="en">EN</option>
          </select>
          <Link to="/login" className="hidden sm:inline-block px-4 py-2 text-sm font-medium hover:text-emerald-400">Ingia</Link>
          <Link to="/login" className="hidden sm:inline-block px-4 py-2 text-sm font-medium bg-emerald-500 hover:bg-emerald-600 rounded-lg text-white">Jisajili</Link>

          <button className="md:hidden flex flex-col justify-center items-center w-8 h-8 rounded-lg bg-slate-800 text-white focus:outline-none" onClick={() => setMenuOpen(!menuOpen)}>
            <span className={`block w-5 h-0.5 bg-white rounded transition-all duration-300 ${menuOpen ? 'rotate-45 translate-y-1' : '-translate-y-1'}`} />
            <span className={`block w-5 h-0.5 bg-white rounded transition-all duration-300 my-1 ${menuOpen ? 'opacity-0' : 'opacity-100'}`} />
            <span className={`block w-5 h-0.5 bg-white rounded transition-all duration-300 ${menuOpen ? '-rotate-45 -translate-y-1' : 'translate-y-1'}`} />
          </button>
        </div>
      </header>

      {/* Mobile Drawer Menu */}
      {menuOpen && (
        <div className="md:hidden fixed inset-x-0 top-[65px] bg-slate-900 text-white border-b border-slate-800 shadow-xl p-6 flex flex-col gap-4 z-30 animate-fadeIn">
          <a href="#huduma" className="text-base font-semibold text-slate-200 pb-2 border-b border-slate-800" onClick={() => setMenuOpen(false)}>Huduma Zetu</a>
          <a href="#yield" className="text-base font-semibold text-slate-200 pb-2 border-b border-slate-800" onClick={() => setMenuOpen(false)}>Afrikoba Yield</a>
          <a href="#jinsi" className="text-base font-semibold text-slate-200 pb-2 border-b border-slate-800" onClick={() => setMenuOpen(false)}>Jinsi Inavyofanya Kazi</a>
          <a href="#uwekezaji" className="text-base font-semibold text-slate-200 pb-2 border-b border-slate-800" onClick={() => setMenuOpen(false)}>Uwekezaji (P2P)</a>
          <a href="#kuhusu" className="text-base font-semibold text-slate-200 pb-2 border-b border-slate-800" onClick={() => setMenuOpen(false)}>Kuhusu Sisi</a>
          <div className="flex gap-3 pt-2">
            <Link to="/login" className="flex-1 py-3 text-center border border-slate-700 rounded-xl font-semibold text-white" onClick={() => setMenuOpen(false)}>Ingia</Link>
            <Link to="/login" className="flex-1 py-3 text-center bg-emerald-500 rounded-xl font-bold text-white shadow-sm" onClick={() => setMenuOpen(false)}>Jisajili</Link>
          </div>
        </div>
      )}

      {/* 2. HERO SECTION */}
      <section className="pt-32 pb-16">
        <div className="max-w-7xl mx-auto px-6 py-16 grid grid-cols-1 md:grid-cols-2 gap-12 items-center">
          {/* Left Side: Copywriting */}
          <div className="space-y-6">
            <span className="inline-block px-3 py-1 bg-emerald-100 text-emerald-800 text-xs font-semibold rounded-full">✨ Mfuko wa Kitaifa wa Kidijitali</span>
            <h1 className="text-4xl font-extrabold text-slate-900 leading-tight">
              Mfumo Salama wa Kidijitali wa Akiba, VICOBA, Mzunguko na Uwekezaji Barani Afrika.
            </h1>
            <p className="text-slate-600 text-base">
              Simamia VICOBA kwa uwazi wa 100%, shiriki kwenye mizunguko ya Upatu isiyo na utapeli, na wekeza kwenye Mfuko wa Faida (13% Annual Yield) au miradi ya uzalishaji.
            </p>
            
            {/* Action Buttons with Spacing */}
            <div className="flex flex-wrap gap-4 pt-2">
              <a href="https://play.google.com/store/apps/details?id=com.afrikoba" target="_blank" rel="noopener noreferrer" className="px-6 py-3 bg-emerald-600 text-white font-medium rounded-lg hover:bg-emerald-700 shadow-sm transition-all">▶ Pakua App Sasa</a>
              <Link to="/login" className="px-6 py-3 border border-slate-300 text-slate-700 font-medium rounded-lg hover:bg-slate-50 transition-all">Fungua Akaunti ya Web</Link>
            </div>

            {/* App Store Badges */}
            <div className="flex items-center space-x-4 pt-4">
              <a href="https://play.google.com/store/apps/details?id=com.afrikoba" target="_blank" rel="noopener noreferrer" className="px-4 py-2 bg-slate-900 text-white text-xs rounded-md flex items-center space-x-2 hover:bg-slate-800 transition-all">
                <span>🤖</span> <span>Google Play</span>
              </a>
              <a href="https://apps.apple.com/app/afrikoba/id123456789" target="_blank" rel="noopener noreferrer" className="px-4 py-2 bg-slate-900 text-white text-xs rounded-md flex items-center space-x-2 hover:bg-slate-800 transition-all">
                <span>🍏</span> <span>App Store</span>
              </a>
            </div>
          </div>

          {/* Right Side: Dynamic Balance Card */}
          <div className="bg-white p-6 rounded-2xl shadow-xl border border-slate-100 space-y-4">
            <div className="flex justify-between items-center">
              <span className="text-sm font-medium text-slate-500">Akiba ya Mwezi</span>
              <span className="text-xs font-bold text-emerald-600 bg-emerald-50 px-2 py-1 rounded">+14.2% 📈</span>
            </div>
            <div className="flex items-center space-x-3">
              <span className="text-3xl font-extrabold text-slate-900">{showBalance ? 'TZS 2,400,000' : 'TZS ***,***'}</span>
              <button className="text-slate-400 hover:text-slate-600 text-lg bg-slate-100 p-2 rounded-lg" onClick={() => setShowBalance(!showBalance)} title="Ficha / Onyesha Salio">
                {showBalance ? '👁️' : '🙈'}
              </button>
            </div>
            <hr className="border-slate-100" />
            <div className="flex justify-between items-center text-xs text-slate-600">
              <span className="flex items-center space-x-1">🟢 <span>Mfuko wa Faida: Hai</span></span>
              <span className="font-bold text-emerald-600">13% p.a.</span>
            </div>
          </div>
        </div>
      </section>

      {/* 3. METRICS BAR */}
      <section className="bg-slate-50 py-10 border-y border-slate-200">
        <div className="max-w-7xl mx-auto px-6 grid grid-cols-1 md:grid-cols-3 gap-8 text-center">
          <div className="rounded-2xl border border-slate-100 bg-white p-6 shadow-sm">
            <p className="text-2xl font-bold text-slate-900">TZS 850M+</p>
            <p className="text-xs text-slate-500 font-bold uppercase tracking-wider mt-1">Dedicated Capital</p>
          </div>
          <div className="rounded-2xl border border-slate-100 bg-white p-6 shadow-sm">
            <p className="text-2xl font-bold text-slate-900">2,500+</p>
            <p className="text-xs text-slate-500 font-bold uppercase tracking-wider mt-1">Vikundi Vilivyosajiliwa</p>
          </div>
          <div className="rounded-2xl border border-slate-100 bg-white p-6 shadow-sm">
            <p className="text-2xl font-bold text-slate-900">15,000+</p>
            <p className="text-xs text-slate-500 font-bold uppercase tracking-wider mt-1">Wawekezaji Hai</p>
          </div>
        </div>
      </section>

      {/* 4. INTERACTIVE TABS SHOWCASE */}
      <section className="max-w-7xl mx-auto px-6 py-16" id="huduma">
        <div className="flex flex-wrap gap-3 justify-center mb-8">
          <button className={`px-5 py-2.5 rounded-lg text-sm font-medium transition-all ${activeTab === 'vicoba' ? 'bg-emerald-600 text-white shadow-sm' : 'bg-slate-100 text-slate-700 hover:bg-slate-200'}`} onClick={() => setActiveTab('vicoba')}>👥 VICOBA Digital</button>
          <button className={`px-5 py-2.5 rounded-lg text-sm font-medium transition-all ${activeTab === 'rosca' ? 'bg-emerald-600 text-white shadow-sm' : 'bg-slate-100 text-slate-700 hover:bg-slate-200'}`} onClick={() => setActiveTab('rosca')}>🔄 ROSCA / Upatu</button>
          <button className={`px-5 py-2.5 rounded-lg text-sm font-medium transition-all ${activeTab === 'yield' ? 'bg-emerald-600 text-white shadow-sm' : 'bg-slate-100 text-slate-700 hover:bg-slate-200'}`} onClick={() => setActiveTab('yield')} id="yield">🌱 Afrikoba Yield</button>
          <button className={`px-5 py-2.5 rounded-lg text-sm font-medium transition-all ${activeTab === 'p2p' ? 'bg-emerald-600 text-white shadow-sm' : 'bg-slate-100 text-slate-700 hover:bg-slate-200'}`} onClick={() => setActiveTab('p2p')} id="uwekezaji">💳 P2P Crowdfunding</button>
        </div>

        <div className="bg-slate-900 text-white p-8 md:p-12 rounded-2xl max-w-3xl mx-auto space-y-6 shadow-2xl">
          {activeTab === 'yield' && (
            <>
              <h3 className="text-2xl font-bold text-emerald-400">Afrikoba Yield (13% Annual Return)</h3>
              <p className="text-slate-300 text-sm leading-relaxed">Funga mtaji wako kwa hiari upate faida ya 13% kwa mwaka inayolipwa kila mwezi moja kwa moja kwenye Wallet yako.</p>
              
              <div className="space-y-3 bg-slate-800/80 p-5 rounded-xl border border-slate-700">
                <div className="flex justify-between text-xs text-slate-300 font-semibold">
                  <span>Weka Kiasi cha Mtaji:</span>
                  <span className="text-emerald-400 text-sm font-bold">TZS {yieldAmount.toLocaleString()}</span>
                </div>
                <input 
                  type="range" 
                  className="w-full accent-emerald-500 cursor-pointer h-2 bg-slate-700 rounded-lg" 
                  min="100000" 
                  max="10000000" 
                  step="100000" 
                  value={yieldAmount} 
                  onChange={(e) => setYieldAmount(Number(e.target.value))} 
                />
              </div>

              <div className="p-4 bg-slate-800 rounded-xl text-xs space-y-2 border border-slate-700">
                <p className="text-emerald-400 font-semibold">💡 "Ukiweka TZS {yieldAmount.toLocaleString()} ➔ Utapokea TZS {monthlyYield.toLocaleString()} kila mwezi (13% p.a)."</p>
                <div className="flex justify-between pt-1 border-t border-slate-700 text-slate-300 font-medium">
                  <span>• Faida ya Kila Mwezi: <strong className="text-white">TZS {monthlyYield.toLocaleString()}</strong></span>
                  <span>• Jumla ya Faida (Mwaka): <strong className="text-white">TZS {totalYield12Months.toLocaleString()}</strong></span>
                </div>
              </div>
            </>
          )}

          {activeTab === 'vicoba' && (
            <>
              <h3 className="text-2xl font-bold text-emerald-400">VICOBA Automation & Multi-Sig Approvals</h3>
              <p className="text-slate-300 text-sm leading-relaxed">Kila ombi la mkopo linahitaji idhini ya pande mbili (Mwenyekiti na Katibu) ili kuzuia matumizi mabaya ya fedha za kikundi.</p>
              <div className="p-4 bg-slate-800 rounded-xl text-xs space-y-2 border border-slate-700">
                <div className="flex justify-between"><span>Mwenyekiti:</span> <span className="text-emerald-400 font-bold">Approved ✅</span></div>
                <div className="flex justify-between"><span>Katibu:</span> <span className="text-amber-400 font-bold">Pending ⏳</span></div>
              </div>
            </>
          )}

          {activeTab === 'rosca' && (
            <>
              <h3 className="text-2xl font-bold text-emerald-400">ROSCA / Upatu Engine (Code as Law)</h3>
              <p className="text-slate-300 text-sm leading-relaxed">Mzunguko wa fedha unaopangwa kiotomatiki na kompyuta. Hakuna haja ya kukusanya pesa mkononi; mfumo unakata na kugawanya kwa wakati.</p>
              <ul className="list-disc pl-5 text-xs text-slate-300 space-y-1">
                <li>Mzunguko wa #3 kati ya 10</li>
                <li>Mwanachama Anayepokea Mwezi Huu: <strong className="text-white">Aisha Juma</strong></li>
              </ul>
            </>
          )}

          {activeTab === 'p2p' && (
            <>
              <h3 className="text-2xl font-bold text-emerald-400">P2P Crowdfunding & Split Payment</h3>
              <p className="text-slate-300 text-sm leading-relaxed">Wekeza kwenye kilimo cha biashara na logistics. Faida inarudishwa moja kwa moja kupitia Automated Split Payment Engine.</p>
              <div className="p-4 bg-slate-800 rounded-xl text-xs space-y-2 border border-slate-700">
                <div className="flex justify-between"><span>Kilimo cha Umwagiliaji Morogoro</span> <span className="text-emerald-400 font-bold">ROI: 18% Pa.a</span></div>
                <div className="w-full bg-slate-700 h-2 rounded-full overflow-hidden"><div className="bg-emerald-500 h-full w-3/4" /></div>
                <div className="flex justify-between text-slate-400"><span>Mtaji: TZS 15M / 20M</span> <span className="text-sky-400">Risk: Low</span></div>
              </div>
            </>
          )}
        </div>
      </section>

      {/* HOW IT WORKS */}
      <section className="py-20 px-6 bg-white" id="jinsi">
        <div className="max-w-5xl mx-auto">
          <div className="text-center mb-12">
            <h2 className="text-3xl font-extrabold text-slate-900 mb-2">Jinsi Inavyofanya Kazi</h2>
            <p className="text-sm text-slate-600">Hatua tatu rahisi kuanza safari yako ya kifedha.</p>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            <div className="rounded-2xl border border-slate-100 bg-slate-50 p-8 text-center shadow-sm">
              <div className="w-10 h-10 bg-emerald-600 text-white font-extrabold rounded-full flex items-center justify-center mx-auto mb-4 text-sm">1</div>
              <h3 className="text-base font-extrabold text-slate-900 mb-2">Pakua au Jisajili</h3>
              <p className="text-xs text-slate-600 leading-relaxed">Pakua App au fungua akaunti ya mtandaoni kwa namba ya simu au NIDA.</p>
            </div>
            <div className="rounded-2xl border border-slate-100 bg-slate-50 p-8 text-center shadow-sm">
              <div className="w-10 h-10 bg-emerald-600 text-white font-extrabold rounded-full flex items-center justify-center mx-auto mb-4 text-sm">2</div>
              <h3 className="text-base font-extrabold text-slate-900 mb-2">Chagua Huduma</h3>
              <p className="text-xs text-slate-600 leading-relaxed">Jiunge na kikundi cha VICOBA, anzisha Upatu, au wekeza kwenye Afrikoba Yield.</p>
            </div>
            <div className="rounded-2xl border border-slate-100 bg-slate-50 p-8 text-center shadow-sm">
              <div className="w-10 h-10 bg-emerald-600 text-white font-extrabold rounded-full flex items-center justify-center mx-auto mb-4 text-sm">3</div>
              <h3 className="text-base font-extrabold text-slate-900 mb-2">Simamia na Ukuze</h3>
              <p className="text-xs text-slate-600 leading-relaxed">Pokea gawio la faida, fuatilia miamala kwa urahisi, na ulinde akiba yako.</p>
            </div>
          </div>
        </div>
      </section>

      {/* FOOTER */}
      <footer className="bg-slate-900 text-white py-16 px-6" id="kuhusu">
        <div className="max-w-7xl mx-auto grid grid-cols-1 md:grid-cols-3 gap-12 mb-12">
          <div>
            <h3 className="text-lg font-extrabold mb-3">Afrikoba Global</h3>
            <p className="text-xs text-slate-400 leading-relaxed max-w-xs">Mfumo Salama wa Kidijitali wa Akiba, VICOBA, Mzunguko na Uwekezaji.</p>
          </div>
          <div className="flex flex-col gap-2.5">
            <h4 className="text-sm font-bold text-emerald-400 mb-1">Huduma</h4>
            <a href="#huduma" className="text-xs text-slate-400 hover:text-white transition-colors">VICOBA Automation</a>
            <a href="#huduma" className="text-xs text-slate-400 hover:text-white transition-colors">ROSCA / Upatu</a>
            <a href="#yield" className="text-xs text-slate-400 hover:text-white transition-colors">Afrikoba Yield</a>
            <a href="#uwekezaji" className="text-xs text-slate-400 hover:text-white transition-colors">P2P Hub</a>
          </div>
          <div className="flex flex-col gap-2.5">
            <h4 className="text-sm font-bold text-emerald-400 mb-1">Mawasiliano</h4>
            <a href="mailto:support@afrikoba.com" className="text-xs text-slate-400 hover:text-white transition-colors">support@afrikoba.com</a>
            <a href="tel:+255700000000" className="text-xs text-slate-400 hover:text-white transition-colors">+255 700 000 000</a>
            <Link to="/login" className="text-xs text-slate-400 hover:text-white transition-colors">Wasiliana Nasi</Link>
          </div>
        </div>
        <div className="max-w-7xl mx-auto pt-6 border-t border-slate-800 text-center text-xs text-slate-500">
          <p>&copy; {new Date().getFullYear()} Afrikoba Global. All rights reserved. Bank-Grade Security & PDPC Compliant.</p>
        </div>
      </footer>
    </div>
  );
}
