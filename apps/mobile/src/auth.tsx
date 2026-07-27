import * as SecureStore from "expo-secure-store";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type PropsWithChildren,
  type ReactElement,
} from "react";

const ACCESS_TOKEN_KEY = "pocket-omp.access-token";

interface AuthContextValue {
  readonly loading: boolean;
  readonly accessToken?: string;
  readonly completeSignIn: (accessToken: string) => Promise<void>;
  readonly signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export function AuthProvider({ children }: PropsWithChildren): ReactElement {
  const [loading, setLoading] = useState(true);
  const [accessToken, setAccessToken] = useState<string>();
  useEffect(() => {
    void SecureStore.getItemAsync(ACCESS_TOKEN_KEY)
      .then((token) => {
        if (token !== null) setAccessToken(token);
        return undefined;
      })
      .finally(() => setLoading(false));
  }, []);
  const completeSignIn = useCallback(async (token: string): Promise<void> => {
    if (token.length < 32) throw new Error("Invalid access token");
    await SecureStore.setItemAsync(ACCESS_TOKEN_KEY, token, {
      keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    });
    setAccessToken(token);
  }, []);
  const signOut = useCallback(async (): Promise<void> => {
    await SecureStore.deleteItemAsync(ACCESS_TOKEN_KEY);
    setAccessToken(undefined);
  }, []);
  const value = useMemo<AuthContextValue>(
    () => ({
      loading,
      ...(accessToken === undefined ? {} : { accessToken }),
      completeSignIn,
      signOut,
    }),
    [accessToken, completeSignIn, loading, signOut],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (context === undefined) throw new Error("AuthProvider is missing");
  return context;
}
