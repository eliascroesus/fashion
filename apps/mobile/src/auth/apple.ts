import * as AppleAuthentication from 'expo-apple-authentication';
import { CryptoDigestAlgorithm, digestStringAsync, randomUUID } from 'expo-crypto';

/**
 * Native Sign in with Apple. Apple gets a hashed nonce; Supabase gets the raw
 * one to check the token was made for this request. Null if cancelled.
 */
export async function getAppleIdToken(): Promise<{ token: string; nonce: string } | null> {
  const nonce = randomUUID();
  try {
    const credential = await AppleAuthentication.signInAsync({
      // Only the email: we don't use the name (people choose their profile name themselves).
      requestedScopes: [AppleAuthentication.AppleAuthenticationScope.EMAIL],
      nonce: await digestStringAsync(CryptoDigestAlgorithm.SHA256, nonce),
    });
    return credential.identityToken ? { token: credential.identityToken, nonce } : null;
  } catch (error) {
    if ((error as { code?: string }).code === 'ERR_REQUEST_CANCELED') return null;
    throw error;
  }
}
