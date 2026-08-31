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
      {/* Smart Mobile Banner (< 768px) */}
      {showSmartBanner && isMobile && (
        <div className="fixed top-0 left-0 right-0 z-50 bg-emerald-900 text-white px-4 py-2 text-xs font-semibold flex items-center justify-between shadow-md">
          <span>📱 Pakua App ya Afrikoba kupata usimamizi rahisi wa VICOBA.</span>
          <div className="flex items-center gap-2">
            <a href="https://play.google.com/store/apps/details?id=com.afrikoba" target="_blank" rel="noopener noreferrer" className="bg-amber-400 text-black px-2.5 py-1 rounded font-bold uppercase text-[10px]">Install</a>
            <button className="text-white text-lg font-bold px-1" onClick={() => setShowSmartBanner(false)}>&times;</button>
          </div>
        </div>
      )}

      {/* 1. Header / Navigation Bar (Sticky & Transparent) */}
      <nav className={`fixed top-0 left-0 right-0 z-40 bg-white/90 backdrop-blur-md border-b border-slate-200 px-6 py-4 flex items-center justify-between transition-all ${showSmartBanner && isMobile ? 'mt-8' : ''}`}>
        <div className="flex items-center gap-2.5 font-extrabold text-lg text-emerald-900">
          <div className="p-1.5 bg-emerald-100 rounded-lg text-emerald-700">🛡️</div>
          <span>Afrikoba Global</span>
        </div>

        {/* Desktop Navigation Links */}
        <ul className="hidden md:flex items-center gap-8 list-none m-0 p-0 text-sm font-medium text-slate-600">
          <li><a href="#huduma" className="hover:text-emerald-700 transition-colors">Huduma Zetu</a></li>
          <li><a href="#yield" className="hover:text-emerald-700 transition-colors">Afrikoba Yield</a></li>
          <li><a href="#jinsi" className="hover:text-emerald-700 transition-colors">Jinsi Inavyofanya Kazi</a></li>
          <li><a href="#uwekezaji" className="hover:text-emerald-700 transition-colors">Uwekezaji (P2P)</a></li>
          <li><a href="#kuhusu" className="hover:text-emerald-700 transition-colors">Kuhusu Sisi</a></li>
        </ul>

        <div className="flex items-center gap-4">
          <select className="px-2.5 py-1 rounded-md border border-slate-200 bg-white text-xs font-semibold text-slate-700 cursor-pointer" value={lang} onChange={(e) => setLang(e.target.value)}>
            <option value="sw">SW</option>
            <option value="en">EN</option>
          </select>
          <Link to="/login" className="hidden sm:inline-block px-4 py-2 border border-slate-300 rounded-lg text-xs font-semibold text-slate-700 hover:border-emerald-600 hover:text-emerald-600 transition-all">Ingia</Link>
          <Link to="/login" className="hidden sm:inline-block px-4 py-2 bg-emerald-600 rounded-lg text-xs font-bold text-white shadow-sm hover:bg-emerald-700 transition-all">Jisajili</Link>

          {/* Mobile Hamburger Button (< 768px) */}
          <button className="md:hidden flex flex-col justify-center items-center w-8 h-8 rounded-lg bg-slate-100 text-slate-700 focus:outline-none" onClick={() => setMenuOpen(!menuOpen)}>
            <span className={`block w-5 h-0.5 bg-slate-800 rounded transition-all duration-300 ${menuOpen ? 'rotate-45 translate-y-1' : '-translate-y-1'}`} />
            <span className={`block w-5 h-0.5 bg-slate-800 rounded transition-all duration-300 my-1 ${menuOpen ? 'opacity-0' : 'opacity-100'}`} />
            <span className={`block w-5 h-0.5 bg-slate-800 rounded transition-all duration-300 ${menuOpen ? '-rotate-45 -translate-y-1' : 'translate-y-1'}`} />
          </button>
        </div>
      </nav>

      {/* Mobile Drawer Menu */}
      {menuOpen && (
        <div className="md:hidden fixed inset-x-0 top-[73px] bg-white border-b border-slate-200 shadow-xl p-6 flex flex-col gap-4 z-30 animate-fadeIn">
          <a href="#huduma" className="text-base font-semibold text-slate-800 pb-2 border-b border-slate-100" onClick={() => setMenuOpen(false)}>Huduma Zetu</a>
          <a href="#yield" className="text-base font-semibold text-slate-800 pb-2 border-b border-slate-100" onClick={() => setMenuOpen(false)}>Afrikoba Yield</a>
          <a href="#jinsi" className="text-base font-semibold text-slate-800 pb-2 border-b border-slate-100" onClick={() => setMenuOpen(false)}>Jinsi Inavyofanya Kazi</a>
          <a href="#uwekezaji" className="text-base font-semibold text-slate-800 pb-2 border-b border-slate-100" onClick={() => setMenuOpen(false)}>Uwekezaji (P2P)</a>
          <a href="#kuhusu" className="text-base font-semibold text-slate-800 pb-2 border-b border-slate-100" onClick={() => setMenuOpen(false)}>Kuhusu Sisi</a>
          <div className="flex gap-3 pt-2">
            <Link to="/login" className="flex-1 py-3 text-center border border-slate-300 rounded-xl font-semibold text-slate-700" onClick={() => setMenuOpen(false)}>Ingia</Link>
            <Link to="/login" className="flex-1 py-3 text-center bg-emerald-600 rounded-xl font-bold text-white shadow-sm" onClick={() => setMenuOpen(false)}>Jisajili</Link>
          </div>
        </div>
      )}

      {/* B. HERO SECTION (1-Column on Mobile, 2-Column on Desktop >= 1024px) */}
      <section className="pt-36 pb-20 px-6 bg-gradient-to-br from-emerald-50 via-white to-emerald-50/50 flex justify-center">
        <div className="max-w-7xl w-full grid grid-cols-1 lg:grid-cols-2 gap-12 items-center">
          <div className="flex flex-col items-start">
            <span className="inline-block px-3.5 py-1.5 bg-emerald-100 text-emerald-800 text-xs font-bold rounded-full mb-6">✨ Mfuko wa Kitaifa wa Kidijitali</span>
            <h1 className="text-4xl lg:text-5xl font-extrabold tracking-tight text-emerald-950 leading-tight mb-6">
              Mfumo Salama wa Kidijitali wa Akiba, VICOBA, Mzunguko na <span className="text-amber-500">Uwekezaji</span> Barani Afrika.
            </h1>
            <p className="text-base text-slate-600 leading-relaxed mb-8 max-w-xl">
              Simamia VICOBA kwa uwazi wa 100%, shiriki kwenye mizunguko ya Upatu isiyo na utapeli, na wekeza kwenye Mfuko wa Faida (13% Annual Yield) au miradi ya uzalishaji.
            </p>
            
            {/* CTA Buttons with gap-4 */}
            <div className="flex flex-wrap items-center gap-4 mb-8">
              <a href="https://play.google.com/store/apps/details?id=com.afrikoba" target="_blank" rel="noopener noreferrer">
                <button className="px-6 py-3.5 rounded-xl bg-emerald-600 text-white font-bold text-sm shadow-md hover:bg-emerald-700 transition-all flex items-center gap-2">
                  <span>▶</span> Pakua App Sasa
                </button>
              </a>
              <Link to="/login">
                <button className="px-6 py-3.5 rounded-xl border border-slate-300 bg-white text-slate-700 font-bold text-sm hover:border-emerald-600 hover:text-emerald-600 transition-all">
                  Fungua Akaunti ya Web
                </button>
              </Link>
            </div>

            {/* App Store & Play Store Badges */}
            <div className="flex flex-wrap gap-3">
              <a href="https://play.google.com/store/apps/details?id=com.afrikoba" target="_blank" rel="noopener noreferrer" className="flex items-center gap-2.5 px-4 py-2 bg-slate-900 text-white rounded-xl border border-slate-800 hover:bg-slate-800 transition-all">
                <span className="text-lg">🤖</span>
                <div className="flex flex-col text-left leading-tight">
                  <span className="text-[9px] uppercase opacity-70">Get it on</span>
                  <span className="text-xs font-bold">Google Play</span>
                </div>
              </a>
              <a href="https://apps.apple.com/app/afrikoba/id123456789" target="_blank" rel="noopener noreferrer" className="flex items-center gap-2.5 px-4 py-2 bg-slate-900 text-white rounded-xl border border-slate-800 hover:bg-slate-800 transition-all">
                <span className="text-lg">🍏</span>
                <div className="flex flex-col text-left leading-tight">
                  <span className="text-[9px] uppercase opacity-70">Download on</span>
                  <span className="text-xs font-bold">App Store</span>
                </div>
              </a>
            </div>
          </div>

          {/* Visual Mockup Card */}
          <div className="flex justify-center">
            <div className="rounded-2xl border border-slate-100 bg-white/80 backdrop-blur-xl p-8 shadow-xl w-full max-w-sm hover:shadow-2xl transition-all">
              <div className="flex justify-between items-center text-xs font-semibold text-slate-500 mb-3">
                <span>Akiba ya Mwezi</span>
                <span className="bg-emerald-100 text-emerald-800 px-2.5 py-0.5 rounded-full text-[11px] font-bold">+14.2% 📈</span>
              </div>
              <div className="text-2xl font-black text-emerald-950 mb-4 flex items-center justify-between">
                <span>{showBalance ? 'TZS 2,400,000' : 'TZS ***,***'}</span>
                <button className="text-sm opacity-70 hover:opacity-100 bg-slate-100 p-2 rounded-lg" onClick={() => setShowBalance(!showBalance)} title="Ficha / Onyesha Salio">
                  {showBalance ? '👁️' : '🙈'}
                </button>
              </div>
              <div className="flex items-end gap-2 h-16 mb-4 pb-2 border-b border-slate-100">
                {[35, 55, 45, 75, 60, 90, 80].map((h, i) => (
                  <div key={i} className={`flex-1 rounded-t ${i % 2 === 0 ? 'bg-emerald-200' : 'bg-emerald-600'}`} style={{ height: `${h}%` }} />
                ))}
              </div>
              <div className="flex justify-between items-center text-xs font-bold">
                <span className="text-emerald-700">🟢 Mfuko wa Faida: Hai</span>
                <span className="text-amber-600 font-extrabold">13% Pa.a</span>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* C. LIVE TRUST & SECURITY BAR */}
      <section className="bg-white border-y border-slate-200 py-10 px-6">
        <div className="max-w-7xl mx-auto flex flex-col items-center gap-8">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-8 w-full text-center">
            <div className="rounded-2xl border border-slate-100 bg-slate-50/50 p-6 shadow-sm hover:shadow-md transition-all">
              <h3 className="text-3xl font-black text-emerald-700 mb-1">TZS 850M+</h3>
              <p className="text-xs font-bold uppercase text-slate-500 tracking-wider">Dedicated Capital</p>
            </div>
            <div className="rounded-2xl border border-slate-100 bg-slate-50/50 p-6 shadow-sm hover:shadow-md transition-all">
              <h3 className="text-3xl font-black text-emerald-700 mb-1">2,500+</h3>
              <p className="text-xs font-bold uppercase text-slate-500 tracking-wider">Vikundi Vilivyosajiliwa</p>
            </div>
            <div className="rounded-2xl border border-slate-100 bg-slate-50/50 p-6 shadow-sm hover:shadow-md transition-all">
              <h3 className="text-3xl font-black text-emerald-700 mb-1">15,000+</h3>
              <p className="text-xs font-bold uppercase text-slate-500 tracking-wider">Wawekezaji Hai</p>
            </div>
          </div>
          <div className="flex flex-wrap gap-3 justify-center">
            <div className="bg-slate-50 border border-slate-200 px-4 py-2 rounded-xl text-xs font-bold text-slate-600 shadow-xs">🏛️ BOT-Regulated Gateway</div>
            <div className="bg-slate-50 border border-slate-200 px-4 py-2 rounded-xl text-xs font-bold text-slate-600 shadow-xs">🔒 256-Bit SSL Encrypted</div>
            <div className="bg-slate-50 border border-slate-200 px-4 py-2 rounded-xl text-xs font-bold text-slate-600 shadow-xs">🛡️ PDPC Data Protection Compliant</div>
            <div className="bg-slate-50 border border-slate-200 px-4 py-2 rounded-xl text-xs font-bold text-slate-600 shadow-xs">✅ NIDA Verified System</div>
          </div>
        </div>
      </section>

      {/* D. INTERACTIVE PRODUCT SHOWCASE (Tab Bedding - Client State) */}
      <section className="py-20 px-6 bg-slate-100" id="huduma">
        <div className="max-w-5xl mx-auto">
          <div className="text-center mb-12">
            <h2 className="text-3xl font-extrabold text-emerald-950 mb-3">Interactive Product Showcase</h2>
            <p className="text-sm text-slate-600">Bofya kichupo chochote hapa chini kuona teknolojia na mifumo yetu ikifanya kazi papo hapo bila ku-refresh.</p>
          </div>
          
          <div className="flex gap-3 justify-center mb-8 flex-wrap">
            <button className={`px-5 py-3 rounded-xl border text-sm font-bold transition-all shadow-xs ${activeTab === 'vicoba' ? 'bg-emerald-600 text-white border-emerald-600 shadow-md' : 'bg-white text-slate-600 border-slate-200 hover:border-emerald-600'}`} onClick={() => setActiveTab('vicoba')}>👥 VICOBA Digital</button>
            <button className={`px-5 py-3 rounded-xl border text-sm font-bold transition-all shadow-xs ${activeTab === 'rosca' ? 'active bg-emerald-600 text-white border-emerald-600 shadow-md' : 'bg-white text-slate-600 border-slate-200 hover:border-emerald-600'}`} onClick={() => setActiveTab('rosca')}>🔄 ROSCA / Upatu</button>
            <button className={`px-5 py-3 rounded-xl border text-sm font-bold transition-all shadow-xs ${activeTab === 'yield' ? 'active bg-emerald-600 text-white border-emerald-600 shadow-md' : 'bg-white text-slate-600 border-slate-200 hover:border-emerald-600'}`} onClick={() => setActiveTab('yield')} id="yield">🌱 Afrikoba Yield</button>
            <button className={`px-5 py-3 rounded-xl border text-sm font-bold transition-all shadow-xs ${activeTab === 'p2p' ? 'active bg-emerald-600 text-white border-emerald-600 shadow-md' : 'bg-white text-slate-600 border-slate-200 hover:border-emerald-600'}`} onClick={() => setActiveTab('p2p')} id="uwekezaji">💳 P2P Crowdfunding</button>
          </div>

          <div className="rounded-2xl border border-slate-200 bg-white p-8 md:p-12 shadow-md">
            {activeTab === 'vicoba' && (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-8 items-center animate-fadeIn">
                <div>
                  <h3 className="text-2xl font-extrabold text-emerald-950 mb-4">VICOBA Automation & Multi-Sig Approvals</h3>
                  <p className="text-sm text-slate-600 leading-relaxed mb-6">Kila ombi la mkopo linahitaji idhini ya pande mbili (Mwenyekiti na Katibu) ili kuzuia matumizi mabaya ya fedha za kikundi.</p>
                  <div className="rounded-xl border border-slate-200 bg-slate-50 p-4 flex flex-col gap-3 text-xs font-semibold text-slate-700">
                    <div className="flex justify-between"><span>Mwenyekiti:</span> <span className="text-emerald-700 font-bold">Approved ✅</span></div>
                    <div className="flex justify-between"><span>Katibu:</span> <span className="text-amber-600 font-bold">Pending ⏳</span></div>
                  </div>
                </div>
                <div className="bg-emerald-50 border border-emerald-100 p-6 rounded-2xl">
                  <strong className="text-sm text-emerald-950 block mb-2 font-bold">Ombi la Mkopo #402</strong>
                  <p className="text-xs text-slate-600 mb-1">Kiasi: TZS 1,500,000</p>
                  <p className="text-xs text-slate-600">Hali: Inasubiri Saini ya Katibu</p>
                </div>
              </div>
            )}

            {activeTab === 'rosca' && (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-8 items-center animate-fadeIn">
                <div>
                  <h3 className="text-2xl font-extrabold text-emerald-950 mb-4">ROSCA / Upatu Engine (Code as Law)</h3>
                  <p className="text-sm text-slate-600 leading-relaxed mb-6">Mzunguko wa fedha unaopangwa kiotomatiki na kompyuta. Hakuna haja ya kukusanya pesa mkononi; mfumo unakata na kugawanya kwa wakati.</p>
                  <ul className="list-none p-0 flex flex-col gap-2 text-xs font-semibold text-slate-700">
                    <li>✓ Mzunguko wa #3 kati ya 10</li>
                    <li>✓ Mwanachama Anayepokea Mwezi Huu: <strong>Aisha Juma</strong></li>
                  </ul>
                </div>
                <div className="flex flex-col gap-2.5">
                  <div className="p-3 bg-emerald-50 border border-emerald-200 rounded-xl text-xs font-bold text-emerald-800">Mwezi 1 ✓</div>
                  <div className="p-3 bg-emerald-50 border border-emerald-200 rounded-xl text-xs font-bold text-emerald-800">Mwezi 2 ✓</div>
                  <div className="p-3 bg-amber-50 border border-amber-300 rounded-xl text-xs font-bold text-amber-800">Mwezi 3 (Sasa) 🟢</div>
                  <div className="p-3 bg-slate-50 border border-slate-200 rounded-xl text-xs font-bold text-slate-500">Mwezi 4 ⏳</div>
                </div>
              </div>
            )}

            {activeTab === 'yield' && (
              <div className="max-w-xl mx-auto text-center animate-fadeIn">
                <h3 className="text-2xl font-extrabold text-emerald-950 mb-3">Afrikoba Yield (13% Annual Return)</h3>
                <p className="text-sm text-slate-600 leading-relaxed mb-6">Funga mtaji wako kwa hiari upate faida ya 13% kwa mwaka inayolipwa kila mwezi moja kwa moja kwenye Wallet yako.</p>
                
                {/* Isolated Yield Calculator Card */}
                <div className="rounded-2xl border border-slate-200 bg-slate-50 p-6 shadow-xs flex flex-col gap-4 text-left">
                  <div className="flex justify-between items-center text-sm font-bold text-slate-700">
                    <span>Weka Kiasi cha Mtaji:</span>
                    <strong className="text-emerald-700 text-lg">TZS {yieldAmount.toLocaleString()}</strong>
                  </div>
                  <input 
                    type="range" 
                    min="100000" 
                    max="10000000" 
                    step="100000" 
                    value={yieldAmount} 
                    onChange={(e) => setYieldAmount(Number(e.target.value))} 
                    className="w-full accent-emerald-600 cursor-pointer h-2 bg-slate-200 rounded-lg"
                  />
                  <div className="bg-emerald-50 border border-emerald-200 text-emerald-800 p-3.5 rounded-xl text-xs font-bold text-center">
                    "Ukiweka TZS {yieldAmount.toLocaleString()} ➔ Utapokea TZS {monthlyYield.toLocaleString()} kila mwezi (13% p.a)."
                  </div>
                  <div className="flex justify-between items-center pt-2 border-t border-slate-200 text-xs font-semibold text-slate-600">
                    <div>Faida ya Kila Mwezi: <strong className="text-emerald-700 font-bold">TZS {monthlyYield.toLocaleString()}</strong></div>
                    <div>Jumla ya Faida (Mwaka): <strong className="text-emerald-700 font-bold">TZS {totalYield12Months.toLocaleString()}</strong></div>
                  </div>
                </div>
              </div>
            )}

            {activeTab === 'p2p' && (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-8 items-center animate-fadeIn">
                <div>
                  <h3 className="text-2xl font-extrabold text-emerald-950 mb-4">P2P Crowdfunding & Split Payment</h3>
                  <p className="text-sm text-slate-600 leading-relaxed mb-6">Wekeza kwenye kilimo cha biashara na logistics. Faida inarudishwa moja kwa moja kupitia Automated Split Payment Engine.</p>
                </div>
                <div className="rounded-2xl border border-slate-100 bg-slate-50 p-5 shadow-sm flex flex-col gap-3">
                  <div className="flex justify-between text-xs font-bold text-slate-800">
                    <span>Kilimo cha Umwagiliaji Morogoro</span>
                    <span className="bg-emerald-100 text-emerald-800 px-2 py-0.5 rounded text-[10px]">ROI: 18% Pa.a</span>
                  </div>
                  <div className="w-full bg-slate-200 h-2 rounded-full overflow-hidden">
                    <div className="bg-emerald-600 h-full w-3/4" />
                  </div>
                  <div className="flex justify-between text-[11px] font-semibold text-slate-500">
                    <span>Mtaji: TZS 15M / 20M</span>
                    <span className="bg-sky-100 text-sky-800 px-1.5 py-0.5 rounded">Risk: Low</span>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      </section>

      {/* E. HOW IT WORKS & FOOTER */}
      <section className="py-20 px-6 bg-white" id="jinsi">
        <div className="max-w-5xl mx-auto">
          <div className="text-center mb-12">
            <h2 className="text-3xl font-extrabold text-emerald-950 mb-3">Jinsi Inavyofanya Kazi</h2>
            <p className="text-sm text-slate-600">Hatua tatu rahisi kuanza safari yako ya kifedha.</p>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
            <div className="rounded-2xl border border-slate-100 bg-slate-50 p-8 text-center shadow-sm hover:shadow-md transition-all">
              <div className="w-10 h-10 bg-emerald-600 text-white font-extrabold rounded-full flex items-center justify-center mx-auto mb-4 text-sm shadow-sm">1</div>
              <h3 className="text-base font-extrabold text-emerald-950 mb-2">Pakua au Jisajili</h3>
              <p className="text-xs text-slate-600 leading-relaxed">Pakua App au fungua akaunti ya mtandaoni kwa namba ya simu au NIDA.</p>
            </div>
            <div className="rounded-2xl border border-slate-100 bg-slate-50 p-8 text-center shadow-sm hover:shadow-md transition-all">
              <div className="w-10 h-10 bg-emerald-600 text-white font-extrabold rounded-full flex items-center justify-center mx-auto mb-4 text-sm shadow-sm">2</div>
              <h3 className="text-base font-extrabold text-emerald-950 mb-2">Chagua Huduma</h3>
              <p className="text-xs text-slate-600 leading-relaxed">Jiunge na kikundi cha VICOBA, anzisha Upatu, au wekeza kwenye Afrikoba Yield.</p>
            </div>
            <div className="rounded-2xl border border-slate-100 bg-slate-50 p-8 text-center shadow-sm hover:shadow-md transition-all">
              <div className="w-10 h-10 bg-emerald-600 text-white font-extrabold rounded-full flex items-center justify-center mx-auto mb-4 text-sm shadow-sm">3</div>
              <h3 className="text-base font-extrabold text-emerald-950 mb-2">Simamia na Ukuze</h3>
              <p className="text-xs text-slate-600 leading-relaxed">Pokea gawio la faida, fuatilia miamala kwa urahisi, na ulinde akiba yako.</p>
            </div>
          </div>
        </div>
      </section>

      <section className="py-16 px-6 bg-emerald-50 text-center" id="kuhusu">
        <div className="max-w-3xl mx-auto">
          <h2 className="text-2xl font-extrabold text-emerald-950 mb-3">Kuhusu Afrikoba Global</h2>
          <p className="text-sm text-slate-600 leading-relaxed">Afrikoba Global ni jukwaa la kidijitali lenye maono ya miaka 150 ijayo ya kuleta ulinzi wa kibenki, uwazi wa VICOBA, na fursa za uwekezaji kwa mamilioni ya wananchi barani Afrika chini ya sheria za ulinzi wa data binafsi (PDPC).</p>
        </div>
      </section>

      <footer className="bg-emerald-950 text-white py-16 px-6">
        <div className="max-w-7xl mx-auto grid grid-cols-1 md:grid-cols-3 gap-12 mb-12">
          <div>
            <h3 className="text-lg font-extrabold mb-3">Afrikoba Global</h3>
            <p className="text-xs text-slate-400 leading-relaxed max-w-xs">Mfumo Salama wa Kidijitali wa Akiba, VICOBA, Mzunguko na Uwekezaji.</p>
          </div>
          <div className="flex flex-col gap-2.5">
            <h4 className="text-sm font-bold text-amber-400 mb-1">Huduma</h4>
            <a href="#huduma" className="text-xs text-slate-400 hover:text-white transition-colors">VICOBA Automation</a>
            <a href="#huduma" className="text-xs text-slate-400 hover:text-white transition-colors">ROSCA / Upatu</a>
            <a href="#yield" className="text-xs text-slate-400 hover:text-white transition-colors">Afrikoba Yield</a>
            <a href="#uwekezaji" className="text-xs text-slate-400 hover:text-white transition-colors">P2P Hub</a>
          </div>
          <div className="flex flex-col gap-2.5">
            <h4 className="text-sm font-bold text-amber-400 mb-1">Mawasiliano</h4>
            <a href="mailto:support@afrikoba.com" className="text-xs text-slate-400 hover:text-white transition-colors">support@afrikoba.com</a>
            <a href="tel:+255700000000" className="text-xs text-slate-400 hover:text-white transition-colors">+255 700 000 000</a>
            <Link to="/login" className="text-xs text-slate-400 hover:text-white transition-colors">Wasiliana Nasi</Link>
          </div>
        </div>
        <div className="max-w-7xl mx-auto pt-6 border-t border-white/10 text-center text-xs text-slate-500">
          <p>&copy; {new Date().getFullYear()} Afrikoba Global. All rights reserved. Bank-Grade Security & PDPC Compliant.</p>
        </div>
      </footer>
    </div>
  );
}
