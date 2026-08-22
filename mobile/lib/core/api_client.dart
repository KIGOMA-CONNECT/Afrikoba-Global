import 'package:http/http.dart' as http;
import 'dart:convert';
import '../core/session.dart';

/// Central HTTP client kwa API ya Afrikoba Global.
/// - Inaongeza Authorization header (Bearer token) kwenye kila request.
/// - Inakamata mawimbi ya 401 na kufuta kipindi (logout automatic).
class ApiClient {
  static const String baseUrl = String.fromEnvironment(
    'API_BASE',
    defaultValue: 'http://localhost:3000/api',
  );

  final Session _session;

  ApiClient(this._session);

  Future<Map<String, dynamic>> _send(
    String method,
    String path, {
    Map<String, dynamic>? body,
    bool withAuth = true,
  }) async {
    final uri = Uri.parse('$baseUrl$path');
    final headers = <String, String>{'Content-Type': 'application/json'};
    if (withAuth) {
      final token = await _session.token();
      if (token != null) headers['Authorization'] = 'Bearer $token';
    }

    http.Response res;
    switch (method) {
      case 'GET':
        res = await http.get(uri, headers: headers).timeout(const Duration(seconds: 20));
        break;
      case 'POST':
        res = await http
            .post(uri, headers: headers, body: body == null ? null : jsonEncode(body))
            .timeout(const Duration(seconds: 20));
        break;
      case 'PUT':
        res = await http
            .put(uri, headers: headers, body: body == null ? null : jsonEncode(body))
            .timeout(const Duration(seconds: 20));
        break;
      case 'PATCH':
        res = await http
            .patch(uri, headers: headers, body: body == null ? null : jsonEncode(body))
            .timeout(const Duration(seconds: 20));
        break;
      default:
        throw Exception('Method haitambuliki: $method');
    }

    Map<String, dynamic> data;
    try {
      data = jsonDecode(res.body) as Map<String, dynamic>;
    } catch (_) {
      data = <String, dynamic>{};
    }

    if (res.statusCode == 401 && withAuth) {
      await _session.clear();
      throw ApiException(401, 'Kipindi chako kimeisha. Ingia tena.');
    }
    if (res.statusCode >= 400) {
      throw ApiException(
        res.statusCode,
        (data['message'] as String?) ?? 'Hitilafu ya server (${res.statusCode}).',
        data,
      );
    }
    return data;
  }

  Future<Map<String, dynamic>> get(String path, {bool withAuth = true}) =>
      _send('GET', path, withAuth: withAuth);

  Future<Map<String, dynamic>> post(String path, Map<String, dynamic>? body,
          {bool withAuth = true}) =>
      _send('POST', path, body: body, withAuth: withAuth);

  Future<Map<String, dynamic>> put(String path, Map<String, dynamic>? body,
          {bool withAuth = true}) =>
      _send('PUT', path, body: body, withAuth: withAuth);

  Future<Map<String, dynamic>> patch(String path, Map<String, dynamic>? body,
          {bool withAuth = true}) =>
      _send('PATCH', path, body: body, withAuth: withAuth);
}

class ApiException implements Exception {
  final int statusCode;
  final String message;
  final Map<String, dynamic>? data;
  ApiException(this.statusCode, this.message, [this.data]);

  @override
  String toString() => message;
}
