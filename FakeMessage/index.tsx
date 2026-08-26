/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Elioflex
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { addChatBarButton, ChatBarButton, removeChatBarButton } from "@api/ChatButtons";
import { ApplicationCommandInputType, ApplicationCommandOptionType, findOption, sendBotMessage } from "@api/Commands";
import { NavContextMenuPatchCallback } from "@api/ContextMenu";
import { definePluginSettings } from "@api/Settings";
import definePlugin, { IconComponent, OptionType } from "@utils/types";
import { Message, RenderModalProps, User } from "@vencord/discord-types";
import { Button, createRoot, Menu, MessageStore, Modal, moment, openModal, React, SelectedChannelStore, showToast, Switch, TextArea, TextInput, UserStore, UserUtils } from "@webpack/common";

/**
 * A fake message is just like a real Discord message, except:
 *  - it is stored locally (plugin settings) instead of on Discord's servers
 *  - it carries a `_isFake` marker so we can offer to remove it
 * Everything else (author, avatar, username, role colors, timestamp, markdown,
 * hover actions, message grouping) is rendered by Discord itself, because the
 * message is injected into the real MessageStore.
 */
interface StoredFakeMessage {
    id: string;
    channelId: string;
    authorId: string;
    /** Snapshot of the author's user object, used if the user is not cached after a restart */
    author?: Record<string, any>;
    content: string;
    timestamp: number;
    /** When present, this fake renders as a call log entry (system message) instead of a text message */
    call?: { durationSeconds: number; missed?: boolean };
}

const ID_PREFIX = "fakemessage-";
const MAX_FAKES_PER_CHANNEL = 50;

let fakes: StoredFakeMessage[] = [];
let originalGetMessages: ((channelId?: string) => any) | null = null;
let originalGetMessage: ((channelId: string, messageId: string) => any) | null = null;

const settings = definePluginSettings({
    persist: {
        type: OptionType.BOOLEAN,
        description: "Keep fake messages after restarting Discord",
        restartNeeded: false,
        default: true
    },
    showChatButton: {
        type: OptionType.BOOLEAN,
        description: "Show the 👻 ghost button in the chat bar",
        restartNeeded: false,
        default: true
    },
    showCallButton: {
        type: OptionType.BOOLEAN,
        description: "Show the 📞 call button in the chat bar",
        restartNeeded: false,
        default: true
    },
    showIncomingButton: {
        type: OptionType.BOOLEAN,
        description: "Show the 📲 incoming-call button in the chat bar",
        restartNeeded: false,
        default: true
    },
    clearAll: {
        type: OptionType.COMPONENT,
        component: () => (
            <Button
                color={Button.Colors.RED}
                size={Button.Sizes.SMALL}
                onClick={() => {
                    fakes = [];
                    saveFakes();
                    refresh();
                    showToast("All fake messages removed");
                }}
            >
                Clear all fake messages
            </Button>
        )
    }
});

// --- persistence ------------------------------------------------------------

function loadFakes() {
    fakes = [];
    if (!settings.store.persist) return;
    try {
        const raw = (settings.store as any).fakeMessages;
        if (typeof raw === "string" && raw) {
            const parsed = JSON.parse(raw);
            if (Array.isArray(parsed)) fakes = parsed;
        }
    } catch (e) {
        console.error("[FakeMessage] Failed to load fake messages:", e);
    }
}

function saveFakes() {
    try {
        (settings.store as any).fakeMessages = JSON.stringify(settings.store.persist ? fakes : []);
    } catch (e) {
        console.error("[FakeMessage] Failed to save fake messages:", e);
    }
}

// --- store patching ---------------------------------------------------------
// The message list renders whatever `MessageStore.getMessages(channelId)`
// returns. By wrapping that collection in a Proxy we can present the fake
// messages as part of the channel's history without ever mutating Discord's
// internal store, so nothing gets synced to the server.

function getFakesForChannel(channelId?: string): StoredFakeMessage[] {
    if (!channelId) return [];
    return fakes.filter(f => f.channelId === channelId);
}

function wrapMessages(collection: any, channelId?: string): any {
    if (!collection || getFakesForChannel(channelId).length === 0) return collection;

    const real = () => (Array.isArray(collection?._array) ? collection._array : []);
    const getFake = (id: string) => getFakesForChannel(channelId).find(f => f.id === id);
    const makeMessage = (fake: StoredFakeMessage) =>
        buildMessage(fake, real().find((m: any) => m && !m._isFake) ?? null);
    const combined = () => {
        const fakeMessages = getFakesForChannel(channelId)
            .map(makeMessage)
            .filter((m): m is Message => m !== null);
        if (fakeMessages.length === 0) return real();
        return [...real(), ...fakeMessages].sort((a, b) => +a.timestamp - +b.timestamp);
    };

    return new Proxy(collection, {
        get(target, prop, receiver) {
            if (typeof prop === "symbol") {
                if (prop === Symbol.iterator) {
                    const arr = combined();
                    return arr[Symbol.iterator].bind(arr);
                }
                return Reflect.get(target, prop, receiver);
            }

            switch (prop) {
                case "_array":
                    return combined();
                case "toArray":
                    return combined;
                case "get":
                    return (id: string) => {
                        const fake = getFake(id);
                        if (fake) return makeMessage(fake);
                        return target.get(id);
                    };
                case "has":
                    return (id: string) => Boolean(getFake(id)) || target.has(id);
                case "size":
                case "length":
                    return combined().length;
                case "last":
                    return () => {
                        const arr = combined();
                        return arr[arr.length - 1];
                    };
                case "first":
                    return () => combined()[0];
                case "at":
                    return (index: number) => combined()[index];
                case "forEach":
                case "some":
                case "every":
                case "filter":
                case "map":
                case "find":
                case "findIndex":
                case "reduce":
                case "indexOf":
                case "includes":
                case "keys":
                case "values":
                case "entries":
                    return (...args: any[]) => (combined() as any)[prop](...args);
                default:
                    // Keep every other method (receiveMessage, commit, ...) bound
                    // to the real collection so the underlying store keeps working.
                    return Reflect.get(target, prop, receiver);
            }
        }
    });
}

function patchStore() {
    if (originalGetMessages || !MessageStore) return;
    originalGetMessages = MessageStore.getMessages.bind(MessageStore) as any;
    (MessageStore as any).getMessages = function (this: any, channelId?: string) {
        return wrapMessages(originalGetMessages!(channelId), channelId);
    };
    // Discord's context-menu / message lookups use getMessage(channelId, id),
    // which would miss fakes and silently open no menu on right-click. Route it
    // through the proxied collection so fakes resolve there too.
    originalGetMessage = (MessageStore as any).getMessage.bind(MessageStore);
    (MessageStore as any).getMessage = function (this: any, channelId: string, messageId: string) {
        const coll = (MessageStore as any).getMessages(channelId);
        const found = coll && typeof coll.get === "function" ? coll.get(messageId) : undefined;
        if (found) return found;
        return originalGetMessage!(channelId, messageId);
    };
}

function unpatchStore() {
    if (originalGetMessages) {
        (MessageStore as any).getMessages = originalGetMessages;
        originalGetMessages = null;
    }
    if (originalGetMessage) {
        (MessageStore as any).getMessage = originalGetMessage;
        originalGetMessage = null;
    }
}

/** Force the chat (and anything else subscribed to MessageStore) to re-render. */
function refresh() {
    try {
        (MessageStore as any).emitChange();
    } catch (e) {
        console.error("[FakeMessage] Failed to refresh message store:", e);
    }
}

// --- fake message construction ----------------------------------------------

const MENTION_RE = /<@!?(\d{15,21})>/g;
const ROLE_MENTION_RE = /<@&(\d{15,21})>/g;
const CHANNEL_MENTION_RE = /<#(\d{15,21})>/g;

function extractIds(re: RegExp, content: string): string[] {
    const ids: string[] = [];
    let match: RegExpExecArray | null;
    while ((match = re.exec(content))) ids.push(match[1]);
    return ids;
}

/** Build a minimal-but-functional User for fakes whose author left the cache. */
function hydrateUser(json: Record<string, any>): User | null {
    if (!json?.id) return null;
    const avatar = json.avatar || json.avatarDecoration?.asset ? json.avatar || json.avatarDecoration.asset : undefined;
    const user: any = {
        ...json,
        getAvatarURL: (_guildId?: string, size = 128, _animated = false) => {
            if (json.avatar) {
                const ext = json.avatar.startsWith("a_") ? "gif" : "png";
                return `https://cdn.discordapp.com/avatars/${json.id}/${json.avatar}.${ext}?size=${size}`;
            }
            const index = String((BigInt(json.id) >> 22n) % 6n);
            return `https://cdn.discordapp.com/embed/avatars/${index}.png?size=${size}`;
        },
        getAvatarDecorationURL: () => undefined,
        getBannerURL: () => undefined,
        getAccentColor: () => json.accentColor ?? null,
        toString: () => json.globalName ?? json.username ?? json.id
    };
    return user as User;
}

function resolveAuthor(fake: StoredFakeMessage): User | undefined {
    const cached = UserStore.getUser(fake.authorId);
    if (cached) return cached;
    if (fake.author) return hydrateUser(fake.author) ?? undefined;
    return undefined;
}

/**
 * Build a fake Message. When a real message from the same channel is
 * available, we clone it (same prototype + all its fields) so the fake is
 * byte-for-byte the shape Discord's renderer expects — including every
 * array field the Message component touches (codedLinks, giftCodes,
 * soundboardSounds, ...). Hand-building all of those would be fragile.
 */
function buildMessage(fake: StoredFakeMessage, base: Message | null): Message | null {
    const author = resolveAuthor(fake);
    if (!author) return null;

    const overrides: Record<string, any> = {
        id: fake.id,
        channel_id: fake.channelId,
        author,
        bot: Boolean(author.bot),
        content: fake.content,
        timestamp: new Date(fake.timestamp),
        editedTimestamp: null,
        nonce: fake.id,
        state: "SENT",
        type: 0, // DEFAULT
        flags: 0,
        pinned: false,
        tts: false,
        mentionEveryone: false,
        mentioned: false,
        mentions: extractIds(MENTION_RE, fake.content),
        mentionRoles: extractIds(ROLE_MENTION_RE, fake.content),
        mentionChannels: extractIds(CHANNEL_MENTION_RE, fake.content),
        blocked: false,
        ignored: false,
        nick: null,
        colorString: null,
        member: undefined,
        referencedMessage: undefined,
        messageReference: undefined,
        webhookId: undefined,
        _isFake: true,
        deleted: undefined
    };

    // Content-derived fields that must not leak over from the base message
    const clean: Record<string, any> = {
        attachments: [],
        embeds: [],
        reactions: [],
        components: [],
        stickers: [],
        stickerItems: [],
        soundboardSounds: [],
        codedLinks: [],
        giftCodes: [],
        mentionGames: [],
        messageSnapshots: [],
        poll: null,
        potions: null,
        activity: null,
        interaction: null,
        interactionMetadata: null,
        application: null,
        applicationId: null,
        purchaseNotification: null,
        giftingPrompt: null,
        premiumGroupInviteId: null,
        customRenderedContent: null
    };

    // Call log entries are system messages (type 3): no text content, and a
    // `call` record describing the duration + who was on the call. Discord's
    // renderer turns that into the phone-icon row ("11PM called · 5 minutes")
    // or, when the current user was NOT among the participants, a red missed
    // call. Two details matter for it to render without crashing:
    //  - `duration` must be a moment-duration object — Discord calls
    //    `duration.humanize()` on it to format the length.
    //  - a missed call is detected by the current user's absence from
    //    `participants`, not by the duration.
    const isCall = fake.call !== undefined;
    if (isCall) {
        const seconds = fake.call!.durationSeconds;
        const currentUserId = UserStore.getCurrentUser()?.id;
        const missed = fake.call!.missed === true;
        Object.assign(overrides, {
            type: 3, // CALL
            content: "",
            call: {
                duration: missed ? null : (moment ? moment.duration(seconds, "seconds") : seconds),
                endedTimestamp: new Date(fake.timestamp),
                participants: missed
                    ? [fake.authorId]
                    : [fake.authorId, currentUserId].filter(Boolean)
            }
        });
    } else {
        clean.call = null;
    }

    if (base) {
        const msg: any = Object.create(Object.getPrototypeOf(base));
        Object.assign(msg, base, overrides, clean);
        return msg;
    }

    // No base message (empty channel): build a complete standalone record so
    // the renderer never hits an undefined `.length`.
    const msg: any = {
        activity: null,
        activityInstance: null,
        application: null,
        applicationId: null,
        attachments: [],
        call: null,
        changelogId: null,
        codedLinks: [],
        colorString: null,
        components: [],
        customRenderedContent: null,
        embeds: [],
        giftCodes: [],
        giftInfo: null,
        giftingPrompt: null,
        interaction: null,
        interactionData: null,
        interactionError: null,
        interactionMetadata: null,
        isSearchHit: false,
        isUnsupported: false,
        loggingName: null,
        mentionGames: [],
        messageSnapshots: [],
        poll: null,
        potions: null,
        premiumGroupInviteId: null,
        purchaseNotification: null,
        reactions: [],
        referralTrialOfferId: null,
        roleSubscriptionData: null,
        sharedClientTheme: null,
        soundboardSounds: [],
        stickers: [],
        stickerItems: [],
        webhookId: undefined,

        getChannelId: () => fake.channelId,
        hasFlag: () => false,
        isEdited: () => false,
        isCommandType: () => false,
        getContentMessage: () => msg,
        canDeleteOwnMessage: () => false,
        isSystemDM: () => false,
        isFirstMessageInForumPost: () => false,
        isInteractionPlaceholder: () => false,
        isPoll: () => false,
        hasPotions: () => false,
        userHasReactedWithEmoji: () => false,
        getReaction: () => undefined,
        addReaction: () => msg,
        removeReaction: () => msg,
        removeReactionsForEmoji: () => msg,
        addReactionBatch: () => msg
    };
    Object.assign(msg, overrides);
    return msg;
}

function snapshotUser(user: User): Record<string, any> {
    const u = user as any;
    return {
        id: u.id,
        username: u.username,
        globalName: u.globalName,
        discriminator: u.discriminator,
        avatar: u.avatar,
        avatarDecoration: u.avatarDecoration ?? u.avatarDecorationData,
        banner: u.banner,
        accentColor: u.accentColor,
        bot: u.bot,
        publicFlags: u.publicFlags
    };
}

// --- public API ---------------------------------------------------------------

function injectFakeMessage(channelId: string, author: User, content: string, minutesAgo = 0) {
    const text = (content || "").trim();
    if (!text) {
        showToast("Write some content first");
        return;
    }
    if (!author) {
        showToast("Could not find that user");
        return;
    }

    const channelFakes = getFakesForChannel(channelId);
    if (channelFakes.length >= MAX_FAKES_PER_CHANNEL) {
        showToast(`Too many fake messages in this channel (max ${MAX_FAKES_PER_CHANNEL}). Clear some first.`);
        return;
    }

    const id = `${ID_PREFIX}${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    fakes.push({
        id,
        channelId,
        authorId: author.id,
        author: snapshotUser(author),
        content: text,
        timestamp: Date.now() - Math.max(0, minutesAgo) * 60_000
    });

    saveFakes();
    refresh();
    showToast(`Fake message sent as ${author.username}`);
}

/** Parse "mm:ss" (or plain minutes) into seconds. Used for call durations. */
function parseDuration(input: string): number {
    const t = (input || "").trim() || "0";
    if (t.includes(":")) {
        const [m, s] = t.split(":").map(n => parseInt(n, 10) || 0);
        return Math.min(Math.max(m, 0) * 60 + Math.max(s, 0), 60 * 60); // cap at 1 hour
    }
    const n = parseInt(t, 10) || 0;
    return Math.min(Math.max(n, 0) * 60, 60 * 60); // plain number = minutes
}

/** Add a fake call log entry to a DM: a phone-icon system message, e.g. "11PM called · 5 minutes". */
function injectFakeCall(channelId: string, author: User, durationSeconds: number, minutesAgo = 0, missed = false) {
    if (!author) {
        showToast("Could not find that user");
        return;
    }

    const channelFakes = getFakesForChannel(channelId);
    if (channelFakes.length >= MAX_FAKES_PER_CHANNEL) {
        showToast(`Too many fake messages in this channel (max ${MAX_FAKES_PER_CHANNEL}). Clear some first.`);
        return;
    }

    const id = `${ID_PREFIX}${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    fakes.push({
        id,
        channelId,
        authorId: author.id,
        author: snapshotUser(author),
        content: "",
        timestamp: Date.now() - Math.max(0, minutesAgo) * 60_000,
        call: { durationSeconds, missed }
    });

    saveFakes();
    refresh();
    showToast(missed
        ? `Fake missed call from ${author.username} added`
        : `Fake call from ${author.username} added`);
}

function removeFake(messageId: string) {
    const before = fakes.length;
    fakes = fakes.filter(f => f.id !== messageId);
    if (fakes.length !== before) {
        saveFakes();
        refresh();
    }
}

function removeFakesForChannel(channelId: string) {
    const before = fakes.length;
    fakes = fakes.filter(f => f.channelId !== channelId);
    if (fakes.length !== before) {
        saveFakes();
        refresh();
    }
}

// --- UI ----------------------------------------------------------------------

/** Ghost in a bubble — the graphical "fake message" button. */
const FakeMessageIcon: IconComponent = ({ height = 22, width = 22, className }) => (
    <svg
        width={width}
        height={height}
        viewBox="0 0 24 24"
        fill="currentColor"
        className={className}
        aria-hidden="true"
    >
        <path d="M12 2.8a7.2 7.2 0 0 0-7.2 7.2v8.35a.85.85 0 0 0 1.45.6L8 17.4l1.75 1.55a.85.85 0 0 0 1.15 0L12.65 17.4l1.75 1.55a.85.85 0 0 0 1.15 0L17.3 17.4l1.75 1.55a.85.85 0 0 0 1.45-.6V10A7.2 7.2 0 0 0 12 2.8Z" />
        <circle cx="9.3" cy="10.2" r="1.45" fill="var(--background-primary)" />
        <circle cx="14.7" cy="10.2" r="1.45" fill="var(--background-primary)" />
        <path d="M8 13.6c.8.9 2.2 1.4 4 1.4s3.2-.5 4-1.4c-.3 1.6-1.8 2.7-4 2.7s-3.7-1.1-4-2.7Z" fill="var(--background-primary)" />
    </svg>
);

/** Phone handset — the "fake call" chat bar button. */
const CallIcon: IconComponent = ({ height = 22, width = 22, className }) => (
    <svg
        width={width}
        height={height}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        className={className}
        aria-hidden="true"
    >
        <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z" />
    </svg>
);

/** Ringing phone with an incoming arrow — the "fake incoming call" chat bar button. */
const IncomingCallIcon: IconComponent = ({ height = 22, width = 22, className }) => (
    <svg
        width={width}
        height={height}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        className={className}
        aria-hidden="true"
    >
        <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z" />
        <path d="M12 2v8m0 0 3-3m-3 3L9 7" />
    </svg>
);

// `Switch` from @webpack/common is a deprecated export typed as `never`; it's
// the FormSwitchCompat component at runtime, which takes `note` + children.
const FormSwitch = Switch as any;

type ModalMode = "message" | "call" | "incoming";

function openFakeMessageModal(user?: User, channelId?: string, mode: ModalMode = "message") {
    const targetChannel = channelId ?? SelectedChannelStore.getChannelId();
    openModal(modalProps => (
        <FakeMessageModal initialUser={user} channelId={targetChannel} modalProps={modalProps} initialMode={mode} />
    ));
}

function FakeMessageModal({ initialUser, channelId, modalProps, initialMode = "message" }: { initialUser?: User; channelId: string; modalProps: RenderModalProps; initialMode?: ModalMode; }) {
    const [mode, setMode] = React.useState<ModalMode>(initialMode);
    const [user, setUser] = React.useState<User | null>(initialUser ?? null);
    const [query, setQuery] = React.useState("");
    const [content, setContent] = React.useState("");
    const [duration, setDuration] = React.useState("5:00");
    const [missed, setMissed] = React.useState(false);
    const [minutesAgo, setMinutesAgo] = React.useState("0");
    const [fetching, setFetching] = React.useState(false);
    const [fetchError, setFetchError] = React.useState<string | null>(null);

    const results = React.useMemo(() => {
        const q = query.trim().toLowerCase();
        if (!q) return [] as User[];
        const all: any = UserStore.getUsers();
        const list: User[] = all && typeof all.values === "function"
            ? Array.from(all.values())
            : Object.values(all ?? {});
        return list
            .filter(u => u && (u.username?.toLowerCase().includes(q) || u.globalName?.toLowerCase().includes(q) || u.id.includes(q)))
            .slice(0, 8);
    }, [query]);

    const fetchById = async () => {
        const id = query.trim();
        if (!id) return;
        setFetching(true);
        setFetchError(null);
        try {
            const u = UserStore.getUser(id) ?? await UserUtils.getUser(id);
            if (u) setUser(u);
            else setFetchError("No user found with that ID.");
        } catch {
            setFetchError("Could not fetch that user.");
        } finally {
            setFetching(false);
        }
    };

    const insert = () => {
        if (!user) return;
        if (mode === "call") {
            injectFakeCall(channelId, user, missed ? 0 : parseDuration(duration), Number(minutesAgo) || 0, missed);
        } else if (mode === "incoming") {
            modalProps.onClose();
            showIncomingCall(user);
            return;
        } else {
            if (!content.trim()) return;
            injectFakeMessage(channelId, user, content, Number(minutesAgo) || 0);
        }
        modalProps.onClose();
    };

    const name = user ? (user.globalName ?? user.username) : null;

    return (
        <Modal
            {...modalProps}
            size="medium"
            title={mode === "call" ? "Fake Call" : mode === "incoming" ? "Incoming Call" : "Fake Message"}
            actions={[
                { text: "Cancel", variant: "secondary", onClick: modalProps.onClose },
                {
                    text: mode === "incoming" ? "Call" : "Insert",
                    variant: "primary",
                    onClick: insert,
                    disabled: !user || (mode === "message" && !content.trim())
                }
            ]}
        >
            <div style={{ display: "flex", gap: "8px", marginBottom: "16px" }}>
                <Button
                    size={Button.Sizes.SMALL}
                    color={mode === "message" ? Button.Colors.BRAND : Button.Colors.PRIMARY}
                    onClick={() => setMode("message")}
                >
                    💬 Message
                </Button>
                <Button
                    size={Button.Sizes.SMALL}
                    color={mode === "call" ? Button.Colors.BRAND : Button.Colors.PRIMARY}
                    onClick={() => setMode("call")}
                >
                    📞 Call
                </Button>
                <Button
                    size={Button.Sizes.SMALL}
                    color={mode === "incoming" ? Button.Colors.BRAND : Button.Colors.PRIMARY}
                    onClick={() => setMode("incoming")}
                >
                    📲 Incoming
                </Button>
            </div>
            {user ? (
                <div style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "16px" }}>
                    <img
                        src={user.getAvatarURL(void 0, 64, true)}
                        alt=""
                        style={{ width: "40px", height: "40px", borderRadius: "50%" }}
                    />
                    <div style={{ flex: 1 }}>
                        <div style={{ fontWeight: "700", color: "var(--header-primary)" }}>{name}</div>
                        <div style={{ fontSize: "12px", color: "var(--text-muted)" }}>
                            Client-side only — appears in your chat, nobody else sees it.
                        </div>
                    </div>
                    <Button size={Button.Sizes.SMALL} color={Button.Colors.PRIMARY} onClick={() => setUser(null)}>
                        Change
                    </Button>
                </div>
            ) : (
                <div style={{ marginBottom: "16px" }}>
                    <TextInput
                        value={query}
                        onChange={setQuery}
                        placeholder="Search a user by name… or paste a user ID"
                        autoFocus
                    />
                    {fetchError && (
                        <div style={{ fontSize: "12px", color: "var(--text-danger)", marginTop: "6px" }}>{fetchError}</div>
                    )}
                    {results.length > 0 && (
                        <div style={{
                            marginTop: "8px", border: "1px solid var(--background-modifier-accent)",
                            borderRadius: "8px", overflow: "hidden"
                        }}>
                            {results.map(u => (
                                <div
                                    key={u.id}
                                    onClick={() => setUser(u)}
                                    style={{
                                        display: "flex", alignItems: "center", gap: "10px", padding: "8px 10px",
                                        cursor: "pointer", background: "var(--background-secondary)"
                                    }}
                                    onMouseEnter={e => { e.currentTarget.style.background = "var(--background-modifier-hover)"; }}
                                    onMouseLeave={e => { e.currentTarget.style.background = "var(--background-secondary)"; }}
                                >
                                    <img
                                        src={u.getAvatarURL(void 0, 64, true)}
                                        alt=""
                                        style={{ width: "28px", height: "28px", borderRadius: "50%" }}
                                    />
                                    <span style={{ fontWeight: "600", color: "var(--header-primary)" }}>{u.globalName ?? u.username}</span>
                                    <span style={{ fontSize: "11px", color: "var(--text-muted)", marginLeft: "auto" }}>{u.username}</span>
                                </div>
                            ))}
                        </div>
                    )}
                    {results.length === 0 && query.trim() && (
                        <Button
                            size={Button.Sizes.SMALL}
                            color={Button.Colors.PRIMARY}
                            onClick={fetchById}
                            disabled={fetching}
                            style={{ marginTop: "8px" }}
                        >
                            {fetching ? "Looking up…" : "Use this user ID"}
                        </Button>
                    )}
                </div>
            )}
            {mode === "incoming" ? (
                <div style={{ fontSize: "13px", color: "var(--text-muted)", lineHeight: 1.5, padding: "8px 0" }}>
                    Shows a full-screen incoming-call screen with <strong>{name ?? "this user"}</strong>'s avatar,
                    a pulsing ring, and accept / decline buttons. Accepting starts a fake call timer.
                    Purely visual — nothing is actually dialed.
                </div>
            ) : mode === "call" ? (
                <div>
                    <div style={{ fontSize: "12px", color: "var(--text-muted)", marginBottom: "6px" }}>
                        Call duration (mm:ss) — <strong>0:00</strong> = missed call
                    </div>
                    <TextInput
                        value={duration}
                        onChange={v => setDuration(v.replace(/[^\d:]/g, "").slice(0, 8))}
                        placeholder="5:00"
                    />
                    <div style={{ marginTop: "12px" }}>
                        <FormSwitch
                            value={missed}
                            onChange={setMissed}
                            note="The call was never answered — renders as a red missed-call entry"
                        >
                            Missed call
                        </FormSwitch>
                    </div>
                </div>
            ) : (
                <TextArea
                    value={content}
                    onChange={setContent}
                    placeholder="Message content… (markdown, mentions and emoji all work)"
                    rows={3}
                    maxLength={2000}
                />
            )}
            {mode !== "incoming" && (
                <div style={{ marginTop: "12px" }}>
                    <div style={{ fontSize: "12px", color: "var(--text-muted)", marginBottom: "6px" }}>
                        {mode === "call" ? "Call" : "Sent"} <strong>{minutesAgo || "0"}</strong> minute{Number(minutesAgo) === 1 ? "" : "s"} ago (0 = right now)
                    </div>
                    <TextInput
                        value={minutesAgo}
                        onChange={v => setMinutesAgo(v.replace(/\D/g, "").slice(0, 4))}
                        placeholder="Minutes ago"
                    />
                </div>
            )}
        </Modal>
    );
}

const UserContextMenu: NavContextMenuPatchCallback = (children, { user }: { user: User; }) => {
    if (!user) return;
    children.push(
        <Menu.MenuItem
            id="vc-fakemessage"
            label="Fake Message"
            action={() => openFakeMessageModal(user)}
        />
    );
};

const MessageContextMenu: NavContextMenuPatchCallback = (children, { message }: { message: Message; }) => {
    if (!(message as any)?._isFake) return;
    children.push(
        <Menu.MenuItem
            id="vc-fakemessage-remove"
            label={(message as any).call ? "Remove Fake Call" : "Remove Fake Message"}
            action={() => removeFake(message.id)}
        />
    );
};

// --- incoming call overlay ---------------------------------------------------
// A full-screen, purely visual incoming-call screen: the caller's avatar with
// an animated pulsing ring, their name, and accept / decline buttons. Accepting
// shows a live fake call timer until you hang up. Nothing is actually dialed.

const INCOMING_CALL_KEYFRAMES = `
    @keyframes vc-fakemessage-ring {
        0% { transform: scale(1); opacity: .65; }
        100% { transform: scale(1.9); opacity: 0; }
    }
    @keyframes vc-fakemessage-ring2 {
        0% { transform: scale(1); opacity: 0; }
        30% { transform: scale(1); opacity: .6; }
        100% { transform: scale(1.9); opacity: 0; }
    }
`;

function IncomingCallOverlay({ user, onClose }: { user: User; onClose: () => void }) {
    const [phase, setPhase] = React.useState<"ringing" | "connected">("ringing");
    const [seconds, setSeconds] = React.useState(0);

    React.useEffect(() => {
        if (phase !== "connected") return;
        const t = setInterval(() => setSeconds(s => s + 1), 1000);
        return () => clearInterval(t);
    }, [phase]);

    React.useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (e.key === "Escape") onClose();
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [onClose]);

    const name = user.globalName ?? user.username;
    const mm = String(Math.floor(seconds / 60)).padStart(2, "0");
    const ss = String(seconds % 60).padStart(2, "0");

    return (
        <div style={{
            position: "fixed", inset: 0, zIndex: 9999,
            display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
            gap: "20px",
            background: "radial-gradient(circle at 50% 30%, rgba(0,0,0,.72), rgba(0,0,0,.92))",
            backdropFilter: "blur(14px)",
            fontFamily: "var(--font-primary)"
        }}>
            <style>{INCOMING_CALL_KEYFRAMES}</style>

            {/* Pulsing ring around the avatar while ringing */}
            <div style={{ position: "relative", width: "180px", height: "180px" }}>
                {phase === "ringing" && (
                    <>
                        <div style={{
                            position: "absolute", inset: 0, borderRadius: "50%",
                            border: "4px solid var(--green-360)",
                            animation: "vc-fakemessage-ring 1.6s ease-out infinite"
                        }} />
                        <div style={{
                            position: "absolute", inset: 0, borderRadius: "50%",
                            border: "4px solid var(--green-360)",
                            animation: "vc-fakemessage-ring2 1.6s ease-out infinite",
                            animationDelay: ".5s"
                        }} />
                    </>
                )}
                <img
                    src={user.getAvatarURL(void 0, 256, true)}
                    alt=""
                    style={{
                        width: "150px", height: "150px", borderRadius: "50%",
                        display: "block", margin: "15px auto",
                        boxShadow: "0 8px 40px rgba(0,0,0,.6), 0 0 0 5px var(--background-tertiary)"
                    }}
                />
            </div>

            <div style={{ fontSize: "24px", fontWeight: "700", color: "var(--header-primary)", maxWidth: "80%", textAlign: "center" }}>
                {name}
            </div>
            <div style={{ fontSize: "16px", color: "var(--text-muted)", marginTop: "-10px" }}>
                {phase === "ringing" ? "Incoming call…" : `${mm}:${ss}`}
            </div>

            {phase === "ringing" ? (
                <div style={{ display: "flex", gap: "40px", marginTop: "16px" }}>
                    <button
                        aria-label="Accept call"
                        title="Accept"
                        onClick={() => setPhase("connected")}
                        style={{
                            width: "76px", height: "76px", borderRadius: "50%", cursor: "pointer",
                            background: "var(--green-360)", color: "#fff", border: "none",
                            display: "flex", alignItems: "center", justifyContent: "center",
                            boxShadow: "0 6px 20px rgba(59,165,92,.45)",
                            transition: "transform .12s ease, filter .12s ease"
                        }}
                        onMouseEnter={e => { e.currentTarget.style.transform = "scale(1.08)"; }}
                        onMouseLeave={e => { e.currentTarget.style.transform = "scale(1)"; }}
                    >
                        <svg width="32" height="32" viewBox="0 0 24 24" fill="currentColor">
                            <path d="M6.62 10.79a15.05 15.05 0 0 0 6.59 6.59l2.2-2.2a1 1 0 0 1 1.02-.24 11.36 11.36 0 0 0 3.57.57 1 1 0 0 1 1 1V20a1 1 0 0 1-1 1A17 17 0 0 1 3 4a1 1 0 0 1 1-1h3.5a1 1 0 0 1 1 1 11.36 11.36 0 0 0 .57 3.57 1 1 0 0 1-.25 1.02z" />
                        </svg>
                    </button>
                    <button
                        aria-label="Decline call"
                        title="Decline"
                        onClick={onClose}
                        style={{
                            width: "76px", height: "76px", borderRadius: "50%", cursor: "pointer",
                            background: "var(--red-400)", color: "#fff", border: "none",
                            display: "flex", alignItems: "center", justifyContent: "center",
                            boxShadow: "0 6px 20px rgba(237,66,69,.45)",
                            transition: "transform .12s ease, filter .12s ease"
                        }}
                        onMouseEnter={e => { e.currentTarget.style.transform = "scale(1.08)"; }}
                        onMouseLeave={e => { e.currentTarget.style.transform = "scale(1)"; }}
                    >
                        <svg width="32" height="32" viewBox="0 0 24 24" fill="currentColor" style={{ transform: "rotate(135deg)" }}>
                            <path d="M6.62 10.79a15.05 15.05 0 0 0 6.59 6.59l2.2-2.2a1 1 0 0 1 1.02-.24 11.36 11.36 0 0 0 3.57.57 1 1 0 0 1 1 1V20a1 1 0 0 1-1 1A17 17 0 0 1 3 4a1 1 0 0 1 1-1h3.5a1 1 0 0 1 1 1 11.36 11.36 0 0 0 .57 3.57 1 1 0 0 1-.25 1.02z" />
                        </svg>
                    </button>
                </div>
            ) : (
                <button
                    aria-label="End call"
                    title="Hang up"
                    onClick={onClose}
                    style={{
                        width: "76px", height: "76px", borderRadius: "50%", cursor: "pointer",
                        background: "var(--red-400)", color: "#fff", border: "none",
                        display: "flex", alignItems: "center", justifyContent: "center",
                        boxShadow: "0 6px 20px rgba(237,66,69,.45)", marginTop: "16px",
                        transition: "transform .12s ease"
                    }}
                    onMouseEnter={e => { e.currentTarget.style.transform = "scale(1.08)"; }}
                    onMouseLeave={e => { e.currentTarget.style.transform = "scale(1)"; }}
                >
                    <svg width="32" height="32" viewBox="0 0 24 24" fill="currentColor" style={{ transform: "rotate(135deg)" }}>
                        <path d="M6.62 10.79a15.05 15.05 0 0 0 6.59 6.59l2.2-2.2a1 1 0 0 1 1.02-.24 11.36 11.36 0 0 0 3.57.57 1 1 0 0 1 1 1V20a1 1 0 0 1-1 1A17 17 0 0 1 3 4a1 1 0 0 1 1-1h3.5a1 1 0 0 1 1 1 11.36 11.36 0 0 0 .57 3.57 1 1 0 0 1-.25 1.02z" />
                    </svg>
                </button>
            )}

            <div style={{ fontSize: "12px", color: "var(--text-muted)", marginTop: "8px" }}>
                Purely visual — no real call is being made
            </div>
        </div>
    );
}

/** Show the full-screen incoming-call overlay for a given caller. Purely visual. */
function showIncomingCall(user: User) {
    if (!user) {
        showToast("Could not find that user");
        return;
    }
    const mount = document.createElement("div");
    document.body.appendChild(mount);
    const root = createRoot(mount);
    const close = () => {
        root.unmount();
        mount.remove();
    };
    root.render(<IncomingCallOverlay user={user} onClose={close} />);
}

// --- plugin ------------------------------------------------------------------

export default definePlugin({
    name: "FakeMessage",
    description: "Creates fake messages from real users that look exactly like the real thing — client-side only, nobody else sees them",
    tags: ["Chat", "Fun"],
    authors: [{ name: "Elioflex", id: 0n }],
    dependencies: ["ChatInputButtonAPI"],
    settings,

    chatBarButton: {
        icon: FakeMessageIcon,
        render: ({ channel }) => {
            const { showChatButton } = settings.use(["showChatButton"]);
            if (!showChatButton) return null;
            return (
                <ChatBarButton tooltip="Fake Message" onClick={() => openFakeMessageModal(void 0, channel.id)}>
                    <FakeMessageIcon />
                </ChatBarButton>
            );
        }
    },

    // The plugin's own chatBarButton slot is taken by the ghost; the 📞 and 📲
    // buttons are registered at runtime in start().


    commands: [
        {
            inputType: ApplicationCommandInputType.BUILT_IN,
            name: "fakemessage",
            description: "Send a fake message in the current channel as if another user sent it (client-side only)",
            options: [
                {
                    name: "user",
                    description: "The user who appears to have sent the message",
                    type: ApplicationCommandOptionType.USER,
                    required: true
                },
                {
                    name: "content",
                    description: "The message content",
                    type: ApplicationCommandOptionType.STRING,
                    required: true
                },
                {
                    name: "minutes-ago",
                    description: "How many minutes ago this message was 'sent' (defaults to 0 = right now)",
                    type: ApplicationCommandOptionType.INTEGER
                }
            ],
            execute: async (opts, ctx) => {
                try {
                    const userId = findOption(opts, "user", "");
                    const content = findOption(opts, "content", "");
                    const minutesAgo = Math.max(0, Number(findOption(opts, "minutes-ago", 0)) || 0);

                    if (!userId) return sendBotMessage(ctx.channel.id, { content: "Pick a user." });
                    if (!content.trim()) return sendBotMessage(ctx.channel.id, { content: "Write some content." });

                    const user = UserStore.getUser(userId) ?? await UserUtils.getUser(userId);
                    if (!user) return sendBotMessage(ctx.channel.id, { content: "Could not find that user." });

                    injectFakeMessage(ctx.channel.id, user, content, minutesAgo);
                } catch (e) {
                    sendBotMessage(ctx.channel.id, { content: `Failed to create fake message: ${String(e)}` });
                }
            }
        },
        {
            inputType: ApplicationCommandInputType.BUILT_IN,
            name: "fakecall",
            description: "Add a fake call log entry in this DM — as if you and another user just talked on the phone (client-side only)",
            options: [
                {
                    name: "user",
                    description: "The other person in the call",
                    type: ApplicationCommandOptionType.USER,
                    required: true
                },
                {
                    name: "duration",
                    description: "Call duration as mm:ss or minutes (default 5:00). 0 or 'missed' = missed call",
                    type: ApplicationCommandOptionType.STRING
                },
                {
                    name: "missed",
                    description: "Mark as a missed call (never answered)",
                    type: ApplicationCommandOptionType.BOOLEAN
                },
                {
                    name: "minutes-ago",
                    description: "How many minutes ago the call happened (defaults to 0 = right now)",
                    type: ApplicationCommandOptionType.INTEGER
                }
            ],
            execute: async (opts, ctx) => {
                try {
                    const userId = findOption(opts, "user", "");
                    if (!userId) return sendBotMessage(ctx.channel.id, { content: "Pick a user." });

                    const user = UserStore.getUser(userId) ?? await UserUtils.getUser(userId);
                    if (!user) return sendBotMessage(ctx.channel.id, { content: "Could not find that user." });

                    const missed = Boolean(findOption(opts, "missed", false));
                    const durationRaw = String(findOption(opts, "duration", "5:00") ?? "5:00");
                    const duration = missed ? 0 : parseDuration(durationRaw);
                    const minutesAgo = Math.max(0, Number(findOption(opts, "minutes-ago", 0)) || 0);

                    injectFakeCall(ctx.channel.id, user, duration, minutesAgo, missed);
                } catch (e) {
                    sendBotMessage(ctx.channel.id, { content: `Failed to create fake call: ${String(e)}` });
                }
            }
        }
    ],

    contextMenus: {
        "user-context": UserContextMenu,
        "message": MessageContextMenu,
        "message-context": MessageContextMenu
    },

    start() {
        loadFakes();
        patchStore();
        // The plugin's own `chatBarButton` slot is the ghost message button;
        // the 📞 and 📲 buttons are added at runtime.
        addChatBarButton("FakeMessageCall", ({ channel }) => {
            const { showCallButton } = settings.use(["showCallButton"]);
            if (!showCallButton) return null;
            return (
                <ChatBarButton tooltip="Fake Call" onClick={() => openFakeMessageModal(void 0, channel.id, "call")}>
                    <CallIcon />
                </ChatBarButton>
            );
        }, CallIcon);
        addChatBarButton("FakeMessageIncoming", ({ channel }) => {
            const { showIncomingButton } = settings.use(["showIncomingButton"]);
            if (!showIncomingButton) return null;
            return (
                <ChatBarButton tooltip="Fake Incoming Call" onClick={() => openFakeMessageModal(void 0, channel.id, "incoming")}>
                    <IncomingCallIcon />
                </ChatBarButton>
            );
        }, IncomingCallIcon);
        console.log("[FakeMessage] Plugin started with", fakes.length, "stored fake message(s)");
    },

    stop() {
        removeChatBarButton("FakeMessageCall");
        removeChatBarButton("FakeMessageIncoming");
        unpatchStore();
        refresh();
        console.log("[FakeMessage] Plugin stopped");
    },

    // Exposed for programmatic use / testing
    injectFakeMessage,
    injectFakeCall,
    showIncomingCall,
    removeFake,
    removeFakesForChannel
});
