# 👻 FakeMessage — Fake Discord Messages & Calls (Vencord / Equicord Plugin)

**Create pixel-perfect fake Discord messages, call logs and incoming-call screens, all rendered by Discord itself. Use it for pranks, mockups, tutorials and screenshots. It runs only on your client, and nobody else sees it.**

[![License: GPL-3.0](https://img.shields.io/badge/license-GPL--3.0-blue.svg)](LICENSE)
[![Vencord userplugin](https://img.shields.io/badge/Vencord-userplugin-5865F2.svg)](https://docs.vencord.dev/installing/custom-plugins/)
[![Equicord compatible](https://img.shields.io/badge/Equicord-compatible-a6d189.svg)](https://github.com/Equicord/Equicord)
[![GitHub stars](https://img.shields.io/github/stars/elioflex/fakeMessage?style=flat)](https://github.com/elioflex/fakeMessage/stargazers)

FakeMessage is a [Vencord](https://github.com/Vendicated/Vencord) / [Equicord](https://github.com/Equicord/Equicord) plugin that puts a message into any channel **as if another user had sent it**, with their real avatar, username, role color and timestamp. The message never leaves your client. Discord's own message component renders it, so it looks and behaves exactly like a real one.

![Fake message in a DM as the 11PM bot](screenshots/dm-fake-message.png)

**Quick install** (needs a Vencord or Equicord source build):

```bash
git clone https://github.com/elioflex/fakeMessage && cp -R fakeMessage/FakeMessage Vencord/src/userplugins/
```

Then run `pnpm build`, restart Discord, and enable **FakeMessage**. Full steps are under [Install](#install).

### What people use it for

- 😂 **Pranks** on your own screen with friends in the room
- 🎨 **Mockups** of bot replies, server welcome messages or UI ideas, without needing a test server
- 🎥 **Tutorials and videos** showing a conversation without real DMs
- 🧪 **Testing** how themes and CSS snippets render messages

## Demo

Watch the whole flow: click the 👻 button, search for who should have sent it, type, and hit **Insert** — the fake lands in the chat, and right-clicking it offers **Remove Fake Message**.

![Demo — Fake Message in action](screenshots/fake-message-demo.gif)

## Features

- **👻 Chat bar button** — a ghost button at the left of the message input. Click it, search for the person who should appear to have sent the message, type, and hit **Insert**. Shown by default; hide it anytime via **Show chat bar button** in plugin settings.
- **📞 Fake calls** — a phone button next to the ghost button drops realistic **call log entries** in DMs: "11PM called · 5m 12s", or a red missed call. Pick the person, set the duration, hit **Insert**.
- **📲 Incoming call screen** — a ringing-phone button shows a **full-screen incoming call**: the caller's avatar with a pulsing ring, their name, and green accept / red decline buttons. Accepting starts a live fake call timer until you hang up. Purely visual — no real call is dialed.
- **🎯 Slash commands** — `/fakemessage user: @bob content: hey check this out` drops a fake message; `/fakecall user: @bob duration: 5:12 missed: true minutes-ago: 30` drops a fake call entry.
- **🖱 Context menus** — right-click any user → **Fake Message** (pre-selected for you); right-click a fake message → **Remove Fake Message** / **Remove Fake Call**.
- **⏱ Backdating** — the fake slots into history at the right position with the matching timestamp.
- **💾 Persistence** — fakes survive restarts and channel switches (stored in plugin settings, toggleable).
- **🔒 Client-side only** — nothing is uploaded, synced, or sent. Nobody else sees your fakes.

## How it looks

Real avatar, real username, real role color, real timestamp, markdown, `<@mention>` highlighting, bot tags, and automatic grouping with the same author's real messages — all rendered by Discord's own CSS because the fake is injected into the real message store.

![Fake message in a server channel](screenshots/server-fake-message.png)

## Install

You need a source build of [Vencord](https://docs.vencord.dev/installing/) or [Equicord](https://github.com/Equicord/Equicord), plus git, Node.js and pnpm.

1. Copy the `FakeMessage` folder into `Vencord/src/userplugins/` (or `Equicord/src/userplugins/`; create the folder if it doesn't exist).
2. Rebuild with `pnpm build` (or your dev watcher). If this is a fresh setup, also run `pnpm inject` with Discord closed.
3. Restart Discord, then enable **FakeMessage** under **Settings → Vencord** (or **Equicord**) **→ Plugins**.

## Usage

| Way | How |
| --- | --- |
| Ghost button | Click the 👻 button in the chat input bar → search a user (or paste a user ID) → type → **Insert** |
| Call button | Click the 📞 button → pick the other person → set duration (mm:ss) or toggle **Missed call** → **Insert** |
| Incoming button | Click the 📲 button → pick the caller → **Call** → full-screen ringing overlay with accept / decline |
| Command | `/fakemessage user: <user> content: <text> [minutes-ago: <n>]` or `/fakecall user: <user> [duration: mm:ss] [missed: true] [minutes-ago: <n>]` |
| User context menu | Right-click any user → **Fake Message** |
| Clean up | Right-click a fake message → **Remove Fake Message** / **Remove Fake Call**, or Settings → **Clear all fake messages** |
| Hide the buttons | Turn **Show 👻 chat bar button** / **Show 📞 call button** / **Show 📲 incoming button** off in plugin settings — commands and context menus still work |

## How it works

`MessageStore.getMessages(channelId)` is wrapped in a Proxy that merges the channel's real messages with any stored fakes, sorted by timestamp. Each fake is built by **cloning a real `Message` record** (same prototype, every field) and swapping in the real `User` object, new content, and timestamp — so Discord's renderer can't tell the difference. The underlying store is never mutated, so nothing ever syncs to Discord's servers.

## Privacy

- Everything stays on your machine in Discord's local settings storage.
- Fake messages are visible **only to you**. Other people never see them, and Discord's servers never receive them.
- The fakes are not real: replying to or editing one hits Discord's API and fails harmlessly. Use **Remove Fake Message** to clean up.

## Known limitations

- Links in fakes don't auto-fetch embeds (Discord only embeds messages it received from the server).
- No attachments / reactions / stickers — text, markdown, and mentions only.
- Fakes don't move the unread divider or notify anyone (they're client-side).
- Fake calls appear in the chat log only; the incoming-call screen is a purely visual overlay (no audio, nothing contacts the other side).

## Responsible use

FakeMessage is for fun and for building things. **Don't use it to fake evidence, impersonate someone to scam or harass them, or pass fake screenshots off as real.** That can break Discord's rules and the law, and it hurts real people. Client mods are also against Discord's Terms of Service, so use this at your own risk.

## Contributing

Bug reports, ideas and PRs are welcome. If it made you laugh, a ⭐ helps other people find it.

## License

[GPL-3.0-or-later](LICENSE) — same as Vencord.
