# 🎵 AI Playlist Creator

An intelligent playlist generation app that uses AI (Claude) to create personalized playlists on Spotify and Apple Music based on natural language prompts.

## Features

- 🤖 **AI-Powered Generation**: Uses Claude AI to understand your music preferences and create tailored playlists
- 🎯 **Natural Language Prompts**: Describe playlists in plain English (e.g., "early 2000's pop music", "workout rap at the gym")
- 🚫 **No Duplicates**: Automatically removes duplicate songs from playlists
- 🎨 **Beautiful UI**: Clean, modern interface with gradient backgrounds and smooth animations
- 🔗 **Spotify Integration**: Seamlessly connects with your Spotify account
- 📱 **Responsive Design**: Works on desktop, tablet, and mobile devices

## Tech Stack

### Backend
- Node.js + Express
- Anthropic Claude API (for AI playlist generation)
- Spotify Web API
- Axios for HTTP requests

### Frontend
- React 18
- Axios for API calls
- CSS3 with modern styling

## Prerequisites

Before you begin, ensure you have:

1. **Node.js** (v16 or higher) installed - [Download Node.js](https://nodejs.org/)
2. **Spotify Developer Account** - [Sign up here](https://developer.spotify.com/dashboard)
3. **Anthropic API Key** - [Get your key here](https://console.anthropic.com/)
4. **VS Code** (recommended) - [Download VS Code](https://code.visualstudio.com/)

## Setup Instructions

### Step 1: Clone or Download the Project

```bash
# If you have the project folder, navigate to it
cd ai-playlist-creator
```

### Step 2: Set Up Spotify Developer App

1. Go to [Spotify Developer Dashboard](https://developer.spotify.com/dashboard)
2. Click "Create an App"
3. Fill in the details:
   - **App Name**: AI Playlist Creator
   - **App Description**: AI-powered playlist generator
4. After creating, note your **Client ID** and **Client Secret**
5. Click "Edit Settings"
6. Add Redirect URI: `http://localhost:3001/callback`
7. Save changes

### Step 3: Configure Backend

1. Navigate to the backend folder:
```bash
cd backend
```

2. Install dependencies:
```bash
npm install
```

3. Create `.env` file:
```bash
cp .env.example .env
```

4. Edit `.env` and add your credentials:
```env
SPOTIFY_CLIENT_ID=your_spotify_client_id_here
SPOTIFY_CLIENT_SECRET=your_spotify_client_secret_here
SPOTIFY_REDIRECT_URI=http://localhost:3001/callback

ANTHROPIC_API_KEY=your_anthropic_api_key_here

PORT=3001
FRONTEND_URL=http://localhost:3000
```

### Step 4: Configure Frontend

1. Open a new terminal and navigate to frontend folder:
```bash
cd frontend
```

2. Install dependencies:
```bash
npm install
```

3. Create `.env` file:
```bash
cp .env.example .env
```

4. The default configuration should work:
```env
REACT_APP_API_URL=http://localhost:3001
```

### Step 5: Run the Application

1. **Start the Backend** (in the backend folder):
```bash
npm run dev
```
You should see: `🎵 AI Playlist Creator Backend running on port 3001`

2. **Start the Frontend** (in a new terminal, in the frontend folder):
```bash
npm start
```
The app should automatically open at `http://localhost:3000`

## Usage Guide

### Creating Your First Playlist

1. **Connect to Spotify**
   - Click "Connect with Spotify" button
   - Authorize the application
   - You'll be redirected back to the app

2. **Describe Your Playlist**
   - Type a natural language description (e.g., "Early 2000's pop music")
   - Or click one of the example prompts
   - Click "Generate Playlist"

3. **Review Generated Playlist**
   - AI will analyze your prompt and find matching songs
   - Review the generated playlist with album artwork
   - All songs are unique (no duplicates)

4. **Create on Spotify**
   - Click "Create Playlist on Spotify"
   - The playlist will be added to your Spotify account
   - Click to open it in Spotify

### Example Prompts

Try these prompts to get started:

- "Early 2000's pop music"
- "Workout rap music at the gym"
- "Music similar to Taylor Swift and Joji"
- "Chill indie vibes for studying"
- "90s R&B slow jams"
- "Electronic dance music for parties"
- "Acoustic covers of popular songs"
- "Road trip sing-along hits"
- "Relaxing jazz for working"
- "Energetic K-pop bangers"

## How It Works

1. **User Input**: You describe the type of playlist you want in natural language

2. **AI Analysis**: Claude AI analyzes your prompt and generates:
   - A creative playlist name
   - A playlist description
   - Multiple search queries to find relevant songs

3. **Song Discovery**: The backend searches Spotify using AI-generated queries

4. **Duplicate Removal**: Tracks are deduplicated by ID to ensure uniqueness

5. **AI Curation**: Claude selects the best 25-30 songs that match your theme

6. **Playlist Creation**: The final playlist is created on your Spotify account

## Project Structure

```
ai-playlist-creator/
├── backend/
│   ├── server.js           # Main Express server
│   ├── package.json        # Backend dependencies
│   ├── .env.example        # Environment variables template
│   └── .env                # Your actual credentials (not in git)
├── frontend/
│   ├── public/
│   │   └── index.html      # HTML template
│   ├── src/
│   │   ├── components/
│   │   │   └── PlaylistGenerator.js  # Main UI component
│   │   ├── services/
│   │   │   └── api.js      # API service layer
│   │   ├── styles/
│   │   │   ├── App.css     # Global styles
│   │   │   └── PlaylistGenerator.css  # Component styles
│   │   ├── App.js          # Main App component
│   │   └── index.js        # React entry point
│   ├── package.json        # Frontend dependencies
│   └── .env.example        # Environment variables template
└── README.md               # This file
```

## Troubleshooting

### "User not authenticated" error
- Make sure you've connected your Spotify account
- Try refreshing the page
- Clear localStorage and reconnect

### "Failed to generate playlist"
- Check that your Anthropic API key is valid
- Ensure you have credits in your Anthropic account
- Check backend logs for detailed errors

### Spotify login not working
- Verify your Redirect URI in Spotify Dashboard matches exactly: `http://localhost:3001/callback`
- Make sure both frontend and backend are running
- Check that your Client ID and Secret are correct

### Backend won't start
- Ensure port 3001 is not in use
- Run `npm install` in the backend folder
- Check that all environment variables are set in `.env`

### Frontend won't start
- Ensure port 3000 is not in use
- Run `npm install` in the frontend folder
- Clear npm cache: `npm cache clean --force`

## Future Enhancements

- [ ] Apple Music integration
- [ ] Save multiple playlists
- [ ] Playlist history
- [ ] Share playlists with friends
- [ ] Custom playlist length
- [ ] Genre mixing controls
- [ ] Mood-based generation
- [ ] Collaborative playlists

## API Rate Limits

- **Spotify API**: Be mindful of rate limits (429 errors)
- **Anthropic API**: Check your usage limits
- The app includes small delays between requests to avoid rate limiting

## Security Notes

- Never commit your `.env` files to version control
- Keep your API keys secure
- Use environment variables for all sensitive data
- In production, implement proper user session management

## Contributing

Feel free to fork this project and submit pull requests for improvements!

## License

This project is for educational purposes. Make sure to comply with Spotify's and Anthropic's terms of service.

## Support

For issues or questions:
1. Check the Troubleshooting section above
2. Review backend logs in the terminal
3. Check browser console for frontend errors

## Credits

- Built with [Claude AI](https://anthropic.com)
- Music data from [Spotify Web API](https://developer.spotify.com/)
- Icons and UI inspired by modern music apps

---

Made with ❤️ and AI
