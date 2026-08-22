import 'package:flutter/material.dart';
import '../core/app_state.dart';
import 'dashboard_screen.dart';
import 'wallet_screen.dart';
import 'services_screen.dart';
import 'promotions_screen.dart';
import 'vicoba_screen.dart';
import 'rosca_screen.dart';
import 'p2p_screen.dart';
import 'admin_screen.dart';
import 'login_screen.dart';
import 'notifications_screen.dart';
import 'referrals_screen.dart';
import 'settings_screen.dart';

/// Nyumba ya programu (HomeShell) - drawer kama sidebar ya web.
class HomeScreen extends StatefulWidget {
  const HomeScreen({super.key});

  @override
  State<HomeScreen> createState() => _HomeScreenState();
}

class _HomeScreenState extends State<HomeScreen> {
  int _index = 0;
  bool _isAdmin = false;
  Map<String, dynamic>? _user;

  @override
  void initState() {
    super.initState();
    _loadUser();
  }

  Future<void> _loadUser() async {
    final user = await AppState.instance.session.user();
    setState(() {
      _user = user;
      _isAdmin = user?['role'] == 'ADMIN';
    });
  }

  Future<void> _logout() async {
    await AppState.instance.session.clear();
    if (!mounted) return;
    Navigator.of(context).pushAndRemoveUntil(
      MaterialPageRoute(builder: (_) => const LoginScreen()),
      (route) => false,
    );
  }

  static const _pages = <Widget>[
    DashboardScreen(),
    WalletScreen(),
    ServicesScreen(),
    PromotionsScreen(),
    VicobaScreen(),
    RoscaScreen(),
    P2pScreen(),
    AdminScreen(),
    NotificationsScreen(),
    ReferralsScreen(),
    SettingsScreen(),
  ];

  static const _titles = [
    'DahShabari',
    'Wallet',
    'Huduma Zangu',
    'Matangazo',
    'VICOBA',
    'Upatu (ROSCA)',
    'Uwekezaji (P2P)',
    'Utawala',
    'Arifa',
    'Referrals',
    'Mipangilio',
  ];

  static const _icons = [
    Icons.dashboard_outlined,
    Icons.account_balance_wallet_outlined,
    Icons.grid_view_outlined,
    Icons.campaign_outlined,
    Icons.groups_outlined,
    Icons.sync_alt,
    Icons.trending_up,
    Icons.admin_panel_settings_outlined,
    Icons.notifications_outlined,
    Icons.card_giftcard,
    Icons.settings_outlined,
  ];

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: Text(_titles[_index])),
      drawer: Drawer(
        child: SafeArea(
          child: Column(
            children: [
              DrawerHeader(
                decoration: const BoxDecoration(color: Color(0xFF0B7A41)),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  mainAxisAlignment: MainAxisAlignment.end,
                  children: [
                    const Text('AFRIKOBA GLOBAL',
                        style: TextStyle(fontSize: 20, fontWeight: FontWeight.w800, color: Colors.white)),
                    Text('Digital Banking & Upatu',
                        style: TextStyle(color: Colors.white.withValues(alpha: .85), fontSize: 12)),
                    const SizedBox(height: 12),
                    Row(
                      children: [
                        const CircleAvatar(radius: 18, child: Icon(Icons.person)),
                        const SizedBox(width: 10),
                        Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Text(_user?['full_name'] ?? 'Mtumiaji',
                                style: const TextStyle(color: Colors.white, fontWeight: FontWeight.w600)),
                            Text('${_user?['role'] ?? ''}',
                                style: TextStyle(color: Colors.white.withValues(alpha: .8), fontSize: 11)),
                          ],
                        ),
                      ],
                    ),
                  ],
                ),
              ),
              Expanded(
                child: ListView(
                  children: [
                    for (var i = 0; i < _titles.length; i++)
                      if (!(i == 7 && !_isAdmin))
                        ListTile(
                          leading: Icon(_icons[i]),
                          title: Text(_titles[i]),
                          selected: _index == i,
                          onTap: () {
                            setState(() => _index = i);
                            Navigator.of(context).pop();
                          },
                        ),
                  ],
                ),
              ),
              const Divider(),
              ListTile(
                leading: const Icon(Icons.logout),
                title: const Text('Ondoka (Logout)'),
                onTap: _logout,
              ),
            ],
          ),
        ),
      ),
      body: IndexedStack(index: _index, children: _pages),
    );
  }
}
