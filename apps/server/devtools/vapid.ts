import webpush from "web-push";

// Prints a fresh VAPID key pair for .env. Keep it: changing keys drops every
// existing push subscription.
const { publicKey, privateKey } = webpush.generateVAPIDKeys();
console.log(`VAPID_PUBLIC_KEY=${publicKey}\nVAPID_PRIVATE_KEY=${privateKey}\nVAPID_SUBJECT=mailto:you@saladlab.co`);
