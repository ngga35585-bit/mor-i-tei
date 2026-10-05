# Discord YouTube Bot

Simple Discord music bot using the `>` prefix.

## Commands

>help
>join
>play <youtube url>
>pause
>resume
>skip
>stop
>queue
>now
>volume <0-200>
>loop
>leave

## Setup

Install dependencies:

npm install

Set the bot token:

DISCORD_TOKEN=YOUR_BOT_TOKEN

Start the bot:

npm start

## Discord permissions

The bot needs:

- View Channel
- Connect
- Speak

Message Content Intent must also be enabled in the Discord Developer Portal.

## Render

Deploy the repository as a Docker Background Worker.

Add:

DISCORD_TOKEN

The Dockerfile installs FFmpeg and yt-dlp automatically.

## Notes

This bot plays audio from YouTube in a Discord voice channel.

It does not implement Go Live or video streaming because those features are not provided to normal Discord bots through the official bot API.
