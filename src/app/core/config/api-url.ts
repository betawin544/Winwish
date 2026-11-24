/**
 * Resolves the backend API origin for production (Render) and local dev.
 */
const isLocalDevelopment =
  typeof window !== 'undefined' &&
  ['localhost', '127.0.0.1'].includes(window.location.hostname);

export const API_ORIGIN = isLocalDevelopment
  ? 'http://localhost:3022'
  : 'https://winwish.onrender.com';

export const API_BASE_URL = `${API_ORIGIN}/api`;

