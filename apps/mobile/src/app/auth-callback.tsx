import { router } from 'expo-router';
import { useEffect } from 'react';

/**
 * Google sign-in returns to outfitly://auth-callback. The browser session
 * already handed the result to the sign-in flow; just leave this screen.
 */
export default function AuthCallback() {
  useEffect(() => {
    if (router.canGoBack()) router.back();
    else router.replace('/');
  }, []);
  return null;
}
