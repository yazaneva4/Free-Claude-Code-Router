'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const invoke = (channel, payload) => ipcRenderer.invoke(channel, payload || {});

const unwrap = async (promise) => {
  const response = await promise;
  if (!response || response.ok !== true) {
    const error = new Error((response && response.error && response.error.message) || 'Request failed.');
    error.code = response && response.error ? response.error.code : 'error';
    throw error;
  }
  return response.value;
};

contextBridge.exposeInMainWorld('gate', {
  auth: {
    bootstrap: () => unwrap(invoke('auth:bootstrap')),
    signup: (payload) => unwrap(invoke('auth:signup', payload)),
    login: (payload) => unwrap(invoke('auth:login', payload)),
    logout: () => unwrap(invoke('auth:logout')),
    session: () => unwrap(invoke('auth:session')),
  },
  onboarding: {
    saveSync: (payload) => unwrap(invoke('onboarding:saveSync', payload)),
    saveHarnesses: (payload) => unwrap(invoke('onboarding:saveHarnesses', payload)),
  },
  account: {
    changePassword: (payload) => unwrap(invoke('account:changePassword', payload)),
    updateProfile: (payload) => unwrap(invoke('account:updateProfile', payload)),
    remove: () => unwrap(invoke('account:delete')),
  },
  vault: {
    list: () => unwrap(invoke('vault:list')),
    save: (payload) => unwrap(invoke('vault:save', payload)),
    remove: (providerId) => unwrap(invoke('vault:delete', { providerId })),
  },
  providers: {
    catalog: () => unwrap(invoke('providers:catalog')),
    probe: (providerId, baseUrl) => unwrap(invoke('providers:probe', { providerId, baseUrl })),
    models: (providerId, baseUrl) => unwrap(invoke('providers:models', { providerId, baseUrl })),
  },
  settings: {
    get: () => unwrap(invoke('settings:get')),
    updateRouting: (payload) => unwrap(invoke('settings:updateRouting', payload)),
    updateProvider: (providerId, patch) => unwrap(invoke('settings:updateProvider', { providerId, patch })),
    updateIntegration: (kind, name, patch) => unwrap(invoke('settings:updateIntegration', { kind, name, patch })),
  },
  reveal: () => unwrap(invoke('gate:reveal')),
});
