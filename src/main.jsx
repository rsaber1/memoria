import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App.jsx";

// Simple in-memory storage shim (replace with Supabase or localStorage in production)
window.storage = {
  _store: {},
  get: async (key) => {
    const value = localStorage.getItem(key);
    return value ? { key, value } : null;
  },
  set: async (key, value) => {
    localStorage.setItem(key, value);
    return { key, value };
  },
  delete: async (key) => {
    localStorage.removeItem(key);
    return { key, deleted: true };
  },
};

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
