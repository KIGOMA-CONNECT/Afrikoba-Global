import 'package:flutter/material.dart';
import '../core/app_state.dart';
import '../core/api_client.dart';
import '../core/format.dart';
import '../widgets/status_badge.dart';

const _providers = ['Mpesa', 'Tigo', 'Airtel', 'Halopesa'];

/// Wallet - salio, deposit (USSD push), transfer, withdrawal na historia.
class WalletScreen extends StatefulWidget {
  const WalletScreen({super.key});

  @override
  State<WalletScreen> createState() => _WalletScreenState();
}

class _WalletScreenState extends State<WalletScreen> {
  Map<String, dynamic>? _balance;
  List<Map<String, dynamic>> _txs = [];
  bool _loading = true;

  final _amountCtrl = TextEditingController();
  final _toPhoneCtrl = TextEditingController();
  final _noteCtrl = TextEditingController();
  String _provider = 'Mpesa';
  bool _busy = false;

  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void dispose() {
    _amountCtrl.dispose();
    _toPhoneCtrl.dispose();
    _noteCtrl.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    final api = AppState.instance.api;
    try {
      final b = await api.get('/wallet/balance');
      final t = await api.get('/wallet/transactions');
      if (mounted) {
        setState(() {
          _balance = b['balance'] as Map<String, dynamic>;
          _txs = (t['transactions'] as List).cast<Map<String, dynamic>>();
          _loading = false;
        });
      }
    } catch (_) {
      if (mounted) setState(() => _loading = false);
    }
  }

  void _toast(String msg, {bool ok = true}) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(content: Text(msg), backgroundColor: ok ? Colors.green : Colors.red),
    );
  }

  Future<void> _deposit() async {
    setState(() => _busy = true);
    try {
      final res = await AppState.instance.api
          .post('/wallet/deposit/initiate', {'amount': double.parse(_amountCtrl.text), 'provider': _provider});
      _toast('${res['message']} (Kutoka: ${formatMoney(res['totalCharged'])})');
      _amountCtrl.clear();
      await _load();
    } on ApiException catch (e) {
      _toast(e.message, ok: false);
    } catch (_) {
      _toast('Hitilafu.', ok: false);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _transfer() async {
    setState(() => _busy = true);
    try {
      final res = await AppState.instance.api.post('/wallet/transfer', {
        'toPhoneNumber': _toPhoneCtrl.text.trim(),
        'amount': double.parse(_amountCtrl.text),
        'note': _noteCtrl.text.trim(),
      });
      _toast('${res['message']}');
      _amountCtrl.clear();
      _toPhoneCtrl.clear();
      _noteCtrl.clear();
      await _load();
    } on ApiException catch (e) {
      _toast(e.message, ok: false);
    } catch (_) {
      _toast('Hitilafu. Hakikisha kiasi ni sahihi.', ok: false);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _withdraw() async {
    if (_amountCtrl.text.isEmpty) {
      _toast('Weka kiasi cha kutoa.', ok: false);
      return;
    }
    setState(() => _busy = true);
    try {
      final res = await AppState.instance.api
          .post('/wallet/withdraw', {'amount': double.parse(_amountCtrl.text), 'provider': _provider});
      _toast('${res['message']}');
      _amountCtrl.clear();
      await _load();
    } on ApiException catch (e) {
      _toast(e.message, ok: false);
    } catch (_) {
      _toast('Hitilafu.', ok: false);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    if (_loading) return const Center(child: CircularProgressIndicator());
    final b = _balance ?? {};
    return RefreshIndicator(
      onRefresh: _load,
      child: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          Row(
            children: [
              Expanded(child: _statCard('Salio', formatMoney(b['wallet_balance']), const Color(0xFF0B7A41))),
              const SizedBox(width: 10),
              Expanded(child: _statCard('Imefungwa', formatMoney(b['locked_balance']), const Color(0xFF155E9C))),
            ],
          ),
          const SizedBox(height: 16),
          _depositCard(),
          const SizedBox(height: 12),
          _transferCard(),
          const SizedBox(height: 12),
          _withdrawCard(),
          const SizedBox(height: 20),
          const Text('Historia ya Miamala', style: TextStyle(fontWeight: FontWeight.w700, fontSize: 16)),
          const SizedBox(height: 8),
          Card(
            child: _txs.isEmpty
                ? const Padding(padding: EdgeInsets.all(16), child: Text('Hakuna miamala bado.'))
                : Column(
                    children: _txs.map((t) => ListTile(
                      dense: true,
                      title: Text('${t['type']} · ${t['reference_id']}',
                          style: const TextStyle(fontSize: 13)),
                      subtitle: Text(formatDate(t['created_at']?.toString())),
                      trailing: Column(
                        crossAxisAlignment: CrossAxisAlignment.end,
                        mainAxisAlignment: MainAxisAlignment.center,
                        children: [
                          Text(formatMoney(t['wallet_amount']),
                              style: const TextStyle(fontWeight: FontWeight.w600, fontSize: 13)),
                          const SizedBox(height: 2),
                          StatusBadge('${t['status']}'),
                        ],
                      ),
                    )).toList(),
                  ),
          ),
        ],
      ),
    );
  }

  Widget _statCard(String label, String value, Color color) {
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(14),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(value, style: TextStyle(fontSize: 16, fontWeight: FontWeight.w800, color: color)),
            Text(label, style: TextStyle(fontSize: 12, color: Colors.grey.shade600)),
          ],
        ),
      ),
    );
  }

  Widget _sectionCard(String title, List<Widget> children) {
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(title, style: const TextStyle(fontWeight: FontWeight.w700, fontSize: 15)),
            const SizedBox(height: 12),
            ...children,
          ],
        ),
      ),
    );
  }

  Widget _providerDropdown() {
    return DropdownButtonFormField<String>(
      initialValue: _provider,
      decoration: const InputDecoration(labelText: 'Mtandao'),
      items: _providers.map((p) => DropdownMenuItem(value: p, child: Text(p))).toList(),
      onChanged: (v) => setState(() => _provider = v ?? 'Mpesa'),
    );
  }

  Widget _depositCard() {
    return _sectionCard('Weka Fedha (Deposit - USSD Push)', [
      TextField(
        controller: _amountCtrl,
        keyboardType: TextInputType.number,
        decoration: const InputDecoration(labelText: 'Kiasi (TZS)', prefixText: 'TZS '),
      ),
      const SizedBox(height: 10),
      _providerDropdown(),
      const SizedBox(height: 12),
      FilledButton(
        onPressed: _busy ? null : _deposit,
        child: Text(_busy ? 'Inachakata...' : 'Tuma Prompt'),
      ),
      const SizedBox(height: 6),
      const Text('Ada ya mfumo (1% Add-on) inakatwa juu ya kiasi. Mfano: Weka 100,000 → utatozwa 101,000.',
          style: TextStyle(fontSize: 11, color: Colors.grey)),
    ]);
  }

  Widget _transferCard() {
    return _sectionCard('Hamisha (Transfer kwa Mteja Mwingine)', [
      TextField(
        controller: _toPhoneCtrl,
        keyboardType: TextInputType.phone,
        decoration: const InputDecoration(labelText: 'Namba ya Mpokeaji', hintText: '255713000000'),
      ),
      const SizedBox(height: 10),
      TextField(
        controller: _amountCtrl,
        keyboardType: TextInputType.number,
        decoration: const InputDecoration(labelText: 'Kiasi', prefixText: 'TZS '),
      ),
      const SizedBox(height: 10),
      TextField(
        controller: _noteCtrl,
        decoration: const InputDecoration(labelText: 'Ujumbe (si lazima)'),
      ),
      const SizedBox(height: 12),
      FilledButton(
        onPressed: _busy ? null : _transfer,
        child: Text(_busy ? 'Inachakata...' : 'Hamisha'),
      ),
    ]);
  }

  Widget _withdrawCard() {
    return _sectionCard('Toa Fedha (Withdrawal kwenda Simu)', [
      TextField(
        controller: _amountCtrl,
        keyboardType: TextInputType.number,
        decoration: const InputDecoration(labelText: 'Kiasi (TZS)', prefixText: 'TZS '),
      ),
      const SizedBox(height: 10),
      _providerDropdown(),
      const SizedBox(height: 12),
      FilledButton(
        onPressed: _busy ? null : _withdraw,
        child: Text(_busy ? 'Inachakata...' : 'Tuma Ombi la Kutoa'),
      ),
    ]);
  }
}
