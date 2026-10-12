-- 139b | Phase 68 — preserve existing invariant names and add range checks.
CREATE OR REPLACE FUNCTION fn_financial_invariants()
RETURNS TABLE (check_name TEXT, ok BOOLEAN, note TEXT) AS $$
BEGIN
  -- Preserve the established check name for monitoring compatibility.
  RETURN QUERY
    SELECT 'no_negative_wallets'::TEXT,
           NOT EXISTS (
             SELECT 1
             FROM users
             WHERE wallet_balance IS NULL
                OR locked_balance IS NULL
                OR wallet_balance < 0
                OR locked_balance < 0
           ),
           'user balances are non-null and non-negative';

  RETURN QUERY
    SELECT 'wallet_balances_finite'::TEXT,
           NOT EXISTS (
             SELECT 1
             FROM users
             WHERE wallet_balance IS NULL
                OR locked_balance IS NULL
                OR NOT (
                  wallet_balance BETWEEN 0 AND 9999999999999.99
                )
                OR NOT (
                  locked_balance BETWEEN 0 AND 9999999999999.99
                )
           ),
           'user balances are finite and within NUMERIC(15,2) range';

  -- Preserve the established check name for journal balance monitoring.
  RETURN QUERY
    SELECT 'journal_balanced'::TEXT,
           NOT EXISTS (
             SELECT entry_group_id
             FROM (
               SELECT entry_group_id,
                      COALESCE(SUM(amount) FILTER (WHERE direction = 'DR'), 0) AS dr,
                      COALESCE(SUM(amount) FILTER (WHERE direction = 'CR'), 0) AS cr
               FROM journal_entries
               GROUP BY entry_group_id
             ) AS g
             WHERE g.dr <> g.cr
           ),
           'all journal groups balanced';

  RETURN QUERY
    SELECT 'journal_amounts_finite'::TEXT,
           NOT EXISTS (
             SELECT 1
             FROM journal_entries
             WHERE NOT (
               amount BETWEEN 0 AND 999999999999999.9999
             )
           ),
           'journal amounts are finite and within NUMERIC(19,4) range';
END;
$$ LANGUAGE plpgsql;
