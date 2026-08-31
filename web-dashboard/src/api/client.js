import axios from 'axios';

const api = axios.create({
  baseURL: '/api',
});

let isRefreshing = false;
let failedQueue = [];

function processQueue(error, token) {
  failedQueue.forEach((prom) => {
    if (error) prom.reject(error);
    else prom.resolve(token);
  });
  failedQueue = [];
}

api.interceptors.request.use((config) => {
  const token = localStorage.getItem('afrikoba_token');
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  const lang = localStorage.getItem('afrikoba_lang') || 'sw';
  config.headers['Accept-Language'] = lang;
  return config;
});

api.interceptors.response.use(
  (response) => response,
  async (error) => {
    const originalRequest = error.config;

    if (error.response?.status === 401 && error.response?.data?.code === 'TOKEN_REVOKED' && !originalRequest._retry) {
      const refreshToken = localStorage.getItem('afrikoba_refresh_token');
      if (!refreshToken) {
        localStorage.removeItem('afrikoba_token');
        localStorage.removeItem('afrikoba_user');
        window.location.href = '/login';
        return Promise.reject(error);
      }

      if (isRefreshing) {
        return new Promise((resolve, reject) => {
          failedQueue.push({ resolve, reject });
        }).then((token) => {
          originalRequest.headers.Authorization = `Bearer ${token}`;
          return api(originalRequest);
        });
      }

      originalRequest._retry = true;
      isRefreshing = true;

      try {
        const res = await axios.post('/api/auth/refresh', { refreshToken });
        const { token: newToken, refreshToken: newRefresh } = res.data;
        localStorage.setItem('afrikoba_token', newToken);
        localStorage.setItem('afrikoba_refresh_token', newRefresh);
        api.defaults.headers.common.Authorization = `Bearer ${newToken}`;
        processQueue(null, newToken);
        originalRequest.headers.Authorization = `Bearer ${newToken}`;
        return api(originalRequest);
      } catch (refreshError) {
        processQueue(refreshError, null);
        localStorage.removeItem('afrikoba_token');
        localStorage.removeItem('afrikoba_user');
        localStorage.removeItem('afrikoba_refresh_token');
        window.location.href = '/login';
        return Promise.reject(refreshError);
      } finally {
        isRefreshing = false;
      }
    }

    return Promise.reject(error);
  }
);

export default api;