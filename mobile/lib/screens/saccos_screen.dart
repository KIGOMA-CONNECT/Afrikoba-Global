import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import '../core/app_state.dart';
import '../core/api_client.dart';
import '../core/format.dart';
import '../widgets/status_badge.dart';

/// SACCOS Digital Core - mobile parity.
/// Dashboard, shares, savings, loans, funds/welfare, standing orders, guarantees,
/// dividends & statement — all member-facing endpoints surfaced on one screen.
class SaccosScreen extends StatefulWidget {
  const SaccosScreen({super.key});

  @override
  State<SaccosScreen> createState() => _SaccosScreenState();
}

class _SaccosScreenState extends State<SaccosScreen> {
  bool _loading = true;

  // memberships
  List<Map<String, dynamic>> _memberships = [];
  int? _selectedSaccosId;

  // overview
  Map<String, dynamic>? _sharesSummary;
  Map<String, dynamic>? _savingsSummary;
  Map<String, dynamic>? _creditSummary;
  Map<String, dynamic>? _compliance;

  // loans
  List<Map<String, dynamic>> _myLoans = [];

  // guarantees
  List<Map<String, dynamic>> _myGuarantees = [];

  // dividends
  Map<String, dynamic>? _dividendsSummary;
  List<Map<String, dynamic>> _myDividends = [];

  // standing orders
  List<Map<String, dynamic>> _myStandingOrders = [];

  // recent statement
  List<Map<String, dynamic>> _statement = [];

  @override
  void initState() {
    super.initState();
    _loadMemberships();
  }

  num _num(dynamic v) {
    if (v == null) return 0;
    if (v is num) return v;
    return num.tryParse(v.toString()) ?? 0;
  }

  String _saccosName() {
    if (_memberships.isEmpty) return 'SACCOS';
    final m = _memberships.firstWhere(
      (m) => m['saccos_id'] == _selectedSaccosId,
      orElse: () => _memberships.first,
    );
    return (m['saccos_name'] ?? m['name'] ?? 'SACCOS').toString();
  }

  Future<void> _loadMemberships() async {
    setState(() => _loading = true);
    final api = AppState.instance.api;
    try {
      final res = await api.get('/saccos');
      final list = (res['result'] as List? ?? []).cast<Map<String, dynamic>>();
      if (!mounted) return;
      setState(() {
        _memberships = list;
        if (list.isNotEmpty) {
          _selectedSaccosId = list.first['saccos_id'] as int?;
        }
      });
      if (_selectedSaccosId != null) await _loadDashboard();
    } on ApiException catch (e) {
      if (!mounted) return;
      setState(() => _loading = false);
      _toast(e.message, error: true);
    } catch (_) {
      if (mounted) setState(() => _loading = false);
    }
  }

  Future<void> _loadDashboard() async {
    if (_selectedSaccosId == null) return;
    final api = AppState.instance.api;
    final id = _selectedSaccosId!;
    try {
      final results = await Future.wait([
        api.get('/saccos/$id/shares/summary'),
        api.get('/saccos/$id/savings/summary'),
        api.get('/saccos/$id/loans/summary'),
        api.get('/saccos/$id/compliance'),
        api.get('/saccos/$id/loans/mine'),
        api.get('/saccos/$id/loans/guarantees/mine'),
        api.get('/saccos/$id/dividends/summary'),
        api.get('/saccos/$id/dividends/mine'),
        api.get('/saccos/$id/standing-orders/mine'),
        api.get('/saccos/$id/statements/mine'),
      ]);
      if (!mounted) return;
      setState(() {
        _sharesSummary = results[0]['result'] as Map<String, dynamic>?;
        _savingsSummary = results[1]['result'] as Map<String, dynamic>?;
        _creditSummary = results[2]['result'] as Map<String, dynamic>?;
        _compliance = results[3]['result'] as Map<String, dynamic>?;
        _myLoans = (results[4]['result'] as List? ?? []).cast<Map<String, dynamic>>();
        _myGuarantees = (results[5]['result'] as List? ?? []).cast<Map<String, dynamic>>();
        _dividendsSummary = results[6]['result'] as Map<String, dynamic>?;
        _myDividends = (results[7]['result'] as List? ?? []).cast<Map<String, dynamic>>();
        _myStandingOrders = (results[8]['result'] as List? ?? []).cast<Map<String, dynamic>>();
        _statement = (results[9]['result'] as List? ?? []).cast<Map<String, dynamic>>();
        _loading = false;
      });
    } on ApiException catch (e) {
      if (!mounted) return;
      setState(() => _loading = false);
      _toast(e.message, error: true);
    } catch (_) {
      if (mounted) setState(() => _loading = false);
    }
  }

  Future<void> _refresh() async {
    await _loadDashboard();
  }

  void _toast(String msg, {bool error = false}) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(content: Text(msg), backgroundColor: error ? Colors.red : null),
    );
  }

  // ──────────── actions ────────────

  Future<void> _deposit() async {
    final amtCtl = TextEditingController();
    final saved = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Weka Savings'),
        content: TextField(
          controller: amtCtl,
          keyboardType: const TextInputType.numberWithOptions(decimal: true),
          inputFormatters: [FilteringTextInputFormatter.allow(RegExp(r'[0-9.]'))],
          decoration: const InputDecoration(labelText: 'Kiasi (TZS)', border: OutlineInputBorder()),
        ),
        actions: [
          TextButton(onPressed: () => Navigator.of(ctx).pop(false), child: const Text('Ghairi')),
          FilledButton(onPressed: () => Navigator.of(ctx).pop(true), child: const Text('Weka')),
        ],
      ),
    );
    if (saved != true) return;
    final amount = double.tryParse(amtCtl.text.trim());
    if (amount == null || amount <= 0) { _toast('Kiasi sahihi.', error: true); return; }
    try {
      await AppState.instance.api.post('/saccos/$_selectedSaccosId/savings/deposit', {'amount': amtCtl.text.trim()});
      _toast('Amejaa (imehifadhiwa).');
      await _refresh();
    } on ApiException catch (e) { _toast(e.message, error: true); }
  }

  Future<void> _withdraw() async {
    final amtCtl = TextEditingController();
    final saved = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Toa Savings'),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Text('Salio lililopo: ${formatMoney(_num(_savingsSummary?['total_balance']))}'),
            const SizedBox(height: 10),
            TextField(
              controller: amtCtl,
              keyboardType: const TextInputType.numberWithOptions(decimal: true),
              inputFormatters: [FilteringTextInputFormatter.allow(RegExp(r'[0-9.]'))],
              decoration: const InputDecoration(labelText: 'Kiasi (TZS)', border: OutlineInputBorder()),
            ),
          ],
        ),
        actions: [
          TextButton(onPressed: () => Navigator.of(ctx).pop(false), child: const Text('Ghairi')),
          FilledButton(onPressed: () => Navigator.of(ctx).pop(true), child: const Text('Omba')),
        ],
      ),
    );
    if (saved != true) return;
    final amount = double.tryParse(amtCtl.text.trim());
    if (amount == null || amount <= 0) { _toast('Kiasi sahihi.', error: true); return; }
    try {
      await AppState.instance.api.post('/saccos/$_selectedSaccosId/savings/withdraw', {'amount': amtCtl.text.trim()});
      _toast('Ombi la kutoa limetumwa (PENDING).');
      await _refresh();
    } on ApiException catch (e) { _toast(e.message, error: true); }
  }

  Future<void> _buyShares() async {
    final amtCtl = TextEditingController();
    final saved = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Nunua Hisa'),
        content: TextField(
          controller: amtCtl,
          keyboardType: TextInputType.number,
          inputFormatters: [FilteringTextInputFormatter.digitsOnly],
          decoration: const InputDecoration(labelText: 'Idadi ya hisa', border: OutlineInputBorder()),
        ),
        actions: [
          TextButton(onPressed: () => Navigator.of(ctx).pop(false), child: const Text('Ghairi')),
          FilledButton(onPressed: () => Navigator.of(ctx).pop(true), child: const Text('Nunua')),
        ],
      ),
    );
    if (saved != true) return;
    final shares = int.tryParse(amtCtl.text.trim());
    if (shares == null || shares <= 0) { _toast('Idadi sahihi.', error: true); return; }
    try {
      await AppState.instance.api.post('/saccos/$_selectedSaccosId/shares/purchase', {'shares': shares});
      _toast('Ombi la kununua hisa limetumwa.');
      await _refresh();
    } on ApiException catch (e) { _toast(e.message, error: true); }
  }

  Future<void> _applyLoan() async {
    final amtCtl = TextEditingController();
    final termCtl = TextEditingController();
    final purposeCtl = TextEditingController();
    final saved = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Omba Mkopo'),
        content: SingleChildScrollView(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              TextField(
                controller: amtCtl,
                keyboardType: const TextInputType.numberWithOptions(decimal: true),
                inputFormatters: [FilteringTextInputFormatter.allow(RegExp(r'[0-9.]'))],
                decoration: const InputDecoration(labelText: 'Kiasi (TZS)', border: OutlineInputBorder()),
              ),
              const SizedBox(height: 10),
              TextField(
                controller: termCtl,
                keyboardType: TextInputType.number,
                inputFormatters: [FilteringTextInputFormatter.digitsOnly],
                decoration: const InputDecoration(labelText: 'Muda (miezi)', border: OutlineInputBorder()),
              ),
              const SizedBox(height: 10),
              TextField(
                controller: purposeCtl,
                decoration: const InputDecoration(labelText: 'Kusudi la mkopo', border: OutlineInputBorder()),
              ),
            ],
          ),
        ),
        actions: [
          TextButton(onPressed: () => Navigator.of(ctx).pop(false), child: const Text('Ghairi')),
          FilledButton(onPressed: () => Navigator.of(ctx).pop(true), child: const Text('Tuma')),
        ],
      ),
    );
    if (saved != true) return;
    final amount = double.tryParse(amtCtl.text.trim());
    final term = int.tryParse(termCtl.text.trim());
    if (amount == null || amount <= 0 || term == null || term <= 0) {
      _toast('Kiasi na muda ni lazima.', error: true); return;
    }
    try {
      await AppState.instance.api.post('/saccos/$_selectedSaccosId/loans/apply', {
        'amount': amtCtl.text.trim(),
        'termMonths': term,
        'purpose': purposeCtl.text.trim(),
      });
      _toast('Ombi la mkopo limetumwa.');
      await _refresh();
    } on ApiException catch (e) { _toast(e.message, error: true); }
  }

  Future<void> _repayLoan(int loanId) async {
    final amtCtl = TextEditingController();
    final saved = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Lipa Mkopo'),
        content: TextField(
          controller: amtCtl,
          keyboardType: const TextInputType.numberWithOptions(decimal: true),
          inputFormatters: [FilteringTextInputFormatter.allow(RegExp(r'[0-9.]'))],
          decoration: const InputDecoration(labelText: 'Kiasi (TZS)', border: OutlineInputBorder()),
        ),
        actions: [
          TextButton(onPressed: () => Navigator.of(ctx).pop(false), child: const Text('Ghairi')),
          FilledButton(onPressed: () => Navigator.of(ctx).pop(true), child: const Text('Lipa')),
        ],
      ),
    );
    if (saved != true) return;
    final amount = double.tryParse(amtCtl.text.trim());
    if (amount == null || amount <= 0) { _toast('Kiasi sahihi.', error: true); return; }
    try {
      await AppState.instance.api.post('/saccos/$_selectedSaccosId/loans/$loanId/repay', {'amount': amtCtl.text.trim()});
      _toast('Malipo yamepokelewa.');
      await _refresh();
    } on ApiException catch (e) { _toast(e.message, error: true); }
  }

  // ──────────── UI helpers ────────────

  Widget _statChip(String label, String value, IconData icon, Color color) {
    return Expanded(
      child: Card(
        child: Padding(
          padding: const EdgeInsets.all(12),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Icon(icon, color: color, size: 20),
              const SizedBox(height: 6),
              Text(value, style: const TextStyle(fontSize: 15, fontWeight: FontWeight.w800)),
              Text(label, style: TextStyle(fontSize: 11, color: Colors.grey.shade600)),
            ],
          ),
        ),
      ),
    );
  }

  Widget _sectionHeader(String title) {
    return Padding(
      padding: const EdgeInsets.only(top: 20, bottom: 6),
      child: Text(title, style: const TextStyle(fontWeight: FontWeight.w700, fontSize: 15)),
    );
  }

  String _loanStatusLabel(Map<String, dynamic> l) {
    final status = (l['status'] ?? '').toString();
    final arrears = _num(l['late_fees_outstanding']) + _num(l['penalty_outstanding']) + _num(l['interest_outstanding']);
    if (arrears > 0) return 'ARREARS';
    return status;
  }

  @override
  Widget build(BuildContext context) {
    return RefreshIndicator(
      onRefresh: _refresh,
      child: _loading
          ? const Center(child: CircularProgressIndicator())
          : _memberships.isEmpty
              ? const Center(
                  child: Padding(
                    padding: EdgeInsets.all(32),
                    child: Text('Hujajiunga na SACCOS yoyote bado.', textAlign: TextAlign.center),
                  ),
                )
              : ListView(
                  padding: const EdgeInsets.all(16),
                  children: [
                    // ── SACCOS picker ──
                    if (_memberships.length > 1)
                      DropdownButtonFormField<int>(
                        initialValue: _selectedSaccosId,
                        isExpanded: true,
                        decoration: const InputDecoration(
                          labelText: 'Chagua SACCOS',
                          border: OutlineInputBorder(),
                          contentPadding: EdgeInsets.symmetric(horizontal: 12, vertical: 14),
                        ),
                        items: _memberships
                            .map((m) => DropdownMenuItem(
                                  value: m['saccos_id'] as int?,
                                  child: Text('${m['saccos_name'] ?? m['name'] ?? 'SACCOS'}'),
                                ))
                            .toList(),
                        onChanged: (v) {
                          setState(() => _selectedSaccosId = v);
                          _loadDashboard();
                        },
                      ),
                    if (_memberships.isEmpty)
                      Text(_saccosName(), style: const TextStyle(fontSize: 16, fontWeight: FontWeight.w700)),

                    // ── Overview stats ──
                    _sectionHeader('Muhtasari'),
                    Row(
                      children: [
                        _statChip('Hisa', '${_num(_sharesSummary?['total_shares']).round()}', Icons.show_chart, const Color(0xFF0B7A41)),
                        _statChip('Akiba', formatMoney(_num(_savingsSummary?['total_balance'])), Icons.savings_outlined, const Color(0xFF155E9C)),
                      ],
                    ),
                    Row(
                      children: [
                        _statChip('Mikopo', formatMoney(_num(_creditSummary?['total_outstanding'])), Icons.account_balance, const Color(0xFF6D3FB8)),
                        _statChip('Uwiano', '${_num(_creditSummary?['repayment_rate_pct'])}%', Icons.pie_chart_outline, const Color(0xFFE07B00)),
                      ],
                    ),
                    if (_compliance != null) ...[
                      const SizedBox(height: 8),
                      Card(
                        color: const Color(0xFFF2FAF4),
                        child: ListTile(
                          leading: const Icon(Icons.verified_user, color: Color(0xFF0B7A41)),
                          title: const Text('Uwiano wa Kufuata Sheria'),
                          subtitle: Text(
                            'Hisa: ${_num(_compliance?['share_compliance_pct'])}%  •  Akiba: ${_num(_compliance?['savings_compliance_pct'])}%',
                            style: TextStyle(fontSize: 12, color: Colors.grey.shade700),
                          ),
                        ),
                      ),
                    ],

                    // ── Quick actions ──
                    _sectionHeader('Hatua za Haraka'),
                    Wrap(
                      spacing: 8,
                      runSpacing: 8,
                      children: [
                        FilledButton.tonalIcon(onPressed: _deposit, icon: const Icon(Icons.savings), label: const Text('Weka')),
                        FilledButton.tonalIcon(onPressed: _withdraw, icon: const Icon(Icons.money_off), label: const Text('Toa')),
                        FilledButton.tonalIcon(onPressed: _buyShares, icon: const Icon(Icons.show_chart), label: const Text('Nunua Hisa')),
                        FilledButton.tonalIcon(onPressed: _applyLoan, icon: const Icon(Icons.request_quote), label: const Text('Omba Mkopo')),
                      ],
                    ),

                    // ── My loans ──
                    if (_myLoans.isNotEmpty) ...[
                      _sectionHeader('Mikopo Yangu'),
                      for (final loan in _myLoans)
                        Card(
                          child: ListTile(
                            leading: StatusBadge(_loanStatusLabel(loan)),
                            title: Text(formatMoney(_num(loan['principal']))),
                            subtitle: Text(
                              'Deni: ${formatMoney(_num(loan['amount_outstanding']))}  •  ${loan['purpose'] ?? ''}',
                              style: const TextStyle(fontSize: 11.5),
                            ),
                            trailing: FilledButton.tonal(
                              onPressed: () => _repayLoan(loan['id'] as int),
                              child: const Text('Lipa'),
                            ),
                          ),
                        ),
                    ],

                    // ── Guarantees ──
                    if (_myGuarantees.isNotEmpty) ...[
                      _sectionHeader('Dhamina Zangu'),
                      for (final g in _myGuarantees)
                        Card(
                          child: ListTile(
                            leading: StatusBadge((g['status'] ?? '').toString()),
                            title: Text('Mkopo #${g['loan_id'] ?? ''}'),
                            subtitle: Text(
                              'Mkopo: ${formatMoney(_num(g['loan_principal']))}  •  Halijalipwa: ${formatMoney(_num(g['arrears_amount']))}',
                              style: const TextStyle(fontSize: 11.5),
                            ),
                          ),
                        ),
                    ],

                    // ── Dividends ──
                    if (_dividendsSummary != null && _num(_dividendsSummary!['total_dividends']) > 0) ...[
                      _sectionHeader('Gawio'),
                      Card(
                        child: Padding(
                          padding: const EdgeInsets.all(14),
                          child: Row(
                            children: [
                              const Icon(Icons.receipt_long, color: Color(0xFF0B7A41)),
                              const SizedBox(width: 10),
                              Column(
                                crossAxisAlignment: CrossAxisAlignment.start,
                                children: [
                                  Text(formatMoney(_num(_dividendsSummary!['total_dividends'])),
                                      style: const TextStyle(fontSize: 17, fontWeight: FontWeight.w800)),
                                  Text('Gawio la jumla', style: TextStyle(fontSize: 12, color: Colors.grey.shade600)),
                                ],
                              ),
                            ],
                          ),
                        ),
                      ),
                      for (final d in _myDividends.take(5))
                        Card(
                          child: ListTile(
                            leading: StatusBadge((d['status'] ?? '').toString()),
                            title: Text(formatMoney(_num(d['amount']))),
                            subtitle: Text(
                              'SACCOS: ${d['saccos_name'] ?? ''}  •  ${formatDate(d['created_at'])}',
                              style: const TextStyle(fontSize: 11.5),
                            ),
                          ),
                        ),
                    ],

                    // ── Standing orders ──
                    _sectionHeader('Amri za Kudumu'),
                    FilledButton.tonalIcon(
                      onPressed: _createStandingOrder,
                      icon: const Icon(Icons.repeat),
                      label: const Text('Unda Amri Mpya'),
                    ),
                    if (_myStandingOrders.isNotEmpty) ...[
                      const SizedBox(height: 8),
                      for (final so in _myStandingOrders)
                        Card(
                          child: ListTile(
                            leading: StatusBadge((so['is_active'] ?? true) ? 'ACTIVE' : 'CLOSED'),
                            title: Text('${so['target_type'] ?? ''} — ${formatMoney(_num(so['amount']))}'),
                            subtitle: Text(
                              'Siku: ${so['day_of_month'] ?? ''}  •  ${so['status'] ?? ''}',
                              style: const TextStyle(fontSize: 11.5),
                            ),
                            trailing: (so['is_active'] ?? true)
                                ? IconButton(
                                    icon: const Icon(Icons.pause_circle_outline, color: Colors.orange),
                                    onPressed: () => _deactivateStandingOrder(so['id'] as int),
                                  )
                                : null,
                          ),
                        ),
                    ],

                    // ── Statement (last 10) ──
                    if (_statement.isNotEmpty) ...[
                      _sectionHeader('Hoja ya Hesabu (Za Hivi Karibuni)'),
                      for (final s in _statement.take(10))
                        Card(
                          child: ListTile(
                            leading: Icon(
                              _num(s['debit']) > 0 ? Icons.arrow_downward : Icons.arrow_upward,
                              color: _num(s['debit']) > 0 ? Colors.red : Colors.green,
                              size: 20,
                            ),
                            title: Text(s['description'] ?? ''),
                            subtitle: Text(
                              '${formatDate(s['created_at'])}  •  Debit: ${formatMoney(_num(s['debit']))}  Credit: ${formatMoney(_num(s['credit']))}',
                              style: const TextStyle(fontSize: 11.5),
                            ),
                          ),
                        ),
                    ],
                  ],
                ),
    );
  }

  // ──────────── Standing order create ────────────

  Future<void> _createStandingOrder() async {
    String targetType = 'SAVINGS_DEPOSIT';
    final amtCtl = TextEditingController();
    final dayCtl = TextEditingController(text: '1');
    final targetCtl = TextEditingController();
    final saved = await showDialog<bool>(
      context: context,
      builder: (ctx) => StatefulBuilder(
        builder: (ctx, setDlg) => AlertDialog(
          title: const Text('Unda Amri ya Kudumu'),
          content: SingleChildScrollView(
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                DropdownButtonFormField<String>(
                  initialValue: targetType,
                  isExpanded: true,
                  decoration: const InputDecoration(labelText: 'Aina', border: OutlineInputBorder()),
                  items: const [
                    DropdownMenuItem(value: 'SAVINGS_DEPOSIT', child: Text('Kuweka Akiba')),
                    DropdownMenuItem(value: 'FUND_CONTRIBUTION', child: Text('Kuchangia Fedha')),
                    DropdownMenuItem(value: 'WELFARE_CONTRIBUTION', child: Text('Kuchangia Pamoja')),
                    DropdownMenuItem(value: 'LOAN_REPAYMENT', child: Text('Kulipa Mkopo')),
                  ],
                  onChanged: (v) => setDlg(() => targetType = v ?? 'SAVINGS_DEPOSIT'),
                ),
                const SizedBox(height: 10),
                TextField(
                  controller: amtCtl,
                  keyboardType: const TextInputType.numberWithOptions(decimal: true),
                  inputFormatters: [FilteringTextInputFormatter.allow(RegExp(r'[0-9.]'))],
                  decoration: const InputDecoration(labelText: 'Kiasi (TZS)', border: OutlineInputBorder()),
                ),
                const SizedBox(height: 10),
                if (targetType == 'LOAN_REPAYMENT')
                  TextField(
                    controller: targetCtl,
                    keyboardType: TextInputType.number,
                    inputFormatters: [FilteringTextInputFormatter.digitsOnly],
                    decoration: const InputDecoration(labelText: 'ID ya Mkopo', border: OutlineInputBorder()),
                  ),
                if (targetType != 'SAVINGS_DEPOSIT' && targetType != 'LOAN_REPAYMENT')
                  TextField(
                    controller: targetCtl,
                    keyboardType: TextInputType.number,
                    inputFormatters: [FilteringTextInputFormatter.digitsOnly],
                    decoration: const InputDecoration(labelText: 'ID ya Fedha/Fundi', border: OutlineInputBorder()),
                  ),
                const SizedBox(height: 10),
                TextField(
                  controller: dayCtl,
                  keyboardType: TextInputType.number,
                  inputFormatters: [FilteringTextInputFormatter.digitsOnly],
                  decoration: const InputDecoration(labelText: 'Siku ya mwezi (1-28)', border: OutlineInputBorder()),
                ),
              ],
            ),
          ),
          actions: [
            TextButton(onPressed: () => Navigator.of(ctx).pop(false), child: const Text('Ghairi')),
            FilledButton(onPressed: () => Navigator.of(ctx).pop(true), child: const Text('Unda')),
          ],
        ),
      ),
    );
    if (saved != true) return;
    final amount = double.tryParse(amtCtl.text.trim());
    final day = int.tryParse(dayCtl.text.trim());
    if (amount == null || amount <= 0 || day == null || day < 1 || day > 28) {
      _toast('Taarifa sahihi zinahitajika.', error: true); return;
    }
    try {
      final body = <String, dynamic>{
        'targetType': targetType,
        'amount': amtCtl.text.trim(),
        'dayOfMonth': day,
      };
      if (targetCtl.text.trim().isNotEmpty) body['targetId'] = int.tryParse(targetCtl.text.trim());
      await AppState.instance.api.post('/saccos/$_selectedSaccosId/standing-orders', body);
      _toast('Amri ya kudumu imeundwa.');
      await _refresh();
    } on ApiException catch (e) { _toast(e.message, error: true); }
  }

  Future<void> _deactivateStandingOrder(int orderId) async {
    try {
      await AppState.instance.api.post('/saccos/$_selectedSaccosId/standing-orders/$orderId/deactivate', null);
      _toast('Amri imesimamishwa.');
      await _refresh();
    } on ApiException catch (e) { _toast(e.message, error: true); }
  }
}
