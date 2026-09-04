import { useRef, useState } from 'react';
import api from '../api/client.js';

/**
 * Step-Up Authentication hook for sensitive operations.
 *
 * run(fn) wraps a callable that accepts a config object `{ headers }`.
 * If the server answers STEPUP_REQUIRED (403), a modal state is raised.
 * confirmCode(opts) verifies a second-factor code, obtains a single-use
 * step-up token, then re-runs the pending callable with the token header.
 */
export default function useStepUp() {
  const [modal, setModal] = useState(null); // { purpose, pending }
  const pendingRef = useRef(null);

  const requestCode = async (purpose) => {
    try { const r = await api.post('/auth/stepup/request', { purpose }); return r.data; }
    catch (e) { return { success: false, message: e.response?.data?.message }; }
  };

  const run = async (fn) => {
    try {
      return await fn({});
    } catch (e) {
      const code = e.response?.data?.code;
      if (e.response?.status === 403 && code && code.startsWith('STEPUP')) {
        const purpose = e.response?.data?.purpose || 'ADMIN_ACTION';
        pendingRef.current = fn;
        setModal({ purpose });
        return { __stepup: true };
      }
      throw e;
    }
  };

  const confirmCode = async (code) => {
    if (!modal || !pendingRef.current) return { success: false, message: 'No pending action' };
    let res;
    try { res = await api.post('/auth/stepup/verify', { purpose: modal.purpose, code }); }
    catch (e) { return { success: false, message: e.response?.data?.message || 'Verification failed' }; }
    if (!res.data?.success) return { success: false, message: res.data?.message || 'Verification failed' };

    const token = res.data.token;
    const fn = pendingRef.current;
    pendingRef.current = null;
    setModal(null);
    try {
      return await fn({ headers: { 'x-stepup-token': token } });
    } catch (e) {
      throw e;
    }
  };

  const close = () => { pendingRef.current = null; setModal(null); };

  return { run, requestCode, confirmCode, modal, close };
}
