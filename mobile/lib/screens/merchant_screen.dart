import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import '../core/app_state.dart';
import '../core/api_client.dart';
import '../core/format.dart';
import '../widgets/status_badge.dart';

/// Mfanyabiashara - akaunti iliyounganishwa (connected), malipo na malimbikizo.
/// Parody ya sehemu ya Merchant kwenye dashboard ya web (payouts + settlements).
class MerchantScreen extends StatefulWidget {
  const MerchantScreen({super.key});

  @override
  State<MerchantScreen> createState() => _MerchantScreenState();
}

class _MerchantScreenState extends State<MerchantScreen> {
  Map<String, dynamic>? _merchant;
  Map<String, dynamic>? _account;
  List<Map<String, dynamic>> _payouts = [];
  bool _loading = true;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() => _loading = true);
    final api = AppState.instance.api;
    try {
      final conn = await api.get('/merchant/connected');
      final payouts = await api.get('/merchant/payouts');
      if (!mounted) return;
      setState(() {
        _merchant = conn['merchant'] as Map<String, dynamic>?;
        _account = conn['account'] as Map<String, dynamic>?;
        _payouts = (payouts['payouts'] as List? ?? []).cast<Map<String, dynamic>>();
        _loading = false;
      });
    } on ApiException catch (e) {
      if (!mounted) return;
      setState(() => _loading = false);
      ScaffoldMessenger.of(context)
          .showSnackBar(SnackBar(content: Text(e.message), backgroundColor: Colors.red));
    } catch (_) {
      if (!mounted) return;
      setState(() => _loading = false);
    }
  }

  String get _accountStatus => (_account?['status'] ?? 'NONE').toString();
  bool get _canSettle => _accountStatus == 'ACTIVE';

  Future<void> _registerMerchant() async {
    final nameCtl = TextEditingController();
    final phoneCtl = TextEditingController();
    final businessCtl = TextEditingController();
    final saved = await showDialog<bool>(
      context: context,
      builder: (ctx) => _formDialog(
        title: 'Sajili Biashara',
        children: [
          _field(nameCtl, 'Jina la Biashara'),
          _field(phoneCtl, 'Namba ya Simu', keyboard: TextInputType.phone),
          _field(businessCtl, 'Aina ya Biashara', hint: 'Mf. MADUKA, MASHAMBA, MITANDAO...'),
        ],
        onSubmit: () => Navigator.of(ctx).pop(true),
      ),
    );
    if (saved != true) return;
    try {
      await AppState.instance.api.post('/merchant/register', {
        'name': nameCtl.text.trim(),
        'phone': phoneCtl.text.trim(),
        'business_type': businessCtl.text.trim().isEmpty ? 'OTHER' : businessCtl.text.trim().toUpperCase(),
      });
      if (!mounted) return;
      ScaffoldMessenger.of(context)
          .showSnackBar(const SnackBar(content: Text('Biashara imesajiliwa.')));
      await _load();
    } on ApiException catch (e) {
      _toast(e.message, error: true);
    }
  }

  Future<void> _connectAccount() async {
    final type = _account?['payout_type'] ?? 'MNO_PHONE';
    final refCtl = TextEditingController(text: _account?['payout_reference'] ?? '');
    final bankCtl = TextEditingController(text: _account?['bank_name'] ?? '');
    final holderCtl = TextEditingController(text: _account?['account_holder'] ?? '');
    String selectedType = type.toString();
    final saved = await showDialog<bool>(
      context: context,
      builder: (ctx) => StatefulBuilder(
        builder: (ctx, setDlg) {
          return AlertDialog(
            title: Text(_account == null ? 'Sajili Akaunti ya Payout' : 'Sasisha Akaunti ya Payout'),
            content: SingleChildScrollView(
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  DropdownButtonFormField<String>(
                    initialValue: selectedType,
                    decoration: const InputDecoration(labelText: 'Njia ya Malipo'),
                    items: const [
                      DropdownMenuItem(value: 'MNO_PHONE', child: Text('Namba ya Simu (M-Pesa/Tigo)')),
                      DropdownMenuItem(value: 'BANK', child: Text('Benki')),
                    ],
                    onChanged: (v) => setDlg(() => selectedType = v ?? 'MNO_PHONE'),
                  ),
                  const SizedBox(height: 12),
                  _field(refCtl, selectedType == 'BANK' ? 'Namba ya Akaunti ya Benki' : 'Namba ya Simu'),
                  if (selectedType == 'BANK') ...[
                    const SizedBox(height: 12),
                    _field(bankCtl, 'Jina la Benki'),
                    const SizedBox(height: 12),
                    _field(holderCtl, 'Jina la Mwenye Akaunti'),
                  ],
                  const SizedBox(height: 8),
                  const Text(
                      'Utakaposajili upya, akaunti itarejea PENDING hadi ikaguliwe na admin.',
                      style: TextStyle(fontSize: 12, color: Colors.grey)),
                ],
              ),
            ),
            actions: [
              TextButton(onPressed: () => Navigator.of(ctx).pop(false), child: const Text('Ghairi')),
              FilledButton(onPressed: () => Navigator.of(ctx).pop(true), child: const Text('Hifadhi')),
            ],
          );
        },
      ),
    );
    if (saved != true) return;
    try {
      await AppState.instance.api.post('/merchant/connected', {
        'payout_type': selectedType,
        'payout_reference': refCtl.text.trim(),
        if (selectedType == 'BANK') 'bank_name': bankCtl.text.trim(),
        if (selectedType == 'BANK') 'account_holder': holderCtl.text.trim(),
      });
      if (!mounted) return;
      ScaffoldMessenger.of(context)
          .showSnackBar(const SnackBar(content: Text('Akaunti imehifadhiwa (sasa PENDING).')));
      await _load();
    } on ApiException catch (e) {
      _toast(e.message, error: true);
    }
  }

  Future<void> _requestPayout() async {
    if (!_canSettle) {
      _toast('Akaunti ya payout haijaamilishwa. Subiri ukaguzi wa admin.', error: true);
      return;
    }
    final amountCtl = TextEditingController();
    final saved = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Omba Malipo (Settlement)'),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Text('Salio lililofungwa: ${formatMoney(_account?['balance'])}'),
            const SizedBox(height: 12),
            TextField(
              controller: amountCtl,
              keyboardType: const TextInputType.numberWithOptions(decimal: true),
              inputFormatters: [FilteringTextInputFormatter.allow(RegExp(r'[0-9.]'))],
              decoration: const InputDecoration(labelText: 'Kiasi (TZS)', border: OutlineInputBorder()),
            ),
          ],
        ),
        actions: [
          TextButton(onPressed: () => Navigator.of(ctx).pop(false), child: const Text('Ghairi')),
          FilledButton(onPressed: () => Navigator.of(ctx).pop(true), child: const Text('Tuma')), 
        ],
      ),
    );
    if (saved != true) return;
    final amount = double.tryParse(amountCtl.text.trim());
    if (amount == null || amount <= 0) {
      _toast('Andika kiasi sahihi.', error: true);
      return;
    }
    try {
      await AppState.instance.api.post('/merchant/payouts', {'amount': amountCtl.text.trim()});
      if (!mounted) return;
      ScaffoldMessenger.of(context)
          .showSnackBar(const SnackBar(content: Text('Malipo yameombwa (PENDING).')));
      await _load();
    } on ApiException catch (e) {
      _toast(e.message, error: true);
    }
  }

  Widget _field(TextEditingController c, String label,
      {TextInputType? keyboard, String? hint}) {
    return TextField(
      controller: c,
      keyboardType: keyboard,
      decoration: InputDecoration(labelText: label, hintText: hint, border: const OutlineInputBorder()),
    );
  }

  AlertDialog _formDialog(
      {required String title, required List<Widget> children, required VoidCallback onSubmit}) {
    return AlertDialog(
      title: Text(title),
      content: SingleChildScrollView(
        child: Column(mainAxisSize: MainAxisSize.min, children: children),
      ),
      actions: [
        TextButton(onPressed: () => Navigator.of(context).pop(false), child: const Text('Ghairi')),
        FilledButton(onPressed: onSubmit, child: const Text('Hifadhi')),
      ],
    );
  }

  void _toast(String msg, {bool error = false}) {
    if (!mounted) return;
    ScaffoldMessenger.of(context)
        .showSnackBar(SnackBar(content: Text(msg), backgroundColor: error ? Colors.red : null));
  }

  @override
  Widget build(BuildContext context) {
    return RefreshIndicator(
      onRefresh: _load,
      child: _loading
          ? const Center(child: CircularProgressIndicator())
          : ListView(
              padding: const EdgeInsets.all(16),
              children: [
                _profileCard(),
                const SizedBox(height: 16),
                _accountCard(),
                const SizedBox(height: 16),
                if (_canSettle) _settlementCard(),
                const SizedBox(height: 16),
                _historyCard(),
              ],
            ),
    );
  }

  Widget _profileCard() {
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                const Icon(Icons.storefront, color: Color(0xFF0B7A41)),
                const SizedBox(width: 8),
                Text(_merchant?['name'] ?? 'Bado hujasajili biashara',
                    style: const TextStyle(fontWeight: FontWeight.w700, fontSize: 16)),
              ],
            ),
            if (_merchant != null) ...[
              const SizedBox(height: 6),
              Text('Aina: ${_merchant?['business_type'] ?? 'OTHER'}',
                  style: TextStyle(fontSize: 12.5, color: Colors.grey.shade700)),
              Text('Simu: ${_merchant?['phone'] ?? ''}',
                  style: TextStyle(fontSize: 12.5, color: Colors.grey.shade700)),
            ],
            const SizedBox(height: 10),
            SizedBox(
              width: double.infinity,
              child: FilledButton.tonalIcon(
                onPressed: _merchant == null ? _registerMerchant : _connectAccount,
                icon: const Icon(Icons.account_balance_wallet_outlined),
                label: Text(_merchant == null
                    ? 'Sajili Biashara Yako'
                    : (_account == null ? 'Sajili Akaunti ya Payout' : 'Sasisha Akaunti ya Payout')),
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _accountCard() {
    return Card(
      color: const Color(0xFFF2FAF4),
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Text('Malimbiko ya Mauzo',
                style: TextStyle(fontWeight: FontWeight.w700, fontSize: 15)),
            const SizedBox(height: 8),
            Row(
              children: [
                Text(formatMoney(_account?['balance']),
                    style: const TextStyle(fontSize: 22, fontWeight: FontWeight.w800, color: Color(0xFF0B7A41))),
                const Spacer(),
                StatusBadge(_accountStatus == 'NONE' ? 'HAIJAAMILISHWA' : _accountStatus),
              ],
            ),
            if (_account != null) ...[
              const SizedBox(height: 8),
              Row(children: [
                const Icon(Icons.account_balance_outlined,
                    size: 15, color: Color(0xFF155E9C)),
                const SizedBox(width: 4),
                Text('Njia: ${_account?['payout_type'] ?? ''}',
                    style: TextStyle(fontSize: 12.5, color: Colors.grey.shade800)),
              ]),
              if ((_account?['payout_reference'] ?? '').isNotEmpty)
                Text('Rejea: ${_account?['payout_reference']}',
                    style: TextStyle(fontSize: 12.5, color: Colors.grey.shade800)),
            ],
            const SizedBox(height: 8),
            Text(_canSettle
                ? 'Imetengwa: Malipo ya maswala yatapita kwa akaunti hii.'
                : 'Akaunti itapakiwa na admin kabla ya malipo.',
                style: TextStyle(fontSize: 12, color: Colors.grey.shade600)),
          ],
        ),
      ),
    );
  }

  Widget _settlementCard() {
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Row(
          children: [
            const Expanded(
              child: Text('Omba kutolewa kwa malimbiko (settlement)',
                  style: TextStyle(fontWeight: FontWeight.w600)),
            ),
            FilledButton.icon(
              onPressed: _requestPayout,
              icon: const Icon(Icons.payments_outlined),
              label: const Text('Omba Malipo'),
            ),
          ],
        ),
      ),
    );
  }

  Widget _historyCard() {
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Text('Historia ya Malipo', style: TextStyle(fontWeight: FontWeight.w700, fontSize: 15)),
            const SizedBox(height: 6),
            if (_payouts.isEmpty)
              Padding(
                padding: const EdgeInsets.symmetric(vertical: 12),
                child: Text('Hakuna malipo bado.', style: TextStyle(color: Colors.grey.shade600)),
              )
            else
              for (final p in _payouts)
                ListTile(
                  contentPadding: EdgeInsets.zero,
                  dense: true,
                  leading: StatusBadge((p['status'] ?? '').toString()),
                  title: Text(formatMoney(p['gross_amount'] ?? p['amount'])),
                  subtitle: Text(
                      '${formatDate(p['created_at'])}${p['ledger_ref'] != null ? '  •  ${p['ledger_ref']}' : ''}',
                      style: const TextStyle(fontSize: 11.5)),
                ),
          ],
        ),
      ),
    );
  }
}