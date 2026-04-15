# SystemBot By OnlyGg

A complete Discord bot with dashboard support, moderation, leveling, and AI features.

## Features

- 🎛️ **Dashboard Control** - Manage bot settings from web interface
- 🔧 **Global Settings** - Bot status and prefix apply to all servers
- ⚡ **Real-time Updates** - Settings apply instantly without restart
- 🛡️ **Moderation** - Ban, kick, mute, warn, and more
- 📊 **Leveling System** - XP and levels for users
- 🤖 **AI Integration** - Smart responses and conversations
- 🔒 **Security** - Anti-spam and protection systems
- 📝 **Logging** - Detailed action logs

## Quick Start

1. **Install Dependencies**
   ```bash
   npm install
   ```

2. **Configure Bot**
   - Copy `.env.example` to `.env`
   - Add your Discord bot token
   - Configure optional settings

3. **Run the Bot**
   ```bash
   node bot-core.js
   ```

## Configuration

### Environment Variables
- `TOKEN` - Your Discord bot token (required)
- `PREFIX` - Default command prefix (default: `!`)
- `MONGODB_URI` - MongoDB connection string (optional)

### Global Settings
Bot status and prefix are managed globally through the dashboard and apply to all servers automatically.

## Dashboard

Access the web dashboard to manage:
- Bot status and activity
- Command prefixes
- Moderation settings
- Welcome messages
- Security configurations
- And much more...

## File Structure

```
SystemBot/
├── bot-core.js          # Main bot file
├── config.json          # Server configurations
├── data.json            # User data (levels, warnings, etc.)
├── dashboard-schema.json # Dashboard structure
├── package.json         # Dependencies
├── .env.example        # Environment variables template
└── README.md           # This file
```

## Commands

The bot supports a wide range of commands for:
- Moderation (ban, kick, mute, warn, etc.)
- Utility (help, userinfo, serverinfo)
- Level system
- AI conversations
- And more...

## Deployment

This bot is designed to be deployed as:
- Standalone application
- Docker container
- PM2 managed process
- Or any Node.js hosting service

## Support

For issues and support, please check the documentation or create an issue in the repository.

---

**Made with ❤️ for Discord communities**
