import { call } from "./api";
import { readPref, writePref } from "./prefs";

const PUSH_ID_KEY = "orchestrator.push.subscription";

export const pushSupported = () => "serviceWorker" in navigator && "PushManager" in window;

/** The key a browser subscribes against comes base64url; the push manager takes its bytes. */
const bytesOf = (key: string): Uint8Array<ArrayBuffer> => {
  const raw = atob(key.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
};

/** `no-vault`: this machine keeps no sealed secret, so it cannot hold the key that wakes a closed page. */
export type PushResult = "on" | "no-vault" | "unavailable";

/** Subscribes this browser to wake for a task, with the page closed too. */
export async function subscribePush(): Promise<PushResult> {
  if (!pushSupported()) return "unavailable";
  try {
    const { publicKey } = await call<{ publicKey: string }>("GET", "/api/push/key");
    const registration = await navigator.serviceWorker.register("/sw.js");
    await navigator.serviceWorker.ready;
    const subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: bytesOf(publicKey) });
    const { endpoint, keys } = subscription.toJSON();
    const { id } = await call<{ id: string }>("POST", "/api/push/subscriptions", { endpoint, keys });
    writePref(PUSH_ID_KEY, id);
    return "on";
  } catch (err) {
    return (err as { code?: string }).code === "no-vault" ? "no-vault" : "unavailable";
  }
}

/** Forgets this browser's subscription, here and on the orchestrator. */
export async function unsubscribePush(): Promise<void> {
  const id = readPref(PUSH_ID_KEY);
  writePref(PUSH_ID_KEY, null);
  if (id) await call("DELETE", `/api/push/subscriptions/${encodeURIComponent(id)}`).catch(() => undefined);
  const registration = await navigator.serviceWorker?.getRegistration("/sw.js").catch(() => undefined);
  await (await registration?.pushManager.getSubscription())?.unsubscribe().catch(() => undefined);
}
