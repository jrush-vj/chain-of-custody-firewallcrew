import axios from 'axios';

const normalizeBaseUrl = (url = '') => url.replace(/\/+$/, '');

const resolveApiBaseUrl = () => {
  const envUrl = process.env.REACT_APP_API_URL;
  if (envUrl) {
    return normalizeBaseUrl(envUrl);
  }

  if (typeof window !== 'undefined' && window.location?.origin) {
    return normalizeBaseUrl(window.location.origin);
  }

  // Fallback for server-side tools (tests, Storybook, etc.)
  return 'http://localhost:5000';
};

const apiClient = axios.create({
  baseURL: resolveApiBaseUrl(),
  headers: {
    'Content-Type': 'application/json'
  },
  timeout: 10000,
  withCredentials: true
});

export const setAuthToken = (token) => {
  if (token) {
    apiClient.defaults.headers.common.Authorization = `Bearer ${token}`;
  } else {
    delete apiClient.defaults.headers.common.Authorization;
  }
};

export default apiClient;
