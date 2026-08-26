# FakeMessage

> Fake messages that look 100% real — avatar, username, role color, timestamp, markdown, the works.

**FakeMessage** is a Vencord plugin that lets you drop messages into any channel *as if another user had sent them*. The message isn't real — it never leaves your client — but it is rendered by Discord's own message component, so it is visually and interactively indistinguishable from a genuine message.

## How it works

Instead of drawing fake messages with custom markup, the plugin injects the fake message into Discord's real `MessageStore`:

1. On plugin start, `MessageStore.getMessages(channelId)` is wrapped so the returned message collection is a Proxy that merges the channel's real messages with any fake ones stored for that channel.
2. The fake message is a plain object shaped exactly like Discord's `Message` record — it carries the real `User` object (from `UserStore`) as its author, so the **real avatar**, **real username**, **server nickname**, **role color**, and **bot tag** all render automatically.
3. The timestamp formats like a real one ("Today at 3:42 PM"), markdown/bold/italic/code/emoji/links parse natively, `<@mention>` chips highlight, and consecutive fakes from the same user **group together** exactly like real messages.
4. Hovering a fake message shows the normal Reply / React / More actions — it behaves like a real message in every way the renderer knows.
5. Fake messages persist across restarts (stored in the plugin's settings), so they survive channel switches and reloads.

Because the fakes are merged at render time (never written into Discord's underlying store), nothing is ever synced, uploaded, or sent.

## Usage

### 1. Chat bar buttons
- A 👻 ghost button appears at the left of the message input in every channel. Click it, search for the person who should appear to have sent the message (or paste their user ID), type the message, and hit **Insert**.
- A 📞 phone button sits right next to it for **fake calls**: pick the person you "talked" to, set a duration (`mm:ss`, or `0:00` for a missed call), and hit **Insert**. A call log entry appears in the DM — phone icon, "11PM called", duration — rendered by Discord itself.

### 2. Slash commands
Type in any channel:

```
/fakemessage user: @bob content: hey check this out
/fakecall user: @bob duration: 5:12
/fakecall user: @bob missed: true minutes-ago: 30
```

`fakemessage` drops a fake text message; `fakecall` drops a fake call log entry (duration as `mm:ss` or minutes, `missed: true` for an unanswered call, `minutes-ago` backdates it). Nothing real is sent.

### 3. Context menu
- **Right-click any user** (member list, message header, profile popout) → **Fake Message** → the modal opens with them preselected → type the content → **Insert**.
- **Right-click a fake message** → **Remove Fake Message** (or **Remove Fake Call** for call entries) to clean up.

### 4. Settings
- **Persist fake messages** — keep fakes across restarts (on by default).
- **Show 👻 chat bar button / Show 📞 call button** — toggle either chat-bar button on/off.
- **Clear all fake messages** — removes every fake everywhere.

## Privacy / safety

- Everything stays on your machine in Discord's settings storage. Nothing is uploaded anywhere.
- Fake messages are visible **only to you** — other people in the channel never see them, and Discord's servers never receive them.
- The fake messages are not real: replying to one or clicking destructive actions (edit/delete) will hit Discord's API and fail harmlessly (a red error toast at most). Use the right-click **Remove Fake Message** instead.

## Known limitations (v1)

- Links in fake messages don't auto-fetch embeds (Discord only embeds messages it received from the server).
- No attachments / reactions / stickers — text, markdown, and mentions only.
- The message won't move the unread divider or trigger mentions for other people (it's client-side).

## Install

1. Copy the `FakeMessage` folder into `Vencord/src/userplugins/`.
2. Rebuild Vencord (`pnpm build` or your dev watcher).
3. Restart Discord, then enable **FakeMessage** under **Settings → Vencord → Plugins**.
