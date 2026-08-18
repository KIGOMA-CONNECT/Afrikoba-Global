import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'dart:convert';

class Session {
  static const _kToken = 'afrikoba_token';
  static const _kUser = 'afrikoba_user';

  final FlutterSecureStorage _secure = FlutterSecureStorage(
    aOptions: AndroidOptions(encryptedSharedPreferences: true),
  );

  Future<String?> token() async {
    try {
      return await _secure.read(key: _kToken);
    } catch (_) {
      return null;
    }
  }

  Future<Map<String, dynamic>?> user() async {
    final p = await SharedPreferences.getInstance();
    final raw = p.getString(_kUser);
    if (raw == null) return null;
    try {
      return jsonDecode(raw) as Map<String, dynamic>;
    } catch (_) {
      return null;
    }
  }

  Future<void> save(String token, Map<String, dynamic> user) async {
    await _secure.write(key: _kToken, value: token);
    final p = await SharedPreferences.getInstance();
    await p.setString(_kUser, jsonEncode(user));
  }

  Future<void> updateUser(Map<String, dynamic> user) async {
    final p = await SharedPreferences.getInstance();
    await p.setString(_kUser, jsonEncode(user));
  }

  Future<void> clear() async {
    try {
      await _secure.delete(key: _kToken);
    } catch (_) {}
    final p = await SharedPreferences.getInstance();
    await p.remove(_kUser);
  }
}