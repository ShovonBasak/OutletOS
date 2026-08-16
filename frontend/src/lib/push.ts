import { api } from "./api";

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = window.atob(base64);
  return Uint8Array.from([...rawData].map((c) => c.charCodeAt(0)));
}

export async function getVapidPublicKey(): Promise<string> {
  const data = await api<{ vapid_public_key: string }>("/push-subscriptions/vapid-key/");
  return data.vapid_public_key;
}

export async function isPushSupported(): Promise<boolean> {
  return (
    typeof window !== "undefined" &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window
  );
}

/** Request permission and register a push subscription. Returns true on success. */
export async function subscribeToPush(): Promise<boolean> {
  if (!(await isPushSupported())) return false;

  const permission = await Notification.requestPermission();
  if (permission !== "granted") return false;

  const registration = await navigator.serviceWorker.ready;
  const vapidPublicKey = await getVapidPublicKey();
  if (!vapidPublicKey) return false;

  const subscription = await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(vapidPublicKey),
  });

  const json = subscription.toJSON();
  await api("/push-subscriptions/", {
    method: "POST",
    body: JSON.stringify({
      endpoint: json.endpoint,
      p256dh: json.keys?.p256dh,
      auth: json.keys?.auth,
    }),
  });

  return true;
}

/** Unsubscribe from push and remove from server. */
export async function unsubscribeFromPush(): Promise<void> {
  if (!(await isPushSupported())) return;

  const registration = await navigator.serviceWorker.ready;
  const subscription = await registration.pushManager.getSubscription();
  if (!subscription) return;

  const endpoint = subscription.endpoint;
  await subscription.unsubscribe();

  await api("/push-subscriptions/remove/", {
    method: "POST",
    body: JSON.stringify({ endpoint }),
  });
}

/** Current browser push permission state. */
export function pushPermissionState(): NotificationPermission | "unsupported" {
  if (typeof window === "undefined" || !("Notification" in window)) return "unsupported";
  return Notification.permission;
}
