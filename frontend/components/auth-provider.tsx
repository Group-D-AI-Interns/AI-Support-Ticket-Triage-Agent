"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type Keycloak from "keycloak-js";
import { setApiTokenProvider } from "@/lib/api";

type AuthStatus = "initializing" | "authenticated" | "anonymous" | "configuration_error" | "provider_error";
type AuthContextValue = {
  status: AuthStatus;
  accessToken: string | null;
  login: () => Promise<void>;
  logout: () => Promise<void>;
  getAccessToken: () => Promise<string>;
};

const AuthContext = createContext<AuthContextValue | null>(null);
let keycloakClient: Keycloak | null = null;
let keycloakClientPromise: Promise<Keycloak> | null = null;
let initialization: Promise<boolean> | null = null;

function getKeycloakClient() {
  if (!keycloakClientPromise) {
    keycloakClientPromise = import("keycloak-js").then(({ default: KeycloakAdapter }) => {
      const url = process.env.NEXT_PUBLIC_KEYCLOAK_URL?.trim();
      const realm = process.env.NEXT_PUBLIC_KEYCLOAK_REALM?.trim();
      const clientId = process.env.NEXT_PUBLIC_KEYCLOAK_CLIENT_ID?.trim();
      if (!url || !realm || !clientId) throw new Error("Keycloak sign-in is not configured for this frontend.");
      keycloakClient = new KeycloakAdapter({ url, realm, clientId });
      return keycloakClient;
    });
  }
  return keycloakClientPromise;
}

function initializeKeycloak(client: Keycloak) {
  if (!initialization) {
    initialization = client.init({
      onLoad: "check-sso",
      flow: "standard",
      pkceMethod: "S256",
      checkLoginIframe: false,
    });
  }
  return initialization;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const configured = Boolean(
    process.env.NEXT_PUBLIC_KEYCLOAK_URL?.trim() &&
    process.env.NEXT_PUBLIC_KEYCLOAK_REALM?.trim() &&
    process.env.NEXT_PUBLIC_KEYCLOAK_CLIENT_ID?.trim(),
  );
  const [status, setStatus] = useState<AuthStatus>(configured ? "initializing" : "configuration_error");
  const [accessToken, setAccessToken] = useState<string | null>(null);

  const getAccessToken = useCallback(async () => {
    const client = await getKeycloakClient();
    if (!client.authenticated) throw new Error("Your Keycloak session has expired. Sign in again.");
    try { await client.updateToken(30); }
    catch (error) {
      client.clearToken();
      setAccessToken(null);
      setStatus("anonymous");
      throw error;
    }
    if (!client.token) throw new Error("Keycloak did not provide an access token.");
    return client.token;
  }, []);

  useEffect(() => {
    if (!configured) return;
    let mounted = true;
    void getKeycloakClient()
      .then(async client => {
        const authenticated = await initializeKeycloak(client);
        if (mounted) {
          setAccessToken(authenticated ? client.token ?? null : null);
          setStatus(authenticated ? "authenticated" : "anonymous");
        }
      })
      .catch(() => {
        if (mounted) setStatus("provider_error");
      });
    return () => { mounted = false; };
  }, [configured]);

  useEffect(() => {
    setApiTokenProvider(getAccessToken);
    return () => setApiTokenProvider(null);
  }, [getAccessToken]);

  const login = useCallback(async () => {
    const client = await getKeycloakClient();
    await client.login({ redirectUri: window.location.origin });
  }, []);

  const logout = useCallback(async () => {
    const client = await getKeycloakClient();
    setAccessToken(null);
    setStatus("anonymous");
    await client.logout({ redirectUri: window.location.origin });
  }, []);

  const value = useMemo(() => ({ status, accessToken, login, logout, getAccessToken }), [status, accessToken, login, logout, getAccessToken]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) throw new Error("useAuth must be used inside AuthProvider.");
  return context;
}
