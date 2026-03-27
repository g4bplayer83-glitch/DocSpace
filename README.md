# DocSpace - Realtime Chat Platform (v3.2.0 Official)

DocSpace is a realtime web chat app built with Node.js, Express and Socket.IO.
It includes text channels, voice channels, DMs, mini-games, XP progression,
admin tools, file sharing, and a modern Discord-like UI.

## Version

- Official version: `3.2.0`
- Last update: `2026-03-27`

## Main Features

### Core Chat

- Realtime messaging with Socket.IO
- Multi-channel chat (general, jeux, musique, films, random, aide, ia...)
- Message reactions, replies, edits, deletes
- Link previews and media support
- Date separators, unread counters, and scroll-to-bottom helper

### Voice and Social

- Voice rooms with participant state sync
- DM conversations with typing indicator and attachments
- Friends system (requests, accept, remove)
- User status and custom status text
- User blocking / unblocking

### Progression and Economy

- XP and level system
- Daily login bonus and streaks
- Daily missions (messages, reactions, voice time)
- Banana shop with utility boosts
- Anti-abuse limits on utility purchases

### Mini-Games

- Tic-Tac-Toe
- Connect 4
- Rock-Paper-Scissors
- Quiz / Trivia
- Hangman
- Guess the Number
- Memory
- Arena 2D (multiplayer + solo bot)

### Admin and Moderation

- Admin panel with advanced actions
- Chat moderation tools
- Voice moderation tools (kick, mute, deafen, move)
- Broadcast and server control actions
- Automoderation options (spam, links, caps, blocked words)

## Mini-Game Ranking (v3.2.0)

DocSpace now includes a persistent mini-game leaderboard:

- Global points by player
- Wins / draws / losses / total matches
- Rewards after matches (points + XP)
- Dedicated leaderboard block in the ranking modal

## Project Structure

- `index.html`: Main frontend (UI + client logic)
- `server.js`: Backend server and realtime events
- `patchnotes.json`: In-app patch notes data
- `data/`: Persisted runtime data (history, XP, reminders, stats...)
- `uploads/`: Uploaded files

## Requirements

- Node.js 18+ (recommended: latest LTS)
- npm

## Installation

1. Install dependencies:

```bash
npm install
```

2. Start the server:

```bash
npm start
```

3. Open your browser:

```text
http://localhost:3000
```

## Development

Run directly with Node:

```bash
node server.js
```

## Data and Persistence

DocSpace saves runtime data in JSON files under `data/`.

If needed, you can set a custom persistent path with:

```bash
RENDER_DISK_PATH=/var/data
```

## Security Notes

- Keep admin credentials private
- Keep API keys outside public repositories
- Review file upload limits and allowed types before production deployment

## Roadmap Ideas

- Per-user mini-game profile page
- Better anti-cheat validations for client-driven mini-game events
- Match history viewer
- Optional seasonal ranking resets

## License

Private project / internal use unless specified otherwise.
