import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';
import apiClient, { setAuthToken } from '../lib/apiClient';

const AuthContext = createContext(null);

const defaultTwoFactorState = {
  status: 'idle',
  user: null,
  otpauthUrl: null,
  manualCode: null,
  expiresInMinutes: null
};

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within AuthProvider');
  }
  return context;
};

export const AuthProvider = ({ children }) => {
  const [user, setUser] = useState(null);
  const [token, setToken] = useState(() => localStorage.getItem('token'));
  const [loading, setLoading] = useState(true);
  const [twoFactorState, setTwoFactorState] = useState(defaultTwoFactorState);
  const [authError, setAuthError] = useState(null);

  const resetTwoFactorState = useCallback(() => {
    setTwoFactorState(defaultTwoFactorState);
  }, []);

  const clearSession = useCallback(() => {
    localStorage.removeItem('token');
    setAuthToken(null);
    setToken(null);
    setUser(null);
  }, []);

  const fetchUser = useCallback(async () => {
    if (!token) {
      setLoading(false);
      return;
    }

    setAuthToken(token);
    try {
      const response = await apiClient.get('/api/auth/me');
      setUser(response.data);
    } catch (error) {
      clearSession();
    } finally {
      setLoading(false);
    }
  }, [token, clearSession]);

  useEffect(() => {
    fetchUser();
  }, [fetchUser]);

  const persistSession = useCallback(
    (newToken, newUser) => {
      localStorage.setItem('token', newToken);
      setAuthToken(newToken);
      setToken(newToken);
      setUser(newUser);
    },
    []
  );

  const startTwoFactorFlow = useCallback(
    (userData, payload) => {
      if (!payload?.status) {
        resetTwoFactorState();
        return;
      }

      setTwoFactorState({
        status: payload.status,
        user: userData,
        otpauthUrl: payload.otpauthUrl || null,
        manualCode: payload.manualCode || null,
        expiresInMinutes: payload.expiresInMinutes || null
      });
    },
    [resetTwoFactorState]
  );

  const login = useCallback(
    async (email, password) => {
      setAuthError(null);
      resetTwoFactorState();
      try {
        const { data } = await apiClient.post('/api/auth/login', { email, password });
        if (data.twoFactor?.status) {
          startTwoFactorFlow(data.user, data.twoFactor);
          return { success: true, stage: data.twoFactor.status };
        }
        persistSession(data.token, data.user);
        return { success: true, stage: 'authenticated' };
      } catch (error) {
        const message = error.response?.data?.error || 'Login failed';
        setAuthError(message);
        return { success: false, error: message };
      }
    },
    [persistSession, resetTwoFactorState, startTwoFactorFlow]
  );

  const register = useCallback(
    async (username, email, password) => {
      setAuthError(null);
      resetTwoFactorState();
      try {
        const { data } = await apiClient.post('/api/auth/register', { username, email, password });
        if (data.twoFactor?.status) {
          startTwoFactorFlow(data.user, data.twoFactor);
          return { success: true, stage: data.twoFactor.status };
        }
        persistSession(data.token, data.user);
        return { success: true, stage: 'authenticated' };
      } catch (error) {
        const message = error.response?.data?.error || 'Registration failed';
        setAuthError(message);
        return { success: false, error: message };
      }
    },
    [persistSession, resetTwoFactorState, startTwoFactorFlow]
  );

  const verifyTwoFactor = useCallback(
    async (code) => {
      const trimmedCode = (code || '').toString().replace(/\s+/g, '');
      if (trimmedCode.length !== 6) {
        return { success: false, error: 'The OTP code must be 6 digits' };
      }

      try {
        const { data } = await apiClient.post('/api/auth/two-factor/verify', { code: trimmedCode });
        resetTwoFactorState();
        persistSession(data.token, data.user);
        return { success: true };
      } catch (error) {
        return {
          success: false,
          error: error.response?.data?.error || 'Two-factor verification failed'
        };
      }
    },
    [persistSession, resetTwoFactorState]
  );

  const regenerateTwoFactorSecret = useCallback(async () => {
    if (twoFactorState.status !== 'setup') {
      return { success: false, error: 'Two-factor setup is not in progress' };
    }

    try {
      const { data } = await apiClient.post('/api/auth/two-factor/regenerate');
      if (data.twoFactor?.status === 'setup') {
        setTwoFactorState((prev) => ({
          ...prev,
          otpauthUrl: data.twoFactor.otpauthUrl || prev.otpauthUrl,
          manualCode: data.twoFactor.manualCode || prev.manualCode
        }));
      }
      return { success: true };
    } catch (error) {
      return {
        success: false,
        error: error.response?.data?.error || 'Unable to generate a new secret'
      };
    }
  }, [twoFactorState.status]);

  const cancelTwoFactorFlow = useCallback(async () => {
    try {
      await apiClient.post('/api/auth/two-factor/cancel');
    } catch {
      // Ignore errors if the backend already cleared the pending token.
    } finally {
      resetTwoFactorState();
    }
  }, [resetTwoFactorState]);

  const logout = useCallback(async () => {
    try {
      await apiClient.post('/api/auth/logout');
    } catch {
      // Ignore network errors while logging out
    } finally {
      clearSession();
      resetTwoFactorState();
    }
  }, [clearSession, resetTwoFactorState]);

  const value = {
    user,
    loading,
    token,
    authError,
    twoFactorState,
    login,
    register,
    verifyTwoFactor,
    regenerateTwoFactorSecret,
    cancelTwoFactorFlow,
    logout,
    refreshUser: fetchUser
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
};
