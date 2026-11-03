import { createContext, type ReactNode, useCallback, useContext, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { WebView, type WebViewMessageEvent } from 'react-native-webview';
import { radii, useColors } from '../theme';

const siteKey = process.env['EXPO_PUBLIC_TURNSTILE_SITE_KEY'];
/** Must be one of the widget's allowed hostnames in Cloudflare (Turnstile checks the page address). */
const pageOrigin = process.env['EXPO_PUBLIC_TURNSTILE_ORIGIN'] ?? 'https://outfitly.com';
const TIMEOUT_MS = 30_000;

type GetToken = () => Promise<string | undefined>;
const CaptchaContext = createContext<GetToken>(() => Promise.resolve(undefined));

function turnstilePage(key: string): string {
  return `<!doctype html><html><head><meta name="viewport" content="width=device-width">
<script src="https://challenges.cloudflare.com/turnstile/v0/api.js?onload=ready" async defer
  onerror="send({error:'script'})"></script>
</head><body style="margin:0;display:flex;justify-content:center"><div id="c"></div><script>
function send(m){window.ReactNativeWebView.postMessage(JSON.stringify(m));}
function ready(){turnstile.render('#c',{sitekey:${JSON.stringify(key)},
callback:function(t){send({token:t});},
'error-callback':function(e){send({error:String(e)});},
'expired-callback':function(){send({error:'expired'});},
'timeout-callback':function(){send({error:'timeout'});},
'unsupported-callback':function(){send({error:'unsupported'});},
'before-interactive-callback':function(){send({interactive:true});}});}
</script></body></html>`;
}

/**
 * Cloudflare Turnstile (free CAPTCHA) for guest and email sign-ins, which
 * Supabase protects against bots. Runs in a hidden web view only when a token
 * is needed, and shows itself only if Turnstile asks the person to click.
 * Without a site key (local development) no token is sent.
 */
export function CaptchaProvider({ children }: { children: ReactNode }) {
  const colors = useColors();
  const [state, setState] = useState<'idle' | 'hidden' | 'visible'>('idle');
  const inFlight = useRef<Promise<string> | null>(null);
  const settle = useRef<{ resolve: (t: string) => void; reject: (e: Error) => void } | null>(null);

  const finish = useCallback((result: { token: string } | { error: string }) => {
    setState('idle');
    if ('token' in result) settle.current?.resolve(result.token);
    else settle.current?.reject(new Error(`captcha_failed: ${result.error}`));
    settle.current = null;
    inFlight.current = null;
  }, []);

  const getToken = useCallback<GetToken>(() => {
    if (!siteKey) return Promise.resolve(undefined);
    // One check at a time: later callers share it.
    inFlight.current ??= new Promise<string>((resolve, reject) => {
      settle.current = { resolve, reject };
      setState('hidden');
      setTimeout(() => {
        if (settle.current?.resolve === resolve) finish({ error: 'timeout' });
      }, TIMEOUT_MS);
    });
    return inFlight.current;
  }, [finish]);

  const onMessage = (event: WebViewMessageEvent) => {
    let message: { token?: string; error?: string; interactive?: boolean };
    try {
      message = JSON.parse(event.nativeEvent.data) as typeof message;
    } catch {
      finish({ error: 'bad_message' });
      return;
    }
    if (message.interactive) setState('visible');
    else if (message.token) finish({ token: message.token });
    else finish({ error: message.error ?? 'unknown' });
  };

  return (
    <CaptchaContext.Provider value={getToken}>
      {children}
      {state !== 'idle' && siteKey ? (
        <View
          style={
            state === 'visible'
              ? [styles.visible, { backgroundColor: colors.surface, borderColor: colors.border }]
              : styles.hidden
          }
          pointerEvents={state === 'visible' ? 'auto' : 'none'}
        >
          <WebView
            source={{ html: turnstilePage(siteKey), baseUrl: pageOrigin }}
            // Turnstile runs its check in an `about:srcdoc` frame. The default (http/https
            // only) hands that frame to the system to open, and the check hangs until timeout.
            originWhitelist={['https://*', 'about:*']}
            onMessage={onMessage}
            onError={() => {
              finish({ error: 'webview' });
            }}
            onHttpError={() => {
              finish({ error: 'http' });
            }}
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
  visible: {
    position: 'absolute',
    left: 24,
    right: 24,
    top: '40%',
    height: 90,
    borderRadius: radii.md,
    borderWidth: 1,
    overflow: 'hidden',
  },
});
