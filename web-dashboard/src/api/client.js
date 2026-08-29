import axios from 'axios';

const api = axios.create({
  baseURL: '/api',
});

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
  (error) => {
    if (error.response && error.response.status === 401) {
      localStorage.removeItem('afrikoba_token');
      localStorage.removeItem('afrikoba_user');
      window.location.href = '/login';
    }
    return Promise.reject(error);
  }
);

export default api;
