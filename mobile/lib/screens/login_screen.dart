import 'package:flutter/material.dart';
import '../core/app_state.dart';
import '../core/api_client.dart';
import 'home_screen.dart';

enum _Mode { login, register }

/// Kuingia / Kujisajili kwa OTP.
/// Hatua 1: namba ya simu (+ jina/email kwa usajili) -> Tuma OTP
/// Hatua 2: weka OTP (mode ya majaribio inaonyesha OTP halisi) -> Ingia / Sajili
class LoginScreen extends StatefulWidget {
  const LoginScreen({super.key});

  @override
  State<LoginScreen> createState() => _LoginScreenState();
}

class _LoginScreenState extends State<LoginScreen> {
  _Mode _mode = _Mode.login;
  int _step = 1;
  bool _loading = false;
  String _error = '';
  String _devOtp = '';

  final _phoneCtrl = TextEditingController();
  final _nameCtrl = TextEditingController();
  final _emailCtrl = TextEditingController();
  final _otpCtrl = TextEditingController();

  @override
  void dispose() {
    _phoneCtrl.dispose();
    _nameCtrl.dispose();
    _emailCtrl.dispose();
    _otpCtrl.dispose();
    super.dispose();
  }

  Future<void> _sendOtp() async {
    setState(() {
      _loading = true;
      _error = '';
    });
    try {
      final api = AppState.instance.api;
      final res = await api.post('/auth/send-otp', {'phoneNumber': _phoneCtrl.text.trim()});
      setState(() {
        _devOtp = (res['devOtp'] as String?) ?? '';
        _step = 2;
      });
    } on ApiException catch (e) {
      setState(() => _error = e.message);
    } catch (_) {
      setState(() => _error = 'Hitilafu katika kutuma OTP.');
    } finally {
      setState(() => _loading = false);
    }
  }

  Future<void> _verify() async {
    setState(() {
      _loading = true;
      _error = '';
    });
    try {
      final api = AppState.instance.api;
      final body = <String, dynamic>{
        'phoneNumber': _phoneCtrl.text.trim(),
        'otp': _otpCtrl.text.trim(),
      };
      if (_mode == _Mode.register) {
        body['fullName'] = _nameCtrl.text.trim();
        body['email'] = _emailCtrl.text.trim();
      }
      final path = _mode == _Mode.login ? '/auth/login' : '/auth/register';
      final res = await api.post(path, body);
      final token = res['token'] as String;
      final user = res['user'] as Map<String, dynamic>;
      await AppState.instance.session.save(token, user);
      if (!mounted) return;
      Navigator.of(context).pushReplacement(MaterialPageRoute(builder: (_) => const HomeScreen()));
    } on ApiException catch (e) {
      setState(() => _error = e.message);
    } catch (_) {
      setState(() => _error = 'Hitilafu. Jaribu tena.');
    } finally {
      setState(() => _loading = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: Center(
        child: SingleChildScrollView(
          padding: const EdgeInsets.all(24),
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 420),
            child: Card(
              child: Padding(
                padding: const EdgeInsets.all(24),
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    const Icon(Icons.account_balance, size: 48, color: Color(0xFF0B7A41)),
                    const SizedBox(height: 8),
                    const Text('AFRIKOBA GLOBAL',
                        textAlign: TextAlign.center,
                        style: TextStyle(fontSize: 22, fontWeight: FontWeight.w800)),
                    const Text('Kuingia kwenye mfumo wa fedha wa kidijitali',
                        textAlign: TextAlign.center, style: TextStyle(fontSize: 13)),
                    const SizedBox(height: 16),
                    SegmentedButton<_Mode>(
                      segments: const [
                        ButtonSegment(value: _Mode.login, label: Text('Ingia')),
                        ButtonSegment(value: _Mode.register, label: Text('Sajili')),
                      ],
                      selected: {_mode},
                      onSelectionChanged: (s) => setState(() {
                        _mode = s.first;
                        _step = 1;
                        _error = '';
                      }),
                    ),
                    const SizedBox(height: 16),
                    if (_error.isNotEmpty)
                      Container(
                        margin: const EdgeInsets.only(bottom: 12),
                        padding: const EdgeInsets.all(10),
                        decoration: BoxDecoration(
                          color: Colors.red.shade50,
                          borderRadius: BorderRadius.circular(8),
                        ),
                        child: Text(_error, style: TextStyle(color: Colors.red.shade800, fontSize: 13)),
                      ),
                    if (_step == 1) ...[
                      TextField(
                        controller: _phoneCtrl,
                        keyboardType: TextInputType.phone,
                        decoration: const InputDecoration(labelText: 'Namba ya Simu', hintText: '0712000001'),
                      ),
                      if (_mode == _Mode.register) ...[
                        const SizedBox(height: 12),
                        TextField(
                          controller: _nameCtrl,
                          decoration: const InputDecoration(labelText: 'Jina Kamili'),
                        ),
                        const SizedBox(height: 12),
                        TextField(
                          controller: _emailCtrl,
                          keyboardType: TextInputType.emailAddress,
                          decoration: const InputDecoration(labelText: 'Email (si lazima)'),
                        ),
                      ],
                      const SizedBox(height: 16),
                      FilledButton(
                        onPressed: _loading || _phoneCtrl.text.trim().isEmpty ? null : _sendOtp,
                        child: Text(_loading ? 'Inatuma...' : 'Tuma OTP'),
                      ),
                    ] else ...[
                      if (_devOtp.isNotEmpty)
                        Container(
                          margin: const EdgeInsets.only(bottom: 12),
                          padding: const EdgeInsets.all(10),
                          decoration: BoxDecoration(
                            color: Colors.green.shade50,
                            borderRadius: BorderRadius.circular(8),
                          ),
                          child: Text(
                            'Mode ya majaribio - OTP yako ni: $_devOtp',
                            style: TextStyle(color: Colors.green.shade800, fontSize: 13),
                          ),
                        ),
                      TextField(
                        controller: _otpCtrl,
                        keyboardType: TextInputType.number,
                        maxLength: 6,
                        decoration: const InputDecoration(labelText: 'Msimbo wa OTP', hintText: '123456'),
                      ),
                      const SizedBox(height: 12),
                      FilledButton(
                        onPressed: _loading || _otpCtrl.text.trim().isEmpty ? null : _verify,
                        child: Text(_loading
                            ? 'Inachakata...'
                            : _mode == _Mode.login
                                ? 'Ingia'
                                : 'Sajili na Ingia'),
                      ),
                      TextButton(
                        onPressed: _loading
                            ? null
                            : () => setState(() {
                                  _step = 1;
                                  _error = '';
                                }),
                        child: const Text('Rudi nyuma'),
                      ),
                    ],
                  ],
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}
