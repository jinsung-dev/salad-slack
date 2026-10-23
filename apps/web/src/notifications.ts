import { api } from "./api";

// Browser side of Web Push: the service worker and this browser's subscription.

export type PushState = "unsupported" | "disabled-by-server" | "denied" | "off" | "on";

const supported = () => "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;

export async function registerServiceWorker(onNavigate: (path: string) => void) {
  if (!supported()) return;
  navigator.serviceWorker.addEventListener("message", (e: MessageEvent<{ type?: string; url?: string }>) => {
    if (e.data?.type === "navigate" && e.data.url) onNavigate(new URL(e.data.url).pathname);
  });
  await navigator.serviceWorker.register("/sw.js").catch(() => undefined);
}

async function currentSubscription() {
  const reg = await navigator.serviceWorker.getRegistration("/");
  return (await reg?.pushManager.getSubscription()) ?? null;
}

export async function pushState(): Promise<PushState> {
  if (!supported()) return "unsupported";
  if (Notification.permission === "denied") return "denied";
  try {
    await api.pushKey();
  } catch {
    return "disabled-by-server";
  }
  return (await currentSubscription()) ? "on" : "off";
}

const toKey = (base64url: string) => {
  const raw = atob(base64url.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
};

export async function enablePush(): Promise<PushState> {
  if (!supported()) return "unsupported";
  if ((await Notification.requestPermission()) !== "granted") return "denied";
  const { publicKey } = await api.pushKey();
  const reg = await navigator.serviceWorker.ready;
  const sub = (await reg.pushManager.getSubscription()) ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: toKey(publicKey) }));
  await api.subscribePush(sub.toJSON());
  return "on";
}

export async function disablePush(): Promise<PushState> {
  const sub = await currentSubscription();
  if (sub) {
    await api.unsubscribePush(sub.endpoint).catch(() => undefined);
    await sub.unsubscribe();
  }
  return "off";
}
