require("dotenv").config();

const {
    Client,
    GatewayIntentBits,
    PermissionsBitField
} = require("discord.js");

const {
    joinVoiceChannel,
    entersState,
    VoiceConnectionStatus,
    createAudioPlayer,
    createAudioResource,
    AudioPlayerStatus,
    StreamType
} = require("@discordjs/voice");

const { spawn } = require("child_process");
const { PassThrough } = require("stream");

const token = process.env.DISCORD_TOKEN;
const prefix = process.env.PREFIX || ">";

if (!token) {
    console.error("DISCORD_TOKEN is not set.");
    process.exit(1);
}

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ]
});

const servers = new Map();

function getServer(guildId) {
    if (!servers.has(guildId)) {
        const player = createAudioPlayer();

        const server = {
            player,
            connection: null,
            queue: [],
            current: null,
            ytProcess: null,
            ffmpegProcess: null,
            volume: 100,
            loop: false
        };

        player.on(AudioPlayerStatus.Idle, () => {
            cleanup(server);

            if (server.loop && server.current) {
                server.queue.unshift(server.current);
            }

            server.current = null;
            playNext(guildId);
        });

        player.on("error", error => {
            console.error("Audio player error:", error);

            cleanup(server);
            server.current = null;

            playNext(guildId);
        });

        servers.set(guildId, server);
    }

    return servers.get(guildId);
}

function cleanup(server) {
    if (server.ytProcess && !server.ytProcess.killed) {
        try {
            server.ytProcess.kill("SIGKILL");
        } catch {}
    }

    if (server.ffmpegProcess && !server.ffmpegProcess.killed) {
        try {
            server.ffmpegProcess.kill("SIGKILL");
        } catch {}
    }

    server.ytProcess = null;
    server.ffmpegProcess = null;
}

function isYouTubeUrl(value) {
    try {
        const url = new URL(value);

        return [
            "youtube.com",
            "www.youtube.com",
            "m.youtube.com",
            "youtu.be"
        ].includes(url.hostname);
    } catch {
        return false;
    }
}

function getVideoInfo(url) {
    return new Promise((resolve, reject) => {
        const process = spawn("yt-dlp", [
            "--dump-single-json",
            "--no-playlist",
            "--skip-download",
            "--no-warnings",
            url
        ]);

        let stdout = "";
        let stderr = "";

        process.stdout.on("data", data => {
            stdout += data.toString();
        });

        process.stderr.on("data", data => {
            stderr += data.toString();
        });

        process.on("error", reject);

        process.on("close", code => {
            if (code !== 0) {
                reject(new Error(stderr || "yt-dlp failed."));
                return;
            }

            try {
                resolve(JSON.parse(stdout));
            } catch {
                reject(new Error("Could not read video information."));
            }
        });
    });
}

function createStream(url, server) {
    const output = new PassThrough();

    const yt = spawn("yt-dlp", [
        "--no-playlist",
        "--quiet",
        "--no-warnings",
        "-f",
        "bestaudio/best",
        "-o",
        "-",
        url
    ]);

    const ffmpeg = spawn("ffmpeg", [
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        "pipe:0",
        "-vn",
        "-ac",
        "2",
        "-ar",
        "48000",
        "-f",
        "s16le",
        "pipe:1"
    ]);

    server.ytProcess = yt;
    server.ffmpegProcess = ffmpeg;

    yt.stdout.pipe(ffmpeg.stdin);
    ffmpeg.stdout.pipe(output);

    yt.on("error", error => {
        console.error("yt-dlp error:", error);
        output.destroy(error);
    });

    ffmpeg.on("error", error => {
        console.error("ffmpeg error:", error);
        output.destroy(error);
    });

    return output;
}

async function playTrack(guildId, track) {
    const server = getServer(guildId);

    server.current = track;

    const stream = createStream(track.url, server);

    const resource = createAudioResource(stream, {
        inputType: StreamType.Raw,
        inlineVolume: true
    });

    resource.volume.setVolume(server.volume / 100);

    server.player.play(resource);
}

async function playNext(guildId) {
    const server = getServer(guildId);

    if (!server.connection || server.queue.length === 0) {
        return;
    }

    const track = server.queue.shift();

    try {
        await playTrack(guildId, track);
    } catch (error) {
        console.error(error);
        await playNext(guildId);
    }
}

async function connectToVoice(message) {
    const channel = message.member?.voice?.channel;

    if (!channel) {
        throw new Error("You need to be in a voice channel.");
    }

    const permissions = channel.permissionsFor(message.client.user);

    if (
        !permissions?.has(PermissionsBitField.Flags.Connect) ||
        !permissions?.has(PermissionsBitField.Flags.Speak)
    ) {
        throw new Error("The bot needs Connect and Speak permissions.");
    }

    const server = getServer(message.guild.id);

    if (
        !server.connection ||
        server.connection.joinConfig.channelId !== channel.id
    ) {
        if (server.connection) {
            try {
                server.connection.destroy();
            } catch {}
        }

        server.connection = joinVoiceChannel({
            channelId: channel.id,
            guildId: message.guild.id,
            adapterCreator: message.guild.voiceAdapterCreator,
            selfDeaf: true
        });

        server.connection.subscribe(server.player);

        await entersState(
            server.connection,
            VoiceConnectionStatus.Ready,
            30000
        );
    }

    return server;
}

function formatDuration(seconds) {
    if (!seconds) {
        return "unknown";
    }

    seconds = Math.floor(seconds);

    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const remaining = seconds % 60;

    if (hours > 0) {
        return `${hours}:${String(minutes).padStart(2, "0")}:${String(remaining).padStart(2, "0")}`;
    }

    return `${minutes}:${String(remaining).padStart(2, "0")}`;
}

client.on("messageCreate", async message => {
    if (message.author.bot) return;
    if (!message.guild) return;
    if (!message.content.startsWith(prefix)) return;

    const input = message.content.slice(prefix.length).trim();

    if (!input) return;

    const parts = input.split(/\s+/);
    const command = parts.shift().toLowerCase();
    const args = parts;

    try {
        const server = getServer(message.guild.id);

        if (command === "help") {
            return message.reply(
                [
                    `${prefix}join`,
                    `${prefix}play <youtube url>`,
                    `${prefix}pause`,
                    `${prefix}resume`,
                    `${prefix}skip`,
                    `${prefix}stop`,
                    `${prefix}queue`,
                    `${prefix}now`,
                    `${prefix}volume <0-200>`,
                    `${prefix}loop`,
                    `${prefix}leave`
                ].join("\n")
            );
        }

        if (command === "join") {
            await connectToVoice(message);
            return message.reply("Joined the voice channel.");
        }

        if (command === "play" || command === "p") {
            const url = args[0];

            if (!url) {
                return message.reply(
                    `Usage: ${prefix}play https://youtu.be/...`
                );
            }

            if (!isYouTubeUrl(url)) {
                return message.reply("Only YouTube URLs are supported.");
            }

            await connectToVoice(message);

            const info = await getVideoInfo(url);

            const track = {
                url,
                title: info.title || "Unknown",
                duration: Number(info.duration || 0),
                requestedBy: message.author.tag
            };

            server.queue.push(track);

            if (!server.current) {
                await playNext(message.guild.id);

                return message.reply(
                    `Playing: ${track.title}\nDuration: ${formatDuration(track.duration)}`
                );
            }

            return message.reply(
                `Added to queue: ${track.title}\nPosition: ${server.queue.length}`
            );
        }

        if (command === "pause") {
            if (!server.player.pause()) {
                return message.reply("Nothing is currently playing.");
            }

            return message.reply("Paused.");
        }

        if (command === "resume") {
            if (!server.player.unpause()) {
                return message.reply("Nothing is paused.");
            }

            return message.reply("Resumed.");
        }

        if (command === "skip" || command === "next") {
            if (!server.current) {
                return message.reply("Nothing is currently playing.");
            }

            cleanup(server);
            server.player.stop(true);

            return message.reply("Skipped.");
        }

        if (command === "stop") {
            server.queue = [];
            server.current = null;
            server.loop = false;

            cleanup(server);
            server.player.stop(true);

            return message.reply("Playback stopped.");
        }

        if (command === "queue" || command === "q") {
            if (!server.current && server.queue.length === 0) {
                return message.reply("The queue is empty.");
            }

            let output = "";

            if (server.current) {
                output += `Now playing: ${server.current.title}\n\n`;
            }

            server.queue.slice(0, 10).forEach((track, index) => {
                output += `${index + 1}. ${track.title} (${formatDuration(track.duration)})\n`;
            });

            return message.reply(output);
        }

        if (command === "now") {
            if (!server.current) {
                return message.reply("Nothing is currently playing.");
            }

            return message.reply(
                `Now playing: ${server.current.title}\n` +
                `Duration: ${formatDuration(server.current.duration)}\n` +
                `Requested by: ${server.current.requestedBy}`
            );
        }

        if (command === "volume" || command === "vol") {
            const value = Number(args[0]);

            if (!Number.isFinite(value) || value < 0 || value > 200) {
                return message.reply("Volume must be between 0 and 200.");
            }

            server.volume = value;

            return message.reply(`Volume set to ${value}%.`);
        }

        if (command === "loop") {
            server.loop = !server.loop;

            return message.reply(
                `Loop ${server.loop ? "enabled" : "disabled"}.`
            );
        }

        if (command === "leave") {
            server.queue = [];
            server.current = null;
            server.loop = false;

            cleanup(server);
            server.player.stop(true);

            if (server.connection) {
                server.connection.destroy();
                server.connection = null;
            }

            return message.reply("Left the voice channel.");
        }
    } catch (error) {
        console.error(error);

        return message.reply(
            error.message || "An error occurred."
        );
    }
});

client.once("ready", () => {
    console.log(`Logged in as ${client.user.tag}`);
    console.log(`Prefix: ${prefix}`);
});

process.on("SIGTERM", () => {
    for (const server of servers.values()) {
        cleanup(server);

        try {
            server.connection?.destroy();
        } catch {}
    }

    client.destroy();
    process.exit(0);
});

client.login(token);
