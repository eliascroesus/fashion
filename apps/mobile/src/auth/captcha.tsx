import { createContext, type ReactNode, useCallback, useContext, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { WebView, type WebViewMessageEvent } from 'react-native-webview';

const siteKey = process.env['EXPO_PUBLIC_TURNSTILE_SITE_KEY'];
/** Turnstile checks the page's address against the site key's allowed domains. */
const PAGE_ORIGIN = 'https://outfitly.app';

type GetToken = () => Promise<string | undefined>;
const CaptchaContext = createContext<GetToken>(() => Promise.resolve(undefined));

function turnstilePage(key: string): string {
  return `<!doctype html><html><head><meta name="viewport" content="width=device-width">
<script src="https://challenges.cloudflare.com/turnstile/v0/api.js?onload=ready" async defer></script>
</head><body style="margin:0"><div id="c"></div><script>
function send(m){window.ReactNativeWebView.postMessage(JSON.stringify(m));}
function ready(){turnstile.render('#c',{sitekey:${JSON.stringify(key)},
callback:function(t){send({token:t});},'error-callback':function(e){send({error:String(e)});}});}
</script></body></html>`;
}

/**
 * Cloudflare Turnstile (free CAPTCHA) for guest and email sign-ins, which
 * Supabase protects against bots. Runs in a hidden web view only when a token
 * is needed. Without a site key (local development) no token is sent.
 */
export function CaptchaProvider({ children }: { children: ReactNode }) {
  const [active, setActive] = useState(false);
  const pending = useRef<{ resolve: (t: string) => void; reject: (e: Error) => void } | null>(null);

  const getToken = useCallback<GetToken>(() => {
    if (!siteKey) return Promise.resolve(undefined);
    return new Promise<string>((resolve, reject) => {
      pending.current = { resolve, reject };
      setActive(true);
    });
  }, []);

  const onMessage = (event: WebViewMessageEvent) => {
    const message = JSON.parse(event.nativeEvent.data) as { token?: string; error?: string };
    setActive(false);
    if (message.token) pending.current?.resolve(message.token);
    else pending.current?.reject(new Error(`captcha_failed: ${message.error ?? ''}`));
    pending.current = null;
  };

  return (
    <CaptchaContext.Provider value={getToken}>
      {children}
      {active && siteKey ? (
        <View style={styles.hidden} pointerEvents="none">
          <WebView
            source={{ html: turnstilePage(siteKey), baseUrl: PAGE_ORIGIN }}
            onMessage={onMessage}
            javaScriptEnabled
          />
        </View>
      ) : null}
    </CaptchaContext.Provider>
  );
}

export function useCaptchaToken(): GetToken {
  return useContext(CaptchaContext);
}

const styles = StyleSheet.create({
  hidden: { position: 'absolute', width: 1, height: 1, opacity: 0 },
});
