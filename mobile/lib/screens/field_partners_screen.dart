import 'package:flutter/material.dart';
import '../core/app_state.dart';
import '../core/api_client.dart';
import '../core/format.dart';

/// Mashirika ya Uga (Field Partners) - mkopaji anatumia "Mikopo yangu",
/// wafanyakazi/mawasiliano ya uga wanaona muhtasari wa shirika + kitabu cha mikopo.
class FieldPartnersScreen extends StatefulWidget {
  const FieldPartnersScreen({super.key});

  @override
  State<FieldPartnersScreen> createState() => _FieldPartnersScreenState();
}

class _FieldPartnersScreenState extends State<FieldPartnersScreen> {
  List<Map<String, dynamic>> _myLoans = [];
  List<Map<String, dynamic>> _book = [];
  List<Map<String, dynamic>> _partners = [];
  Map<String, dynamic>? _mySummary;
  String _role = '';
  String _selected = '';
  bool _loading = true;
  bool _busy = false;

  final TextEditingController _selfAmt = TextEditingController();
  final Map<int, TextEditingController> _bookAmt = {};
  final TextEditingController _borrowerId = TextEditingController();
  final TextEditingController _loanAmount = TextEditingController();
  final TextEditingController _rate = TextEditingController(text: '0');
  final TextEditingController _term = TextEditingController(text: '12');
  final TextEditingController _purpose = TextEditingController(text: 'GENERAL');
  int? _disbursing;

  bool get _isStaff => _role == 'ADMIN' || _role == 'OPERATOR';
  bool get _isPartner => _role == 'FIELD_PARTNER';
  bool get _console => _isStaff || _isPartner;

  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void dispose() {
    _selfAmt.dispose();
    _borrowerId.dispose();
    _loanAmount.dispose();
    _rate.dispose();
    _term.dispose();
    _purpose.dispose();
    for (final c in _bookAmt.values) {
      c.dispose();
    }
    super.dispose();
  }

  Future<void> _load() async {
    final api = AppState.instance.api;
    final user = await AppState.instance.session.user();
    if (!mounted) return;
    setState(() {
      _loading = true;
      _role = (user?['role'] as String?) ?? '';
    });
    try {
      final ml = await api.get('/field-partners/my-loans');
      _myLoans = (ml['loans'] as List).cast<Map<String, dynamic>>();
      if (_isPartner) {
        final my = await api.get('/field-partners/my');
        _mySummary = (my['summary'] as Map<String, dynamic>?) ?? {};
        final bk = await api.get('/field-partners/loans');
        _book = (bk['loans'] as List).cast<Map<String, dynamic>>();
      }
      if (_isStaff) {
        final all = await api.get('/field-partners/all');
        _partners = (all['partners'] as List).cast<Map<String, dynamic>>();
        if (_selected.isNotEmpty) await _loadSelected();
      }
    } on ApiException catch (e) {
      if (mounted) _snack(e.message, error: true);
    } catch (_) {
      if (mounted) _snack('Hitilafu imetokea.', error: true);
    }
    if (mounted) setState(() => _loading = false);
  }

  Future<void> _loadSelected() async {
    final api = AppState.instance.api;
    if (_selected.isEmpty) {
      if (mounted) setState(() { _book = []; _mySummary = null; });
      return;
    }
    try {
      final s = await api.get('/field-partners/$_selected/summary');
      final bk = await api.get('/field-partners/loans?partnerId=$_selected');
      if (mounted) {
        setState(() {
          _mySummary = (s['summary'] as Map<String, dynamic>?) ?? {};
          _book = (bk['loans'] as List).cast<Map<String, dynamic>>();
        });
      }
    } on ApiException catch (e) {
      if (mounted) _snack(e.message, error: true);
    }
  }

  void _snack(String message, {bool error = false}) {
    if (!mounted) return;
    ScaffoldMessenger.of(context)
        .showSnackBar(SnackBar(content: Text(message), backgroundColor: error ? Colors.red : Colors.green));
  }

  Future<void> _disburse(int id) async {
    setState(() => _disbursing = id);
    try {
      await AppState.instance.api.post('/field-partners/loans/$id/disburse',
          _isStaff && _selected.isNotEmpty ? {'partnerId': int.tryParse(_selected)} : null);
      if (!mounted) return;
      _snack('Mkopo umetolewa kwenye wallet ya mkopaji.');
      await _load();
    } on ApiException catch (e) {
      _snack(e.message, error: true);
    } finally {
      if (mounted) setState(() => _disbursing = null);
    }
  }

  Future<void> _bookRepay(int id) async {
    final ctrl = _bookAmt.putIfAbsent(id, () => TextEditingController());
    final amount = num.tryParse(ctrl.text.trim());
    if (amount == null || amount <= 0) {
      _snack('Weka kiasi cha malipo.', error: true);
      return;
    }
    try {
      await AppState.instance.api.post('/field-partners/loans/$id/repay', {
        'amount': amount,
        if (_isStaff && _selected.isNotEmpty) 'partnerId': int.tryParse(_selected),
        'note': 'mobile dashboard',
      });
      if (!mounted) return;
      _snack('Malipo yameandikwa.');
      ctrl.clear();
      await _load();
    } on ApiException catch (e) {
      _snack(e.message, error: true);
    }
  }

  Future<void> _selfRepay(int id) async {
    final amount = num.tryParse(_selfAmt.text.trim());
    if (amount == null || amount <= 0) {
      _snack('Weka kiasi cha malipo.', error: true);
      return;
    }
    try {
      await AppState.instance.api.post('/field-partners/my-loans/$id/repay', {'amount': amount});
      if (!mounted) return;
      _snack('Umelipa mkopo kwa mafanikio.');
      _selfAmt.clear();
      await _load();
    } on ApiException catch (e) {
      _snack(e.message, error: true);
    }
  }

  Future<void> _createLoan() async {
    final borrower = int.tryParse(_borrowerId.text.trim());
    final amount = num.tryParse(_loanAmount.text.trim());
    if (borrower == null || amount == null || amount <= 0) {
      _snack('Weka Borrower user ID na kiasi halali.', error: true);
      return;
    }
    if (_isStaff && _selected.isEmpty) {
      _snack('Chagua mshirika kwanza.', error: true);
      return;
    }
    setState(() => _busy = true);
    try {
      await AppState.instance.api.post('/field-partners/loans', {
        if (_isStaff) 'partnerId': int.tryParse(_selected),
        'borrowerUserId': borrower,
        'amount': amount,
        'interestRate': num.tryParse(_rate.text.trim()) ?? 0,
        'termMonths': int.tryParse(_term.text.trim()) ?? 12,
        'purpose': _purpose.text.trim().isEmpty ? 'GENERAL' : _purpose.text.trim(),
      });
      if (!mounted) return;
      _snack('Mkopo umeanzishwa.');
      _borrowerId.clear();
      _loanAmount.clear();
      _rate.text = '0';
      _term.text = '12';
      _purpose.text = 'GENERAL';
      await _load();
    } on ApiException catch (e) {
      _snack(e.message, error: true);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    if (_loading) return const Center(child: CircularProgressIndicator());
    return RefreshIndicator(
      onRefresh: _load,
      child: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          Text('Mashirika ya Uga', style: Theme.of(context).textTheme.headlineSmall),
          Text('Mikopo kupitia mashirika ya uga (mfumo wa Kiva).',
              style: TextStyle(color: Colors.grey.shade600)),
          const SizedBox(height: 16),
          if (_console) ...[_consoleCard(), const SizedBox(height: 12)],
          _myLoansCard(),
        ],
      ),
    );
  }

  Widget _consoleCard() {
    final s = _mySummary;
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text('Kitabu cha Uga', style: const TextStyle(fontWeight: FontWeight.w700)),
            const SizedBox(height: 10),
            if (_isStaff) ...[
              DropdownButtonFormField<String>(
                initialValue: _selected.isEmpty ? null : _selected,
                hint: const Text('Chagua mshirika...'),
                items: _partners.map<DropdownMenuItem<String>>((p) => DropdownMenuItem<String>(
                  value: '${p['id']}',
                  child: Text('${p['name']} (${p['risk_rating'] ?? '-'})'),
                )).toList(),
                onChanged: (v) {
                  setState(() => _selected = v ?? '');
                  _loadSelected();
                },
              ),
              const SizedBox(height: 10),
            ],
            if (s != null) ...[
              Wrap(
                spacing: 8,
                runSpacing: 8,
                children: [
                  _statChip('Hazina', formatMoney(s['available_balance'])),
                  _statChip('Mikopo iliyotolewa', '${s['total_loans_facilitated'] ?? 0}'),
                  _statChip('Hai', '${s['active_loans'] ?? 0}'),
                  _statChip('Imelipwa', '${s['repaid_loans'] ?? 0}'),
                  _statChip('Inasubiri', '${s['pending_loans'] ?? 0}'),
                  _statChip('Imekiuka', '${s['defaulted_loans'] ?? 0}'),
                  _statChip('Mkuu uliobaki', formatMoney(s['outstanding_principal'])),
                ],
              ),
              const SizedBox(height: 12),
            ],
            for (final l in _book) _bookLoanTile(l),
            if (_book.isEmpty)
              Padding(
                padding: const EdgeInsets.only(bottom: 8),
                child: Text('Hakuna mikopo bado.', style: TextStyle(color: Colors.grey.shade600)),
              ),
            const Divider(),
            const Text('Anzisha Mkopo', style: TextStyle(fontWeight: FontWeight.w700)),
            const SizedBox(height: 8),
            TextField(
              controller: _borrowerId,
              keyboardType: TextInputType.number,
              decoration: const InputDecoration(labelText: 'Borrower user ID'),
            ),
            const SizedBox(height: 8),
            Row(
              children: [
                Expanded(
                  child: TextField(
                    controller: _loanAmount,
                    keyboardType: TextInputType.number,
                    decoration: const InputDecoration(labelText: 'Kiasi'),
                  ),
                ),
                const SizedBox(width: 8),
                Expanded(
                  child: TextField(
                    controller: _rate,
                    keyboardType: TextInputType.number,
                    decoration: const InputDecoration(labelText: 'Riba %'),
                  ),
                ),
              ],
            ),
            const SizedBox(height: 8),
            Row(
              children: [
                Expanded(
                  child: TextField(
                    controller: _term,
                    keyboardType: TextInputType.number,
                    decoration: const InputDecoration(labelText: 'Muda (miezi)'),
                  ),
                ),
                const SizedBox(width: 8),
                Expanded(
                  child: TextField(
                    controller: _purpose,
                    decoration: const InputDecoration(labelText: 'Kusudi'),
                  ),
                ),
              ],
            ),
            const SizedBox(height: 10),
            FilledButton(onPressed: _busy ? null : _createLoan, child: const Text('Anzisha Mkopo')),
          ],
        ),
      ),
    );
  }

  Widget _bookLoanTile(Map<String, dynamic> l) {
    final id = l['id'] as int;
    final status = (l['status'] as String?) ?? '';
    return Card(
      margin: const EdgeInsets.only(bottom: 8),
      color: const Color(0xFFF7F9F8),
      child: Padding(
        padding: const EdgeInsets.all(10),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Expanded(
                  child: Text('${l['loan_reference'] ?? '-'} — ${l['borrower_name'] ?? '-'}',
                      style: const TextStyle(fontWeight: FontWeight.w600, fontSize: 13)),
                ),
                _statusChip(status),
              ],
            ),
            const SizedBox(height: 4),
            Text('Kiasi: ${formatMoney(l['amount'])} | Jumla inayodaiwa: ${formatMoney(l['total_due'])}',
                style: TextStyle(fontSize: 12, color: Colors.grey.shade700)),
            if (status == 'PENDING')
              Align(
                alignment: Alignment.centerRight,
                child: FilledButton.tonal(
                  onPressed: _disbursing == id ? null : () => _disburse(id),
                  child: Text(_disbursing == id ? 'Inatolewa...' : 'Toa Mkopo'),
                ),
              ),
            if (status == 'DISBURSED')
              Row(
                children: [
                  Expanded(
                    child: TextField(
                      controller: _bookAmt.putIfAbsent(id, () => TextEditingController()),
                      keyboardType: TextInputType.number,
                      decoration: const InputDecoration(labelText: 'Malipo'),
                    ),
                  ),
                  const SizedBox(width: 8),
                  FilledButton.tonal(onPressed: () => _bookRepay(id), child: const Text('Lipia')),
                ],
              ),
          ],
        ),
      ),
    );
  }

  Widget _myLoansCard() {
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Text('Mikopo Yangu', style: TextStyle(fontWeight: FontWeight.w700)),
            const SizedBox(height: 4),
            if (_myLoans.isEmpty)
              Text('Huna mikopo ya kigauni bado.', style: TextStyle(color: Colors.grey.shade600)),
            for (final l in _myLoans) _myLoanTile(l),
          ],
        ),
      ),
    );
  }

  Widget _myLoanTile(Map<String, dynamic> l) {
    final id = l['id'] as int;
    final status = (l['status'] as String?) ?? '';
    return Card(
      margin: const EdgeInsets.only(top: 8),
      color: const Color(0xFFFFFBEA),
      child: Padding(
        padding: const EdgeInsets.all(10),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Expanded(
                  child: Text('${l['partner_name'] ?? '-'} — ${l['loan_reference'] ?? '-'}',
                      style: const TextStyle(fontWeight: FontWeight.w600, fontSize: 13)),
                ),
                _statusChip(status),
              ],
            ),
            const SizedBox(height: 4),
            Text('Kiasi: ${formatMoney(l['amount'])} | Jumla: ${formatMoney(l['total_due'])}',
                style: TextStyle(fontSize: 12, color: Colors.grey.shade700)),
            if (status == 'DISBURSED') ...[
              const SizedBox(height: 8),
              Row(
                children: [
                  Expanded(
                    child: TextField(
                      controller: _selfAmt,
                      keyboardType: TextInputType.number,
                      decoration: const InputDecoration(labelText: 'Kiasi cha malipo'),
                    ),
                  ),
                  const SizedBox(width: 8),
                  FilledButton.tonal(onPressed: () => _selfRepay(id), child: const Text('Lipia (self)')),
                ],
              ),
            ],
          ],
        ),
      ),
    );
  }

  Widget _statChip(String label, String value) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
      decoration: BoxDecoration(
        color: const Color(0xFFEDF4F0),
        borderRadius: BorderRadius.circular(8),
      ),
      child: RichText(
        text: TextSpan(
          style: TextStyle(fontSize: 11.5, color: Colors.grey.shade800),
          children: [
            TextSpan(text: '$label: '),
            TextSpan(text: value, style: const TextStyle(fontWeight: FontWeight.w700)),
          ],
        ),
      ),
    );
  }

  Widget _statusChip(String status) {
    final color = switch (status) {
      'DISBURSED' || 'REPAID' => const Color(0xFF0B7A41),
      'PENDING' => Colors.orange,
      'DEFAULTED' => Colors.red,
      _ => Colors.blueGrey,
    };
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
      decoration: BoxDecoration(color: color.withValues(alpha: .12), borderRadius: BorderRadius.circular(6)),
      child: Text(status, style: TextStyle(fontSize: 10.5, fontWeight: FontWeight.w700, color: color)),
    );
  }
}