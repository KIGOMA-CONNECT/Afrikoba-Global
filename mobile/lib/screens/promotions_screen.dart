import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import '../core/app_state.dart';
import '../core/api_client.dart';

const _publicSiteUrl = 'https://afrikoba.com';

/// Matangazo na Promotion - huduma zote kwa ajili ya matangazo ndani na nje ya mfumo.
class PromotionsScreen extends StatefulWidget {
  const PromotionsScreen({super.key});

  @override
  State<PromotionsScreen> createState() => _PromotionsScreenState();
}

class _PromotionsScreenState extends State<PromotionsScreen> {
  List<Map<String, dynamic>> _offers = [];
  List<String> _active = [];
  bool _loading = true;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    final api = AppState.instance.api;
    try {
      final offers = await api.get('/marketing/offers', withAuth: false);
      final catalog = await api.get('/services/catalog');
      final act = (catalog['catalog'] as List)
          .where((c) => c['active'] == true)
          .map((c) => c['key'] as String)
          .toList();
      if (mounted) {
        setState(() {
          _offers = (offers['offers'] as List).cast<Map<String, dynamic>>();
          _active = act;
          _loading = false;
        });
      }
    } catch (_) {
      if (mounted) setState(() => _loading = false);
    }
  }

  String _shareText(Map<String, dynamic> svc) {
    final link = '$_publicSiteUrl/join?service=${svc['key']}';
    final perks = (svc['perks'] as List).map((p) => '• $p').join('\n');
    return '${svc['emoji']} ${svc['swahili']} — AFRIKOBA GLOBAL!\n\n'
        '${svc['tagline']}\n\n$perks\n\nJiunge sasa: $link';
  }

  Future<void> _subscribe(String key) async {
    try {
      await AppState.instance.api.post('/services/subscribe', {'serviceKey': key});
      if (!mounted) return;
      ScaffoldMessenger.of(context)
          .showSnackBar(const SnackBar(content: Text('Umejiunga na huduma hii. Karibu!')));
      await _load();
    } on ApiException catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context)
          .showSnackBar(SnackBar(content: Text(e.message), backgroundColor: Colors.red));
    }
  }

  Future<void> _copyShare(Map<String, dynamic> svc) async {
    final text = _shareText(svc);
    await Clipboard.setData(ClipboardData(text: text));
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(
      content: Text('Ujumbe wa ${svc['swahili']} umenakiliwa — tayari kwa SMS/WhatsApp.'),
    ));
  }

  @override
  Widget build(BuildContext context) {
    if (_loading) return const Center(child: CircularProgressIndicator());
    return ListView(
      padding: const EdgeInsets.all(16),
      children: [
        Text('Matangazo na Promotion', style: Theme.of(context).textTheme.headlineSmall),
        Text('Huduma zote tayari kwa matangazo - ndani na nje ya mfumo.',
            style: TextStyle(color: Colors.grey.shade600)),
        const SizedBox(height: 16),
        for (final svc in _offers) _offerCard(svc),
        const SizedBox(height: 12),
        Card(
          child: Padding(
            padding: const EdgeInsets.all(16),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const Text('Kwa nje ya mfumo (API ya Matangazo)',
                    style: TextStyle(fontWeight: FontWeight.w700)),
                const SizedBox(height: 6),
                Text('GET /api/marketing/offers - salama kwa website, landing pages na adverts.',
                    style: TextStyle(fontSize: 12, color: Colors.grey.shade700)),
                const SizedBox(height: 6),
                const Text('📣 Share: Afrikoba Global - Digital Banking & Upatu.',
                    style: TextStyle(fontSize: 13)),
              ],
            ),
          ),
        ),
      ],
    );
  }

  Widget _offerCard(Map<String, dynamic> svc) {
    final on = _active.contains(svc['key']);
    final comingSoon = svc['comingSoon'] == true;
    return Card(
      child: Container(
        decoration: BoxDecoration(border: Border(top: BorderSide(color: _color(svc), width: 4))),
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Expanded(
                  child: Text('${svc['emoji']} ${svc['swahili']}',
                      style: const TextStyle(fontWeight: FontWeight.w700, fontSize: 15)),
                ),
                Chip(
                  label: Text(on ? 'IMEWASHWA' : 'HAIJAWASHWA',
                      style: TextStyle(fontSize: 11, color: on ? Colors.green.shade800 : Colors.grey.shade700)),
                  backgroundColor: on ? Colors.green.shade50 : Colors.grey.shade200,
                  visualDensity: VisualDensity.compact,
                ),
              ],
            ),
            const SizedBox(height: 6),
            Text('${svc['tagline']}', style: TextStyle(fontStyle: FontStyle.italic, color: _color(svc))),
            const SizedBox(height: 6),
            Text('${svc['description']}', style: TextStyle(fontSize: 12, color: Colors.grey.shade700)),
            const SizedBox(height: 10),
            for (final perk in (svc['perks'] as List)) Text('• $perk', style: const TextStyle(fontSize: 13)),
            const SizedBox(height: 12),
            Row(
              children: [
                if (comingSoon)
                  const Expanded(child: Text('Inakuja hivi karibuni', style: TextStyle(fontSize: 13)))
                else if (on)
                  const Expanded(child: Text('Uko ndani ✓', style: TextStyle(fontSize: 13, color: Colors.green)))
                else
                  Expanded(
                    child: FilledButton(
                      onPressed: () => _subscribe(svc['key'] as String),
                      child: Text('${svc['cta']}'),
                    ),
                  ),
                const SizedBox(width: 8),
                OutlinedButton.icon(
                  onPressed: () => _copyShare(svc),
                  icon: const Icon(Icons.copy, size: 16),
                  label: const Text('Nakili Mwaliko'),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }

  Color _color(Map<String, dynamic> svc) {
    final hex = (svc['color'] as String? ?? '#0B7A41').replaceFirst('#', '');
    return Color(int.parse('FF$hex', radix: 16));
  }
}
