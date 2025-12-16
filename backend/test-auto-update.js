// Quick script to test auto-update for a specific playlist
const http = require('http');

// Find the velvet playlist and set its nextUpdate to trigger immediately
const fs = require('fs');
const playlistsFile = '.playlists.json';

try {
  const data = JSON.parse(fs.readFileSync(playlistsFile, 'utf8'));

  // Find velvet playlist
  for (const userId in data) {
    const playlists = data[userId];
    for (let i = 0; i < playlists.length; i++) {
      if (playlists[i].playlistName && playlists[i].playlistName.includes('Velvet')) {
        console.log(`Found playlist: ${playlists[i].playlistName}`);
        console.log(`Current songHistory length: ${playlists[i].songHistory?.length || 0}`);

        // Set nextUpdate to now to trigger immediate update
        playlists[i].nextUpdate = new Date().toISOString();
        console.log(`Set nextUpdate to: ${playlists[i].nextUpdate}`);

        // Set lastUpdated to more than 24 hours ago to bypass cooldown
        const moreThan24HoursAgo = new Date(Date.now() - (25 * 60 * 60 * 1000));
        playlists[i].lastUpdated = moreThan24HoursAgo.toISOString();
        console.log(`Set lastUpdated to: ${playlists[i].lastUpdated} (${25} hours ago)`);
      }
    }
  }

  // Save the modified data
  fs.writeFileSync(playlistsFile, JSON.stringify(data, null, 2));
  console.log('\nPlaylist updated! The auto-update scheduler should pick it up within the next minute.');
  console.log('Watch the backend logs for:');
  console.log('  - "[AUTO-UPDATE] Checking for playlists to update..."');
  console.log('  - "Skipping [track] (previously in playlist history)"');
  console.log('  - "Song history updated - now contains X tracks"');

} catch (error) {
  console.error('Error:', error.message);
}
