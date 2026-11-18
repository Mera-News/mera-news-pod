# Pairing the Mera News app

The Mera News app can show a pod's news, profile and picks instead of reading the news on the phone. The phone then stops reading the news itself: the pod reads, and the phone shows what the pod holds and sends your changes to it. This works through the `sync` plugin, which lives in the `mera-news-pod-plugins` repository, in `packages/sync`.

## Install the plugin

If you have not built the plugins yet:

```
git clone https://github.com/Mera-News/mera-news-pod-plugins
cd mera-news-pod-plugins
npm install
npm run build
```

Name it in `pod.json`, by the path of the package:

```json
"plugins": [
  { "package": "/home/you/mera-news-pod-plugins/packages/sync", "config": { "publicHost": "pod.example.com" } }
]
```

Restart the pod. All settings are optional:

| Key | Default | Meaning |
|---|---|---|
| `port` | 8788 | The port to listen on. |
| `host` | `127.0.0.1` | The interface to listen on. |
| `publicHost` | none | The name the phone reaches the pod at, such as `pod.example.com`. |
| `podName` | the machine's name | The name the app shows for this pod. |

## HTTPS only

The app talks to a pod only over HTTPS, and refuses a plain `http://` address. Every request carries the phone's device token, and anyone who can read the traffic could use it. Phones also refuse unencrypted connections by default.

The plugin itself speaks plain HTTP on `127.0.0.1`. Put a reverse proxy with a certificate, or a tunnel you run, in front of it, and set `publicHost` to the name it answers at. A phone on the same Wi-Fi still needs that HTTPS address.

## Pair a phone

Run this in the `mera-news-pod-plugins` folder, on the pod's machine:

```
npx mera-news-pod-sync pair --base https://pod.example.com
```

Add `--home <folder>` when the pod does not use the default home. It prints a code and a link that starts with `meraapp://pod-pair`. Open the link on the phone, or point the phone's camera at it if you show it as a QR code. In the app, pairing starts from Settings.

The code has 10 characters, works once and lasts 10 minutes. After 10 wrong codes in all, or 5 tries in one minute, pairing stops until you print a new code.

When you pair the first phone and both the phone and the pod already have a profile, the app asks which one to keep. The other is replaced. Only the phone that is the one paired device at that moment can replace the pod's profile. A phone paired later always takes the pod's profile.

## Several phones and revoking one

Each phone pairs with its own code. To see them and remove one:

```
npx mera-news-pod-sync devices
npx mera-news-pod-sync devices --revoke <id>
```

A revoked phone is refused on its next request. Logging out of the app also revokes the phone, when the pod can be reached.

## What a paired phone can do

A paired phone holds a device token. With it the phone can read your profile, feed and picks, change your profile, pause or resume reading, and use the pod's AI service and news server through the pod. That is the same reach as the MCP token. Revoke a phone you no longer use.

The AI service's key and the news server's key stay on the pod. The phone never sees them.

## Shared and per-device settings

A paired phone shares these settings with the pod and with every other paired phone, one value for all: the language, Skip notes, the 24-hour filter, the Explore choices and the topics you rejected. The language is also the language the pod writes reasons in, for every phone.

Where you are in the feed stays on each phone.

## What the phone still sends to Mera

While paired, the phone sends Mera only requests about your Mera News account: signing in, your subscription, notifications and feedback requests. Your profile, your feed and your chats go to your pod.

## When the versions differ

The phone and the pod must run the same version to share data. If they do not, the app says which side is older. Update that side: the app from the store, or the pod with `git pull` and `npm install`, then restart it.
