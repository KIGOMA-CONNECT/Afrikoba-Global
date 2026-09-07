import 'dart:math';
import 'package:shared_preferences/shared_preferences.dart';

/// Stable per-install device fingerprint (hex, 64 chars) - header inayotumika
/// kwenye trusted device binding. Inahifadhiwa kwenye SharedPreferences.
Future<String> afrikobaFingerprint() async {
  const key = 'afrikoba_device_fingerprint';
  final p = await SharedPreferences.getInstance();
  final existing = p.getString(key);
  if (existing != null && existing.isNotEmpty) return existing;
  final rng = Random.secure();
  final bytes = List<int>.generate(32, (_) => rng.nextInt(256));
  final hex = bytes.map((b) => b.toRadixString(16).padLeft(2, '0')).join();
  await p.setString(key, hex);
  return hex;
}

/// Header map kwa ApiClient (inayopendelewa na backend kwenye device binding).
Map<String, String> deviceHeaders(String fingerprint) =>
    {'x-device-fingerprint': fingerprint};