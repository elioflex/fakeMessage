# FakeMessage

Fake messages that look 100% real — rendered by Discord itself, client-side only.

- **👻 Ghost button** in the chat bar (shown by default, hideable via **Show chat bar button** in plugin settings): pick a user, type the message, done.
- **`/fakemessage user: @user content: text [minutes-ago: n]`** command.
- **Right-click a user** → **Fake Message**; right-click a fake → **Remove Fake Message**.
- Persists across restarts; nothing is ever sent or uploaded.

## Install

Copy this `FakeMessage` folder into `Vencord/src/userplugins/`, rebuild Vencord, and enable the plugin under **Settings → Vencord → Plugins**.

Full documentation: [../README.md](../README.md)
