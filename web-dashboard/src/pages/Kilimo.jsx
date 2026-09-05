import React, { useEffect, useState } from 'react';
import api from '../api/client.js';
import { formatMoney, StatusBadge } from '../components/ui.jsx';
import { useT } from '../i18n/LangProvider.jsx';

const IRRIGATION = ['RAIN_FED', 'DRIP', 'SPRINKLER', 'IRRIGATION_CHANNEL'];
const LOAN_TYPES = ['INPUT_FINANCING', 'HARVEST_CYCLE', 'EQUIPMENT'];

export default function Kilimo() {
  const { t } = useT();
  const user = JSON.parse(localStorage.getItem('afrikoba_user') || '{}');
  const isAdmin = user.role === 'ADMIN';

  const [farms, setFarms] = useState([]);
  const [loans, setLoans] = useState([]);
  const [msg, setMsg] = useState({ type: '', text: '' });

  const [farmName, setFarmName] = useState('');
  const [region, setRegion] = useState('');
  const [district, setDistrict] = useState('');
  const [acres, setAcres] = useState('');
  const [crop, setCrop] = useState('');
  const [irrigation, setIrrigation] = useState('RAIN_FED');
  const [harvest, setHarvest] = useState('');
  const [yieldTons, setYieldTons] = useState('');

  const [loanFarm, setLoanFarm] = useState('');
  const [loanAmount, setLoanAmount] = useState('');
  const [loanType, setLoanType] = useState('INPUT_FINANCING');
  const [supplier, setSupplier] = useState('');
  const [grace, setGrace] = useState('3');
  const [tenure, setTenure] = useState('6');

  const [repayAmt, setRepayAmt] = useState({});
  const [disbursing, setDisbursing] = useState(null);

  const [offLoan, setOffLoan] = useState('');
  const [offtaker, setOfftaker] = useState('');
  const [priceKg, setPriceKg] = useState('');
  const [qtyKg, setQtyKg] = useState('');

  const show = (type, text) => {
    setMsg({ type, text });
    setTimeout(() => setMsg({ type: '', text: '' }), 5000);
  };

  const load = () => {
    api.get('/kilimo/farms').then((r) => setFarms(r.data.farms)).catch(() => {});
    api.get('/kilimo/loans').then((r) => setLoans(r.data.loans)).catch(() => {});
  };

  useEffect(() => { load(); }, []);

  const createFarm = async (e) => {
    e.preventDefault();
    try {
      await api.post('/kilimo/farms', {
        farmName, region, district, sizeAcres: Number(acres), primaryCrop: crop,
        irrigationType: irrigation, expectedHarvestDate: harvest || undefined,
        historicalYieldTons: yieldTons ? Number(yieldTons) : undefined,
      });
      show('ok', t('kilimo.farm_created'));
      setFarmName(''); setRegion(''); setDistrict(''); setAcres(''); setCrop(''); setIrrigation('RAIN_FED'); setHarvest(''); setYieldTons('');
      load();
    } catch (err) { show('err', err.response?.data?.message || t('kilimo.error')); }
  };

  const applyLoan = async (e) => {
    e.preventDefault();
    if (!loanFarm) { show('err', t('kilimo.pick_farm')); return; }
    try {
      await api.post('/kilimo/loans', {
        farmId: Number(loanFarm), amount: Number(loanAmount), loanType: loanType,
        supplierId: supplier ? Number(supplier) : undefined,
        gracePeriodMonths: Number(grace), tenureMonths: Number(tenure),
      });
      show('ok', t('kilimo.loan_applied'));
      setLoanFarm(''); setLoanAmount(''); setLoanType('INPUT_FINANCING'); setSupplier(''); setGrace('3'); setTenure('6');
      load();
    } catch (err) { show('err', err.response?.data?.message || t('kilimo.error')); }
  };

  const repay = async (id) => {
    const amount = Number(repayAmt[id]);
    if (!amount) { show('err', t('kilimo.enter_amount')); return; }
    try {
      await api.post(`/kilimo/loans/${id}/repay`, { amount });
      show('ok', t('kilimo.repaid'));
      setRepayAmt((prev) => ({ ...prev, [id]: '' }));
      load();
    } catch (err) { show('err', err.response?.data?.message || t('kilimo.error')); }
  };

  const disburse = async (id) => {
    setDisbursing(id);
    try {
      await api.post(`/kilimo/admin/loans/${id}/disburse`);
      show('ok', t('kilimo.disbursed'));
      load();
    } catch (err) { show('err', err.response?.data?.message || t('kilimo.error')); }
    finally { setDisbursing(null); }
  };

  const createOfftake = async (e) => {
    e.preventDefault();
    if (!offLoan) { show('err', t('kilimo.pick_loan')); return; }
    try {
      await api.post('/kilimo/offtakes', {
        loanId: Number(offLoan), offtakerName: offtaker,
        agreedPricePerKg: Number(priceKg), committedQuantityKg: Number(qtyKg),
      });
      show('ok', t('kilimo.offtake_created'));
      setOffLoan(''); setOfftaker(''); setPriceKg(''); setQtyKg('');
    } catch (err) { show('err', err.response?.data?.message || t('kilimo.error')); }
  };

  return (
    <div>
      <div className="page-head">
        <h2>{t('kilimo.title')}</h2>
        <p>{t('kilimo.sub')}</p>
      </div>

      {msg.text && <div className={`msg ${msg.type}`}>{msg.text}</div>}

      <div className="grid grid-2">
        <div className="card">
          <h3>{t('kilimo.add_farm')}</h3>
          <form onSubmit={createFarm}>
            <div className="field" style={{ marginBottom: 10 }}><label>{t('kilimo.farm_name')}</label><input value={farmName} onChange={(e) => setFarmName(e.target.value)} required /></div>
            <div className="form-row">
              <div className="field"><label>{t('kilimo.region')}</label><input value={region} onChange={(e) => setRegion(e.target.value)} required /></div>
              <div className="field"><label>{t('kilimo.district')}</label><input value={district} onChange={(e) => setDistrict(e.target.value)} /></div>
              <div className="field"><label>{t('kilimo.acres')}</label><input type="number" min="0.5" step="0.5" value={acres} onChange={(e) => setAcres(e.target.value)} required /></div>
            </div>
            <div className="form-row">
              <div className="field"><label>{t('kilimo.crop')}</label><input value={crop} onChange={(e) => setCrop(e.target.value)} required /></div>
              <div className="field"><label>{t('kilimo.irrigation')}</label>
                <select value={irrigation} onChange={(e) => setIrrigation(e.target.value)}>
                  {IRRIGATION.map((i) => <option key={i} value={i}>{i}</option>)}
                </select>
              </div>
              <div className="field"><label>{t('kilimo.yield')}</label><input type="number" step="0.1" value={yieldTons} onChange={(e) => setYieldTons(e.target.value)} /></div>
            </div>
            <div className="field" style={{ marginBottom: 10 }}><label>{t('kilimo.harvest')}</label><input type="date" value={harvest} onChange={(e) => setHarvest(e.target.value)} /></div>
            <button className="btn" type="submit">{t('kilimo.add_farm_btn')}</button>
          </form>
        </div>

        <div className="card">
          <h3>{t('kilimo.apply_loan')}</h3>
          <form onSubmit={applyLoan}>
            <div className="field" style={{ marginBottom: 10 }}>
              <label>{t('kilimo.pick_farm')}</label>
              <select value={loanFarm} onChange={(e) => setLoanFarm(e.target.value)}>
                <option value="">-- {t('sec.select')} --</option>
                {farms.map((f) => <option key={f.id} value={f.id}>{f.farm_name} ({f.region})</option>)}
              </select>
            </div>
            <div className="form-row">
              <div className="field"><label>{t('kilimo.loan_amount')}</label><input type="number" min="1" value={loanAmount} onChange={(e) => setLoanAmount(e.target.value)} required /></div>
              <div className="field"><label>{t('kilimo.loan_type')}</label>
                <select value={loanType} onChange={(e) => setLoanType(e.target.value)}>
                  {LOAN_TYPES.map((lt) => <option key={lt} value={lt}>{lt}</option>)}
                </select>
              </div>
              <div className="field"><label>{t('kilimo.supplier_id')}</label><input type="number" placeholder="(hiari)" value={supplier} onChange={(e) => setSupplier(e.target.value)} /></div>
            </div>
            <div className="form-row">
              <div className="field"><label>{t('kilimo.grace')}</label>
                <select value={grace} onChange={(e) => setGrace(e.target.value)}>
                  {[1, 2, 3, 4, 6].map((m) => <option key={m} value={m}>{m} miezi</option>)}
                </select>
              </div>
              <div className="field"><label>{t('kilimo.tenure')}</label>
                <select value={tenure} onChange={(e) => setTenure(e.target.value)}>
                  {[3, 6, 9, 12, 18].map((m) => <option key={m} value={m}>{m} miezi</option>)}
                </select>
              </div>
            </div>
            <button className="btn" type="submit">{t('kilimo.apply_loan_btn')}</button>
          </form>
        </div>
      </div>

      <div className="card section">
        <h3>{t('kilimo.my_farms')}</h3>
        {farms.length === 0 && <p className="roles-tag">{t('kilimo.no_farms')}</p>}
        <table>
          <thead><tr><th>{t('kilimo.farm_name')}</th><th>{t('kilimo.region')}</th><th>{t('kilimo.acres')}</th><th>{t('kilimo.crop')}</th><th>{t('kilimo.irrigation')}</th><th>{t('kilimo.harvest')}</th></tr></thead>
          <tbody>
            {farms.map((f) => (
              <tr key={f.id}>
                <td>{f.farm_name}</td>
                <td>{f.region}{f.district ? ` / ${f.district}` : ''}</td>
                <td>{f.size_acres}</td>
                <td>{f.primary_crop}</td>
                <td>{f.irrigation_type}</td>
                <td>{f.expected_harvest_date ? new Date(f.expected_harvest_date).toLocaleDateString() : '-'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="card section">
        <h3>{t('kilimo.loans')}</h3>
        {loans.length === 0 && <p className="roles-tag">{t('kilimo.no_loans')}</p>}
        <table>
          <thead><tr><th>{t('kilimo.farm_name')}</th><th>{t('kilimo.borrower')}</th><th>{t('kilimo.loan_type')}</th><th>{t('kilimo.loan_amount')}</th><th>{t('kilimo.due')}</th><th>{t('kilimo.th_status')}</th><th></th></tr></thead>
          <tbody>
            {loans.map((l) => (
              <tr key={l.id}>
                <td>{l.farm_name}</td>
                <td>{l.borrower_name || 'Wewe'}</td>
                <td>{l.loan_type}<div className="roles-tag">{l.supplier_name || '-'}</div></td>
                <td>{formatMoney(l.amount)}</td>
                <td>{l.repayment_due_date ? new Date(l.repayment_due_date).toLocaleDateString() : '-'}</td>
                <td><StatusBadge status={l.status} /></td>
                <td>
                  <div className="inline-actions">
                    {(l.status === 'DISBURSED' || l.status === 'OVERDUE') && (
                      <>
                        <input type="number" min="1" placeholder={t('kilimo.repay_amt')} value={repayAmt[l.id] || ''} onChange={(e) => setRepayAmt((prev) => ({ ...prev, [l.id]: e.target.value }))} style={{ width: 110 }} />
                        <button className="btn" onClick={() => repay(l.id)}>{t('kilimo.repay')}</button>
                      </>
                    )}
                    {isAdmin && l.status === 'PENDING' && (
                      <button className="btn warn" disabled={disbursing === l.id} onClick={() => disburse(l.id)}>{t('kilimo.disburse_loan')}</button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="grid grid-2">
        <div className="card">
          <h3>{t('kilimo.offtakes')}</h3>
          <form onSubmit={createOfftake}>
            <div className="field" style={{ marginBottom: 10 }}>
              <label>{t('kilimo.pick_loan')}</label>
              <select value={offLoan} onChange={(e) => setOffLoan(e.target.value)}>
                <option value="">-- {t('sec.select')} --</option>
                {loans.filter((l) => l.status === 'DISBURSED' || l.status === 'PENDING').map((l) => (
                  <option key={l.id} value={l.id}>{l.farm_name} ({formatMoney(l.amount)})</option>
                ))}
              </select>
            </div>
            <div className="form-row">
              <div className="field"><label>{t('kilimo.offtaker')}</label><input value={offtaker} onChange={(e) => setOfftaker(e.target.value)} required /></div>
              <div className="field"><label>{t('kilimo.price_kg')}</label><input type="number" min="1" value={priceKg} onChange={(e) => setPriceKg(e.target.value)} required /></div>
              <div className="field"><label>{t('kilimo.qty_kg')}</label><input type="number" min="1" value={qtyKg} onChange={(e) => setQtyKg(e.target.value)} required /></div>
            </div>
            <button className="btn" type="submit">{t('kilimo.offtake_btn')}</button>
          </form>
        </div>
      </div>
    </div>
  );
}