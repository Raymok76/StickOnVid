/** Tauri IPC helpers — work with or without withGlobalTauri. */
export function tauriInvoke(cmd, args = {}) {
  const invokeFn =
    window.__TAURI_INTERNALS__?.invoke ?? window.__TAURI__?.core?.invoke;
  if (!invokeFn) {
    return Promise.reject(new Error("Tauri IPC unavailable"));
  }
  return invokeFn(cmd, args);
}

export function tauriListen(event, handler) {
  const listenFn = window.__TAURI__?.event?.listen;
  if (!listenFn) return Promise.resolve(() => {});
  return listenFn(event, handler);
}
