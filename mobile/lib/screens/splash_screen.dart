import 'package:flutter/material.dart';
import '../core/app_state.dart';
import 'login_screen.dart';
import 'home_screen.dart';

/// Skrini ya mwanzo - inakagua kama kuna kipindi halali.
class SplashScreen extends StatefulWidget {
  const SplashScreen({super.key});

  @override
  State<SplashScreen> createState() => _SplashScreenState();
}

class _SplashScreenState extends State<SplashScreen> {
  @override
  void initState() {
    super.initState();
    _bootstrap();
  }

  Future<void> _bootstrap() async {
    final token = await AppState.instance.session.token();
    if (!mounted) return;
    Navigator.of(context).pushReplacement(
      MaterialPageRoute(builder: (_) => token == null ? const LoginScreen() : const HomeScreen()),
    );
  }

  @override
  Widget build(BuildContext context) {
    return const Scaffold(
      body: Center(
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Icon(Icons.account_balance, size: 72, color: Color(0xFF0B7A41)),
            SizedBox(height: 12),
            Text(
              'AFRIKOBA GLOBAL',
              style: TextStyle(fontSize: 24, fontWeight: FontWeight.w800, letterSpacing: 1.2),
            ),
            SizedBox(height: 4),
            Text('Digital Banking & Upatu'),
            SizedBox(height: 24),
            CircularProgressIndicator(),
          ],
        ),
      ),
    );
  }
}
