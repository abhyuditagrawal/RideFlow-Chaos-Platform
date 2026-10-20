import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { api, getConn, subscribeConn } from "./api";

export function useConn() {
  return useSyncExternalStore(subscribeConn, getConn);
}

// Polls `path` every `ms` while the backend is connected. Never overlaps
// requests, keeps the last good data on errors.
export function usePoll(path, ms = 3000, { enabled = true } = {}) {
  const conn = useConn();
  const live = enabled && conn.status === "ok" && !!path;
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const busy = useRef(false);
  const pathRef = useRef(path);
  pathRef.current = path;

  const refresh = useCallback(async () => {
    if (busy.current || !pathRef.current) return;
    busy.current = true;
    try {
      setData(await api(pathRef.current));
      setError(null);
    } catch (e) {
      setError(e);
    } finally {
      busy.current = false;
    }
  }, []);

  useEffect(() => {
    if (!live) return undefined;
    refresh();
    const id = setInterval(refresh, ms);
    return () => clearInterval(id);
  }, [live, ms, path, refresh]);

  return { data, error, refresh, loading: live && data === null && !error };
}

// "now" that re-renders every second, for elapsed timers
export function useNow(ms = 1000) {
  const [now, setNow] = useState(Date.now() / 1000);
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now() / 1000), ms);
    return () => clearInterval(id);
  }, [ms]);
  return now;
}

export function useLocalState(key, initial) {
  const [value, setValue] = useState(() => {
    try {
      const raw = localStorage.getItem(key);
      return raw !== null ? JSON.parse(raw) : initial;
    } catch (e) {
      return initial;
    }
  });
  useEffect(() => {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* ignore */ }
  }, [key, value]);
  return [value, setValue];
}
