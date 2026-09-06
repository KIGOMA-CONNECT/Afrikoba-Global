import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import '../core/app_state.dart';
import '../core/api_client.dart';
import '../core/format.dart';
import '../widgets/status_badge.dart';

/// Vaults / Spaces - akiba yenye lengo (Monzo-style targeted savings).
/// Kuunda vault, kuweka (deposit) na kutoa (withdraw), maendeleo kuelekea
/// lengo, plus fixed (locked) deposits.
class VaultScreen extends StatefulWidget {
  const VaultScreen({super.key});

  @override
  State<VaultScreen> createState() => _VaultScreenState();
}

class _VaultScreenState extends State<VaultScreen> {
  List<Map<String, dynamic>> _vaults = [];
  List<Map<String, dynamic>> _deposits = [];
  Map<String, dynamic>? _summary;
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
      final v = await api.get('/vaults');
      final s = await api.get('/vaults/summary');
      Map<String, dynamic> d = {};
      try { d = await api.get('/vaults/deposits'); } catch (_) {}
      if (!mounted) return;
      setState(() {
        _vaults = (v['vaults'] as List? ?? []).cast<Map<String, dynamic>>();
        _deposits = (d['deposits'] as List? ?? []).cast<Map<String, dynamic>>();
        _summary = s['summary'] as Map<String, dynamic>?;
        _loading = false;
      });
    } on ApiException catch (e) {
      if (!mounted) return;
      setState(() => _loading = false);
      _toast(e.message, error: true);
    } catch (_) {
      if (!mounted) return;
      setState(() => _loading = false);
    }
  }

  Future<void> _createVault() async {
    final nameCtl = TextEditingController();
    final targetCtl = TextEditingController();
    final saved = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Vault Mpya / Lengo la Akiba'),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            TextField(
              controller: nameCtl,
              decoration: const InputDecoration(labelText: 'Jina (Mf: Ziara, Shule, Kipindi...)', border: OutlineInputBorder()),
            ),
            const SizedBox(height: 12),
            TextField(
              controller: targetCtl,
              keyboardType: const TextInputType.numberWithOptions(decimal: true),
              inputFormatters: [FilteringTextInputFormatter.allow(RegExp(r'[0-9.]'))],
              decoration: const InputDecoration(labelText: 'Lengo (TZS)', border: OutlineInputBorder()),
            ),
          ],
        ),
        actions: [
          TextButton(onPressed: () => Navigator.of(ctx).pop(false), child: const Text('Ghairi')),
          FilledButton(
            onPressed: () => Navigator.of(ctx).pop(true),
            child: const Text('Unda'),
          ),
        ],
      ),
    );
    if (saved != true) return;
    final target = double.tryParse(targetCtl.text.trim());
    final name = nameCtl.text.trim();
    if (target == null || target <= 0 || name.isEmpty) {
      _toast('Jina na lengo sahihi zinahitajika.', error: true);
      return;
    }
    try {
      await AppState.instance.api.post('/vaults', {'name': name, 'target_amount': targetCtl.text.trim()});
      if (!mounted) return;
      _toast('Vault imeundwa.');
      await _load();
    } on ApiException catch (e) {
      _toast(e.message, error: true);
    }
  }

  Future<void> _deposit(Map<String, dynamic> vault) async {
    final amountCtl = TextEditingController();
    final saved = await _amountDialog('Weka Akiba', 'Kiasi cha kuweka kwenye "${vault['name']}"', amountCtl);
    if (saved != true) return;
    final amt = double.tryParse(amountCtl.text.trim());
    if (amt == null || amt <= 0) {
      _toast('Kiasi sahihi kinahitajika.', error: true);
      return;
    }
    try {
      await AppState.instance.api.post('/vaults/${vault['id']}/deposit', {'amount': amountCtl.text.trim()});
      if (!mounted) return;
      _toast('Akiba imewekwa.');
      await _load();
    } on ApiException catch (e) {
      _toast(e.message, error: true);
    }
  }

  Future<void> _withdraw(Map<String, dynamic> vault) async {
    final amountCtl = TextEditingController();
    final saved = await _amountDialog('Toa Akiba', 'Kiasi cha kutoa kwenye "${vault['name']}"', amountCtl);
    if (saved != true) return;
    final amt = double.tryParse(amountCtl.text.trim());
    if (amt == null || amt <= 0) {
      _toast('Kiasi sahihi kinahitajika.', error: true);
      return;
    }
    try {
      await AppState.instance.api.post('/vaults/${vault['id']}/withdraw', {'amount': amountCtl.text.trim()});
      if (!mounted) return;
      _toast('Akiba imetolewa.');
      await _load();
    } on ApiException catch (e) {
      _toast(e.message, error: true);
    }
  }

  Future<bool?> _amountDialog(String title, String prompt, TextEditingController ctl) {
    return showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: Text(title),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Text(prompt),
            const SizedBox(height: 12),
            TextField(
              controller: ctl,
              keyboardType: const TextInputType.numberWithOptions(decimal: true),
              inputFormatters: [FilteringTextInputFormatter.allow(RegExp(r'[0-9.]'))],
              decoration: const InputDecoration(labelText: 'Kiasi (TZS)', border: OutlineInputBorder()),
            ),
          ],
        ),
        actions: [
          TextButton(onPressed: () => Navigator.of(ctx).pop(false), child: const Text('Ghairi')),
          FilledButton(onPressed: () => Navigator.of(ctx).pop(true), child: const Text('Hifadhi')),
        ],
      ),
    );
  }

  void _toast(String msg, {bool error = false}) {
    if (!mounted) return;
    ScaffoldMessenger.of(context)
        .showSnackBar(SnackBar(content: Text(msg), backgroundColor: error ? Colors.red : null));
  }

  @override
  Widget build(BuildContext context) {
    final saved = _summary?['total_saved'] is num ? _summary!['total_saved'] : 0;
    final target = _summary?['total_target'] is num ? _summary!['total_target'] : 0;
    return RefreshIndicator(
      onRefresh: _load,
      child: _loading
          ? const Center(child: CircularProgressIndicator())
          : ListView(
              padding: const EdgeInsets.all(16),
              children: [
                _summaryCard(saved, target),
                const SizedBox(height: 12),
                Row(
                  children: [
                    const Expanded(
                        child: Text('Vaults Zangu',
                            style: TextStyle(fontWeight: FontWeight.w700, fontSize: 16))),
                    FilledButton.icon(
                      onPressed: _createVault,
                      icon: const Icon(Icons.add, size: 18),
                      label: const Text('Vault Mpya'),
                    ),
                  ],
                ),
                const SizedBox(height: 8),
                if (_vaults.isEmpty)
                  Padding(
                    padding: const EdgeInsets.symmetric(vertical: 16),
                    child: Text('Hakuna vault bado. Unda lengo la akiba kuichukua.',
                        style: TextStyle(color: Colors.grey.shade600)),
                  )
                else
                  for (final v in _vaults) _vaultCard(v),
                if (_deposits.isNotEmpty) ...[
                  const SizedBox(height: 16),
                  const Text('Fixed Deposits (Zimefungwa)',
                      style: TextStyle(fontWeight: FontWeight.w700, fontSize: 16)),
                  const SizedBox(height: 8),
                  for (final d in _deposits) _depositCard(d),
                ],
              ],
            ),
    );
  }

  Widget _summaryCard(num saved, num target) {
    final pct = target > 0 ? (saved / target * 100).clamp(0, 100) : 0;
    return Card(
      color: const Color(0xFFF2FAF4),
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text('Jumla ya Akiba', style: TextStyle(color: Colors.grey.shade700, fontSize: 12.5)),
            Text(formatMoney(saved),
                style: const TextStyle(fontSize: 26, fontWeight: FontWeight.w800, color: Color(0xFF0B7A41))),
            const SizedBox(height: 8),
            LinearProgressIndicator(value: pct / 100, backgroundColor: Colors.green.shade100),
            const SizedBox(height: 6),
            Text('${pct.toStringAsFixed(0)}% ya lengo ${formatMoney(target)}   •   ${_summary?['total_goals'] ?? 0} vaults (${_summary?['completed'] ?? 0} zimekamilika)',
                style: TextStyle(fontSize: 12, color: Colors.grey.shade700)),
          ],
        ),
      ),
    );
  }

  Widget _vaultCard(Map<String, dynamic> v) {
    final current = v['current_amount'] is num ? v['current_amount'] : 0;
    final target = v['target_amount'] is num ? v['target_amount'] : 0;
    final done = v['is_completed'] == true;
    final pct = target > 0 ? (current / target * 100).clamp(0, 100) : 0;
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(14),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Icon(Icons.savings_outlined, color: Color(0xFF0B7A41)),
                const SizedBox(width: 8),
                Expanded(
                  child: Text('${v['name']}',
                      style: const TextStyle(fontWeight: FontWeight.w700, fontSize: 15)),
                ),
                StatusBadge(done ? 'IMEMALIZIKA' : 'MAENDELEO'),
              ],
            ),
            const SizedBox(height: 10),
            Row(
              children: [
                Text(formatMoney(current), style: const TextStyle(fontWeight: FontWeight.w800)),
                const Spacer(),
                Text(formatMoney(target), style: TextStyle(color: Colors.grey.shade600, fontSize: 12.5)),
              ],
            ),
            const SizedBox(height: 6),
            LinearProgressIndicator(value: pct / 100, backgroundColor: Colors.grey.shade200),
            const SizedBox(height: 4),
            Text('${pct.toStringAsFixed(0)}% ya lengo', style: TextStyle(fontSize: 11.5, color: Colors.grey.shade600)),
            const SizedBox(height: 8),
            Row(
              mainAxisAlignment: MainAxisAlignment.end,
              children: [
                if (!done)
                  FilledButton.tonal(
                    onPressed: () => _deposit(v),
                    child: const Text('Weka Akiba'),
                  ),
                const SizedBox(width: 8),
                if (current > 0)
                  OutlinedButton(
                    onPressed: () => _withdraw(v),
                    child: const Text('Toa'),
                  ),
              ],
            ),
          ],
        ),
      ),
    );
  }

  Widget _depositCard(Map<String, dynamic> d) {
    return Card(
      child: ListTile(
        leading: const Icon(Icons.lock_outline, color: Color(0xFF155E9C)),
        title: Text(formatMoney(d['amount'] ?? d['principal'])),
        subtitle: Text(
            'Muda: ${d['tenure_months'] ?? d['duration'] ?? ''} miezi   •   ${formatDate(d['created_at'])}'),
        trailing: StatusBadge((d['status'] ?? 'ACTIVE').toString()),
      ),
    );
  }
}