import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import '../core/app_state.dart';
import '../core/format.dart';

class ReferralsScreen extends StatefulWidget {
  const ReferralsScreen({super.key});

  @override
  State<ReferralsScreen> createState() => _ReferralsScreenState();
}

class _ReferralsScreenState extends State<ReferralsScreen> {
  Map<String, dynamic>? _stats;
  bool _loading = true;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() => _loading = true);
    try {
      final r = await AppState.instance.api.get('/referrals/my-code');
      if (mounted) {
        setState(() {
          _stats = r;
          _loading = false;
        });
      }
    } catch (_) {
      if (mounted) setState(() => _loading = false);
    }
  }

  Future<void> _copyCode() async {
    final code = _stats?['code'] ?? '';
    await Clipboard.setData(ClipboardData(text: code));
    if (mounted) {
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text('Msimbo $code umenakiliwa!')),
      );
    }
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
                Text('Referrals', style: Theme.of(context).textTheme.headlineSmall),
                Text('Alta rafiki, pata zawadi',
                    style: TextStyle(color: Colors.grey.shade600)),
                const SizedBox(height: 16),
                Card(
                  child: Padding(
                    padding: const EdgeInsets.all(20),
                    child: Column(
                      children: [
                        const Text('Msimbo Wako', style: TextStyle(fontSize: 12, color: Colors.grey)),
                        const SizedBox(height: 4),
                        Text(_stats?['code'] ?? '...',
                            style: const TextStyle(fontSize: 28, fontWeight: FontWeight.w800, color: Color(0xFF0B7A41))),
                        const SizedBox(height: 8),
                        Row(
                          mainAxisAlignment: MainAxisAlignment.center,
                          children: [
                            OutlinedButton.icon(
                              onPressed: _copyCode,
                              icon: const Icon(Icons.copy, size: 16),
                              label: const Text('Nakili'),
                            ),
                          ],
                        ),
                      ],
                    ),
                  ),
                ),
                const SizedBox(height: 12),
                Row(
                  children: [
                    Expanded(child: _statCard('Rafiki', '${_stats?['totalReferrals'] ?? 0}', Icons.people)),
                    const SizedBox(width: 10),
                    Expanded(child: _statCard('Zawadi', formatMoney(_stats?['totalEarned'] ?? 0), Icons.card_giftcard)),
                  ],
                ),
                const SizedBox(height: 16),
                Card(
                  child: Padding(
                    padding: const EdgeInsets.all(16),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        const Text('Jinsi ya Kufanya Kazi', style: TextStyle(fontWeight: FontWeight.w700)),
                        const SizedBox(height: 8),
                        _step(1, 'Shiriki msimbo wako na rafiki'),
                        _step(2, 'Rafiki ajiunge na Afrikoba kwa msimbo'),
                        _step(3, 'Rafiki aweka fedha (min TSh 10,000)'),
                        _step(4, 'Unapata TSh 5,000 zawadi!'),
                      ],
                    ),
                  ),
                ),
                const SizedBox(height: 16),
                const Text('Rafiki Waliyoalitwa',
                    style: TextStyle(fontWeight: FontWeight.w700, fontSize: 16)),
                const SizedBox(height: 8),
                ...(_stats?['referrals'] as List? ?? []).map((r) => Card(
                  margin: const EdgeInsets.only(bottom: 8),
                  child: ListTile(
                    leading: CircleAvatar(child: Text((r['referred_name'] ?? '?')[0])),
                    title: Text(r['referred_name'] ?? ''),
                    subtitle: Text(r['status'] ?? ''),
                    trailing: r['reward_amount'] > 0
                        ? Text(formatMoney(r['reward_amount']),
                            style: const TextStyle(color: Color(0xFF0B7A41), fontWeight: FontWeight.w700))
                        : null,
                  ),
                )),
                if ((_stats?['referrals'] as List? ?? []).isEmpty)
                  Card(
                    child: Padding(
                      padding: const EdgeInsets.all(24),
                      child: Center(
                        child: Text('Hujafanikiwa kualta rafiki bado.',
                            style: TextStyle(color: Colors.grey.shade500)),
                      ),
                    ),
                  ),
              ],
            ),
    );
  }

  Widget _statCard(String label, String value, IconData icon) {
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          children: [
            Icon(icon, color: const Color(0xFF0B7A41)),
            const SizedBox(height: 8),
            Text(value, style: const TextStyle(fontSize: 20, fontWeight: FontWeight.w800)),
            Text(label, style: TextStyle(fontSize: 11, color: Colors.grey.shade600)),
          ],
        ),
      ),
    );
  }

  Widget _step(int num, String text) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 6),
      child: Row(
        children: [
          CircleAvatar(
            radius: 12,
            backgroundColor: const Color(0xFF0B7A41).withValues(alpha: .15),
            child: Text('$num', style: const TextStyle(fontSize: 12, color: Color(0xFF0B7A41))),
          ),
          const SizedBox(width: 10),
          Expanded(child: Text(text, style: const TextStyle(fontSize: 13))),
        ],
      ),
    );
  }
}
